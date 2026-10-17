import {
  and,
  asc,
  desc,
  eq,
  gt,
  gte,
  inArray,
  isNull,
  lt,
  lte,
  ne,
  or,
  sql,
} from "drizzle-orm";
import { v4 as uuid } from "uuid";

import {
  CALL_SITE_COMPACTION_AGENT,
  CALL_SITE_SYNTHETIC_AGENT_ERROR_MESSAGE,
} from "../api/constants/call-sites.js";
import { getConfigReadOnly } from "../config/loader.js";
import type { LLMCallSite } from "../config/schemas/llm.js";
import { AssistantError, ProviderError } from "../util/errors.js";
import {
  getAssistantMessageIdsInTurn,
  getMessageById,
  getTurnTimeBounds,
  messageMetadataSchema,
} from "./conversation-crud.js";
import { requireMainDb } from "./db-facade.js";
import { getClickHouseLlmRequestLogSink } from "./llm-request-log-sink-clickhouse.js";
import type {
  LlmRequestLogWriter,
  LlmRequestLogWriteRow,
} from "./llm-request-log-writer-types.js";
import { existingMessageIds } from "./message-reads.js";

/**
 * The logs connection: `llm_request_logs` lives in the shared database, so
 * every read and write goes through the main facade. Throws when the database
 * is unavailable — the store has no fallback, and a missing database is a
 * genuine failure for these call sites. Callers that must not fail on this
 * already wrap in try/catch.
 */
function logsDb() {
  return requireMainDb();
}

/**
 * Whether LLM request logging is enabled (`llmRequestLogs.enabled`, default
 * `true`). Gates every `llm_request_logs` insert so no prompt/completion
 * payload is written while logging is off. Read-only config access (no
 * `ensureDataDir`/disk write) because this sits on the per-LLM-call critical
 * path; defaults to "enabled" if config resolution throws so a config hiccup
 * never silently drops logs.
 */
export function llmRequestLoggingEnabled(): boolean {
  try {
    return getConfigReadOnly().llmRequestLogs?.enabled !== false;
  } catch {
    return true;
  }
}

export type LogRow = {
  id: string;
  conversationId: string;
  messageId: string | null;
  provider: string | null;
  requestPayload: string;
  responsePayload: string;
  createdAt: number;
  /**
   * Set on the final log row of an `AgentLoop.run` once the loop body
   * exits. NULL on intermediate rows — that's the canonical "loop kept
   * going" signal. Values are the stable strings from
   * `AgentLoopExitReason` in `agent/loop.ts`.
   */
  agentLoopExitReason: string | null;
  /**
   * Logical call site that produced this row — `mainAgent`,
   * `compactionAgent`, etc. NULL on pre-migration-264 rows (no backfill).
   * In practice values come from `LLMCallSite` (`config/schemas/llm.ts`).
   */
  callSite: string | null;
  /**
   * JSON-serialized {@link LatencyBreakdown} — the daemon-measured
   * first-token latency waterfall for this main-agent call. NULL on
   * pre-instrumentation rows, failed calls, and non-main-agent call sites.
   */
  latencyBreakdown: string | null;
};

/**
 * `LogRow` without the heavy payload columns — for reads that only need
 * metadata (conversation scoping, `createdAt` anchoring). `latencyBreakdown`
 * is likewise excluded: it's per-call detail the metadata/compaction-trail
 * consumers don't surface.
 */
export type LogMetaRow = Omit<
  LogRow,
  "requestPayload" | "responsePayload" | "latencyBreakdown"
>;

/**
 * Compaction-trail row: metadata plus the (small) summarizer response
 * payload and a message count computed in SQL. The request payload — an
 * entire near-limit context window per compaction — is deliberately never
 * loaded; the trail only needs the count of messages it contained.
 */
export type CompactionAgentLogRow = LogMetaRow & {
  responsePayload: string;
  requestMessageCount: number | null;
};

/**
 * Build the structured response-payload object recorded in
 * `llm_request_logs.responsePayload` for a provider-rejected LLM call.
 *
 * Mirrors the shape of a successful `usage.rawResponse` row by placing
 * the error under a top-level `error` key, so an inspector consumer can
 * branch on `row.responsePayload.error` vs the success shape without
 * parsing twice. Extracts queryable fields from `ProviderError`
 * (provider tag, status code, retry-after) and `AssistantError`
 * (structured `ErrorCode`) when present so the row isn't opaque text.
 * Other `Error` shapes degrade gracefully to `{name, message}`.
 *
 * Returns the structured object rather than a JSON string so callers
 * can either stringify it directly (daemon-path `recordRequestLog`) or
 * store it on a pending-log queue that stringifies later (wake-path
 * `PendingLog.rawResponse`), without double-encoding.
 *
 * When the provider captured the verbatim upstream body, it is attached as a
 * top-level `rawResponse` sibling so the inspector's Raw tab can show the
 * actual provider payload (parsed JSON, or the raw string for non-JSON error
 * pages) — matching the success path, where Raw shows the real provider JSON.
 */
export function buildProviderErrorResponsePayload(err: Error): {
  error: Record<string, unknown>;
  rawResponse?: unknown;
} {
  const payload: Record<string, unknown> = {
    name: err.name,
    message: err.message,
  };
  let rawResponse: unknown;
  if (err instanceof ProviderError) {
    payload.code = err.code;
    payload.provider = err.provider;
    if (err.statusCode !== undefined) {
      payload.statusCode = err.statusCode;
    }
    if (err.retryAfterMs !== undefined) {
      payload.retryAfterMs = err.retryAfterMs;
    }
    if (err.apiErrorCode !== undefined) {
      payload.apiErrorCode = err.apiErrorCode;
    }
    if (err.apiErrorType !== undefined) {
      payload.apiErrorType = err.apiErrorType;
    }
    if (err.apiErrorParam !== undefined) {
      payload.apiErrorParam = err.apiErrorParam;
    }
    if (err.requestId !== undefined) {
      payload.requestId = err.requestId;
    }
    if (err.rawBody !== undefined) {
      rawResponse = parseRawBody(err.rawBody);
    }
  } else if (err instanceof AssistantError) {
    payload.code = err.code;
  }
  return rawResponse !== undefined
    ? { error: payload, rawResponse }
    : { error: payload };
}

/** Parse a captured upstream body as JSON, falling back to the raw string for
 *  non-JSON error pages (HTML, plain text) or a truncated/invalid prefix. */
function parseRawBody(rawBody: string): unknown {
  try {
    return JSON.parse(rawBody);
  } catch {
    return rawBody;
  }
}

/**
 * The local SQLite write backend for `llm_request_logs` — the
 * `LlmRequestLogWriter` implementation behind the default
 * `readSource: "local"` config. Holds the actual SQL for the insert and
 * every post-hoc mutation; the exported store functions dispatch here (or
 * to the ClickHouse sink) via {@link resolveLlmRequestLogWriter}.
 */
class LocalLlmRequestLogWriter implements LlmRequestLogWriter {
  async insertRequestLog(row: LlmRequestLogWriteRow): Promise<void> {
    const db = logsDb();
    const logs = db.schema.llmRequestLogs;
    // Insert the full request/response payloads (an entire context window for
    // main-agent calls) into the append-only table on the per-LLM-call path.
    await db.orm.insert(logs).values({
      id: row.id,
      conversationId: row.conversationId,
      messageId: row.messageId,
      provider: row.provider,
      requestPayload: row.requestPayload,
      responsePayload: row.responsePayload,
      createdAt: row.createdAt,
      agentLoopExitReason: row.agentLoopExitReason,
      callSite: row.callSite,
      latencyBreakdown: row.latencyBreakdown ?? null,
    });
  }

  async setAgentLoopExitReasonOnLatestLog(
    conversationId: string,
    reason: string,
  ): Promise<void> {
    const db = logsDb();
    const logs = db.schema.llmRequestLogs;
    const [latest] = await db.orm
      .select({ id: logs.id })
      .from(logs)
      .where(
        and(
          eq(logs.conversationId, conversationId),
          isNull(logs.agentLoopExitReason),
        ),
      )
      .orderBy(desc(logs.createdAt))
      .limit(1);
    if (!latest) {
      return;
    }
    await db.orm
      .update(logs)
      .set({ agentLoopExitReason: reason })
      .where(eq(logs.id, latest.id));
  }

  async backfillMessageIdOnLogs(
    conversationId: string,
    messageId: string,
  ): Promise<void> {
    const db = logsDb();
    const logs = db.schema.llmRequestLogs;
    await db.orm
      .update(logs)
      .set({ messageId })
      .where(
        and(eq(logs.conversationId, conversationId), isNull(logs.messageId)),
      );
  }

  async relinkLlmRequestLogs(
    fromMessageIds: string[],
    toMessageId: string,
  ): Promise<void> {
    const db = logsDb();
    const logs = db.schema.llmRequestLogs;
    await db.orm
      .update(logs)
      .set({ messageId: toMessageId })
      .where(inArray(logs.messageId, fromMessageIds));
  }

  async backfillMessageIdOnRecoveredLogs(
    logIds: string[],
    messageId: string,
  ): Promise<void> {
    const db = logsDb();
    const logs = db.schema.llmRequestLogs;
    // Guard with isNull so this recovery path never overwrites a messageId
    // already set by an authoritative caller (e.g. watch-notifier).
    await db.orm
      .update(logs)
      .set({ messageId })
      .where(and(inArray(logs.id, logIds), isNull(logs.messageId)));
  }
}

const LOCAL_LLM_REQUEST_LOG_WRITER = new LocalLlmRequestLogWriter();

/**
 * Resolve the write backend that currently owns `llm_request_logs` writes:
 * the ClickHouse sink when `llmRequestLogs.readSource === "clickhouse"`,
 * local SQLite otherwise. Every writer of the table — inserts AND the
 * post-hoc mutators — dispatches through this, so a backend that can't
 * support an operation expresses that as a method no-op rather than the
 * store branching per backend. Resolved fresh per call so config edits take
 * effect without a restart (same contract as the read-source factory); a
 * future third-party backend implements `LlmRequestLogWriter` and slots in
 * here.
 */
function resolveLlmRequestLogWriter(): LlmRequestLogWriter {
  return getClickHouseLlmRequestLogSink() ?? LOCAL_LLM_REQUEST_LOG_WRITER;
}

export async function recordRequestLog(
  conversationId: string,
  requestPayload: string,
  responsePayload: string,
  messageId?: string,
  provider?: string,
  callSite?: LLMCallSite,
  latencyBreakdown?: string,
): Promise<string | null> {
  // Master opt-out: when logging is disabled, skip the write entirely so no
  // prompt/completion payload lands on disk. Returns null — there is no row to
  // stamp/backfill later, and no production caller consumes the return value.
  if (!llmRequestLoggingEnabled()) {
    return null;
  }
  const id = uuid();
  await resolveLlmRequestLogWriter().insertRequestLog({
    id,
    conversationId,
    messageId: messageId ?? null,
    provider: provider ?? null,
    requestPayload,
    responsePayload,
    createdAt: Date.now(),
    // Stamped later via setAgentLoopExitReasonOnLatestLog, once the agent
    // loop body actually exits. Intermediate rows stay NULL. (INSERT-only
    // backends never stamp — their rows keep the insert-time value.)
    agentLoopExitReason: null,
    // Logical call site (`mainAgent`, `compactionAgent`, …). NULL when a
    // caller hasn't been updated yet — preserves backward compat while we
    // plumb call sites through one site at a time.
    callSite: callSite ?? null,
    // JSON first-token latency waterfall, supplied by `handleUsage` for
    // instrumented calls. NULL for failed/non-instrumented call paths.
    latencyBreakdown: latencyBreakdown ?? null,
  });
  return id;
}

/**
 * Insert a synthetic `llm_request_logs` row for an agent-loop error
 * message that has no LLM call backing it but should appear in the
 * inspector rail. Today the only caller is the
 * `budget_yield_unrecovered` persistence path
 * (`conversation-agent-loop.ts`); the helper is named generically so
 * the next out-of-funds / provider-error / etc. path can route through
 * the same primitive.
 *
 * The caller persists the user-visible assistant message separately
 * via the `persistence` pipeline; this helper only writes the synthetic
 * call row. `messageId` should be the id of the just-persisted notice
 * so `getRequestLogsByMessageId` surfaces both together.
 *
 * Payload semantics mirror real LLM-call rows:
 *  - `requestPayload`: the best-known LLM request body the loop was
 *    about to send when it yielded — typically the prepared messages
 *    snapshot and any input-token budget context. Stored as JSON so
 *    the Raw tab renders it consistently with real calls.
 *  - `responsePayload`: the synthetic notice text the user saw plus
 *    the exit reason. This is the "response" from the user's point of
 *    view — what came back from a call that never actually happened.
 *
 * Stamps `agent_loop_exit_reason` directly so the row already carries
 * the reason at insert time — the post-loop
 * `setAgentLoopExitReasonOnLatestLog` query then skips it (its IS NULL
 * guard) and stamps the prior real LLM call instead, preserving the
 * existing "latest LLM call carries the exit reason" invariant that
 * other consumers depend on.
 */
export async function recordSyntheticAgentErrorMessageLog(args: {
  conversationId: string;
  messageId: string;
  exitReason: string;
  /** User-visible notice text — goes into `response_payload`. */
  noticeText: string;
  /**
   * Best-known LLM request state at the moment the loop gave up.
   * `null` when no prepared request was available (rare — generally
   * we know at least the conversation history we were about to send).
   */
  preparedRequest: unknown | null;
  createdAt: number;
}): Promise<string | null> {
  // Synthetic error rows are `llm_request_logs` rows too — honour the same
  // master opt-out so nothing is written while logging is disabled.
  if (!llmRequestLoggingEnabled()) {
    return null;
  }
  const id = uuid();
  const requestPayload = JSON.stringify({
    syntheticAgentErrorMessage: {
      exitReason: args.exitReason,
      preparedRequest: args.preparedRequest,
    },
  });
  const responsePayload = JSON.stringify({
    syntheticAgentErrorMessage: {
      exitReason: args.exitReason,
      noticeText: args.noticeText,
    },
  });
  // The exit reason is already known here, so it is carried on the row at
  // insert time — which also makes synthetic rows complete on INSERT-only
  // backends that can never stamp it afterwards.
  await resolveLlmRequestLogWriter().insertRequestLog({
    id,
    conversationId: args.conversationId,
    messageId: args.messageId,
    provider: null,
    requestPayload,
    responsePayload,
    createdAt: args.createdAt,
    agentLoopExitReason: args.exitReason,
    callSite: CALL_SITE_SYNTHETIC_AGENT_ERROR_MESSAGE,
    latencyBreakdown: null,
  });
  return id;
}

/**
 * Stamp an `agent_loop_exit_reason` onto the most-recent unstamped
 * `llm_request_logs` row for the given conversation. Called by the
 * agent-loop event dispatch (both `dispatchAgentEvent` and the wake's
 * `onEvent`) when an `agent_loop_exit` event is observed.
 *
 * The `IS NULL` guard prevents a current run from clobbering a previous
 * run's exit reason when the current run exits before landing any log
 * row of its own (reachable via `aborted_pre_call`, `aborted_via_error`
 * during pre-call setup, or `error` when system-prompt/tool resolution
 * throws). In those cases the latest row belongs to a prior run and is
 * already stamped — leave it alone.
 */
export async function setAgentLoopExitReasonOnLatestLog(
  conversationId: string,
  reason: string,
): Promise<void> {
  await resolveLlmRequestLogWriter().setAgentLoopExitReasonOnLatestLog(
    conversationId,
    reason,
  );
}

export async function backfillMessageIdOnLogs(
  conversationId: string,
  messageId: string,
): Promise<void> {
  await resolveLlmRequestLogWriter().backfillMessageIdOnLogs(
    conversationId,
    messageId,
  );
}

/**
 * Re-link LLM request logs from a set of source message IDs to a target
 * message. Used during message consolidation so logs from deleted
 * intermediate messages survive and remain queryable via the consolidated
 * message.
 */
export async function relinkLlmRequestLogs(
  fromMessageIds: string[],
  toMessageId: string,
): Promise<void> {
  if (fromMessageIds.length === 0) {
    return;
  }
  await resolveLlmRequestLogWriter().relinkLlmRequestLogs(
    fromMessageIds,
    toMessageId,
  );
}

/**
 * Internal helper: query `llm_request_logs` for rows matching any of the
 * given message IDs, ordered by `createdAt ASC`. Uses the existing
 * `idx_llm_request_logs_message_id` index via `inArray`.
 */
async function selectLogsByMessageIds(messageIds: string[]): Promise<LogRow[]> {
  if (messageIds.length === 0) {
    return [];
  }
  const db = logsDb();
  const logs = db.schema.llmRequestLogs;
  return db.orm
    .select({
      id: logs.id,
      conversationId: logs.conversationId,
      messageId: logs.messageId,
      provider: logs.provider,
      requestPayload: logs.requestPayload,
      responsePayload: logs.responsePayload,
      createdAt: logs.createdAt,
      agentLoopExitReason: logs.agentLoopExitReason,
      callSite: logs.callSite,
      latencyBreakdown: logs.latencyBreakdown,
    })
    .from(logs)
    .where(inArray(logs.messageId, messageIds))
    .orderBy(logs.createdAt);
}

/**
 * Query every LLM request log recorded for a conversation, ordered by
 * creation time. Conversation-scoped inspector views intentionally do
 * not apply turn recovery: the `conversation_id` column already includes
 * linked, unlinked, and orphaned rows for the full conversation.
 */
export async function getRequestLogsByConversationId(
  conversationId: string,
): Promise<LogRow[]> {
  const db = logsDb();
  const logs = db.schema.llmRequestLogs;
  return db.orm
    .select({
      id: logs.id,
      conversationId: logs.conversationId,
      messageId: logs.messageId,
      provider: logs.provider,
      requestPayload: logs.requestPayload,
      responsePayload: logs.responsePayload,
      createdAt: logs.createdAt,
      agentLoopExitReason: logs.agentLoopExitReason,
      callSite: logs.callSite,
      latencyBreakdown: logs.latencyBreakdown,
    })
    .from(logs)
    .where(eq(logs.conversationId, conversationId))
    .orderBy(asc(logs.createdAt), asc(logs.id));
}

/**
 * Find orphaned logs — logs whose `message_id` references a message that no
 * longer exists in the DB. These are left behind when intermediate assistant
 * messages are deleted (e.g. by retry/deleteLastExchange).
 *
 * Scoped to a single conversation and a time range to avoid cross-turn bleed.
 */
async function selectOrphanedLogsInRange(
  conversationId: string,
  startTime: number,
  endTime: number,
): Promise<LogRow[]> {
  if (endTime <= startTime) {
    return [];
  }
  // `llm_request_logs` and `messages` share one database, but the lookup still
  // resolves in three steps so the message-id existence check stays on the
  // main facade:
  //   (a) candidate rows in [start,end] for the conversation with a non-NULL
  //       message_id;
  //   (b) which of those message_ids still exist in `messages`;
  //   (c) filter to candidates whose message_id is NOT in the existing set.
  const db = logsDb();
  const logs = db.schema.llmRequestLogs;
  const candidates = await db.orm
    .select({
      id: logs.id,
      conversationId: logs.conversationId,
      messageId: logs.messageId,
      provider: logs.provider,
      requestPayload: logs.requestPayload,
      responsePayload: logs.responsePayload,
      createdAt: logs.createdAt,
      agentLoopExitReason: logs.agentLoopExitReason,
      callSite: logs.callSite,
      latencyBreakdown: logs.latencyBreakdown,
    })
    .from(logs)
    .where(
      and(
        eq(logs.conversationId, conversationId),
        gte(logs.createdAt, startTime),
        lte(logs.createdAt, endTime),
        sql`${logs.messageId} IS NOT NULL`,
      ),
    )
    .orderBy(logs.createdAt);
  if (candidates.length === 0) {
    return [];
  }

  const candidateMessageIds = [
    ...new Set(candidates.map((c) => c.messageId as string)),
  ];
  const existing = await existingMessageIds(candidateMessageIds);

  // Orphaned = the referenced message no longer exists.
  return candidates.filter((c) => !existing.has(c.messageId as string));
}

/**
 * Find unlinked logs — logs with `message_id IS NULL` that haven't been
 * backfilled yet. This covers the race where the client queries the inspector
 * before `backfillMessageIdOnLogs` runs in `handleMessageComplete`, or when
 * the backfill fails silently (try-catch in the agent loop).
 *
 * Scoped to a single conversation and a time range to avoid cross-turn bleed.
 */
async function selectUnlinkedLogsInRange(
  conversationId: string,
  startTime: number,
  endTime: number,
): Promise<LogRow[]> {
  if (endTime <= startTime) {
    return [];
  }
  const db = logsDb();
  const logs = db.schema.llmRequestLogs;
  return db.orm
    .select({
      id: logs.id,
      conversationId: logs.conversationId,
      messageId: logs.messageId,
      provider: logs.provider,
      requestPayload: logs.requestPayload,
      responsePayload: logs.responsePayload,
      createdAt: logs.createdAt,
      agentLoopExitReason: logs.agentLoopExitReason,
      callSite: logs.callSite,
      latencyBreakdown: logs.latencyBreakdown,
    })
    .from(logs)
    .where(
      and(
        eq(logs.conversationId, conversationId),
        gte(logs.createdAt, startTime),
        lte(logs.createdAt, endTime),
        isNull(logs.messageId),
      ),
    )
    .orderBy(logs.createdAt);
}

/**
 * Return the `createdAt` of the most recent **non-`compactionAgent`** LLM
 * call in the conversation that ran strictly before `beforeCreatedAt`, or
 * `null` when no such call exists (the selected call is the first real
 * call in the conversation).
 *
 * Drives the call-scoped floor for the Inspector's Compaction tab. A
 * compaction is attributed to the next real call that runs after it, so
 * the trail for a given call is the set of compactions that landed
 * strictly between the previous real call and the selected call. NULL
 * `callSite` rows (pre-migration-264) are treated as real calls — only
 * `compactionAgent` rows are excluded.
 */
export async function getPreviousNonCompactionCallCreatedAt(
  conversationId: string,
  beforeCreatedAt: number,
): Promise<number | null> {
  const db = logsDb();
  const logs = db.schema.llmRequestLogs;
  const [row] = await db.orm
    .select({ createdAt: logs.createdAt })
    .from(logs)
    .where(
      and(
        eq(logs.conversationId, conversationId),
        lt(logs.createdAt, beforeCreatedAt),
        or(
          isNull(logs.callSite),
          ne(logs.callSite, CALL_SITE_COMPACTION_AGENT),
        ),
      ),
    )
    .orderBy(desc(logs.createdAt), desc(logs.id))
    .limit(1);
  return row?.createdAt ?? null;
}

/**
 * Fetch every `compactionAgent` log row in the conversation whose
 * `createdAt` falls in the **open window** `(afterCreatedAt, beforeCreatedAt)`,
 * ordered chronologically.
 *
 * Drives the Inspector's Compaction tab. The caller resolves both
 * bounds:
 *   - `beforeCreatedAt` = the selected LLM call's `createdAt` (ceiling).
 *   - `afterCreatedAt` = the previous non-`compactionAgent` call's
 *     `createdAt` (floor), or `null` when the selected call is the first
 *     real call in the conversation.
 *
 * Both bounds are **strict**: the selected call itself never appears in
 * its own trail (`<` ceiling), and compactions that fed an earlier real
 * call's context don't bleed into this call's window (`>` floor). When
 * `afterCreatedAt` is `null` the floor is dropped entirely — every
 * preceding compaction is in scope, which is the right behavior for the
 * very first real call in the conversation.
 *
 * NULL `callSite` rows (pre-migration-264) are excluded by the explicit
 * `callSite = 'compactionAgent'` predicate without a separate IS NOT
 * NULL clause.
 */
export async function getCompactionLogsBetween(
  conversationId: string,
  afterCreatedAt: number | null,
  beforeCreatedAt: number,
): Promise<CompactionAgentLogRow[]> {
  const db = logsDb();
  const logs = db.schema.llmRequestLogs;
  const predicates = [
    eq(logs.conversationId, conversationId),
    eq(logs.callSite, CALL_SITE_COMPACTION_AGENT),
    lt(logs.createdAt, beforeCreatedAt),
  ];
  if (afterCreatedAt !== null) {
    predicates.push(gt(logs.createdAt, afterCreatedAt));
  }
  return db.orm
    .select({
      id: logs.id,
      conversationId: logs.conversationId,
      messageId: logs.messageId,
      provider: logs.provider,
      responsePayload: logs.responsePayload,
      // Count the request's messages in SQL instead of loading the payload:
      // `messages` (Anthropic / OpenAI chat-completions), `contents`
      // (Gemini), `input` (OpenAI Responses). NULL when the payload is
      // malformed or none of the arrays exist.
      requestMessageCount: sql<number | null>`CASE
        WHEN pg_input_is_valid(${logs.requestPayload}, 'jsonb') THEN coalesce(
          CASE WHEN jsonb_typeof(${logs.requestPayload}::jsonb -> 'messages') = 'array'
            THEN jsonb_array_length(${logs.requestPayload}::jsonb -> 'messages') END,
          CASE WHEN jsonb_typeof(${logs.requestPayload}::jsonb -> 'contents') = 'array'
            THEN jsonb_array_length(${logs.requestPayload}::jsonb -> 'contents') END,
          CASE WHEN jsonb_typeof(${logs.requestPayload}::jsonb -> 'input') = 'array'
            THEN jsonb_array_length(${logs.requestPayload}::jsonb -> 'input') END
        ) ELSE NULL END`,
      createdAt: logs.createdAt,
      agentLoopExitReason: logs.agentLoopExitReason,
      callSite: logs.callSite,
    })
    .from(logs)
    .where(and(...predicates))
    .orderBy(asc(logs.createdAt), asc(logs.id));
}

/**
 * Metadata-only lookup by primary key. Used where the caller needs to
 * locate or validate a log (conversation scoping, `createdAt` anchoring)
 * without paying to load its payloads — a single request payload can be a
 * full context window.
 */
export async function getRequestLogMetaById(
  logId: string,
): Promise<LogMetaRow | null> {
  const db = logsDb();
  const logs = db.schema.llmRequestLogs;
  const [row] = await db.orm
    .select({
      id: logs.id,
      conversationId: logs.conversationId,
      messageId: logs.messageId,
      provider: logs.provider,
      createdAt: logs.createdAt,
      agentLoopExitReason: logs.agentLoopExitReason,
      callSite: logs.callSite,
    })
    .from(logs)
    .where(eq(logs.id, logId));
  return row ?? null;
}

export async function getRequestLogById(logId: string): Promise<LogRow | null> {
  const db = logsDb();
  const logs = db.schema.llmRequestLogs;
  const [row] = await db.orm
    .select({
      id: logs.id,
      conversationId: logs.conversationId,
      messageId: logs.messageId,
      provider: logs.provider,
      requestPayload: logs.requestPayload,
      responsePayload: logs.responsePayload,
      createdAt: logs.createdAt,
      agentLoopExitReason: logs.agentLoopExitReason,
      callSite: logs.callSite,
      latencyBreakdown: logs.latencyBreakdown,
    })
    .from(logs)
    .where(eq(logs.id, logId));
  return row ?? null;
}

/**
 * Authoritative post-persist linkage: stamp `message_id` onto rows a flow
 * inserted unlinked because its user-facing message persists afterwards
 * (the /compact and summarize-up-to result cards). Dispatched through the
 * IS-NULL-guarded {@link LlmRequestLogWriter.backfillMessageIdOnRecoveredLogs}.
 * The inspector's time-window recovery deliberately skips `compactionAgent`
 * rows (see {@link getRequestLogsByMessageId}), so it can never durably stamp
 * one onto an enclosing turn first and defeat this guarded link — the row is
 * still NULL when this runs, so the link wins. Non-fatal — an unlinked row
 * degrades to time-window recovery, not data loss.
 */
export async function linkRequestLogsToMessage(
  logIds: string[],
  messageId: string,
): Promise<void> {
  if (logIds.length === 0) {
    return;
  }
  try {
    await resolveLlmRequestLogWriter().backfillMessageIdOnRecoveredLogs(
      logIds,
      messageId,
    );
  } catch {
    // non-fatal — the row stays unlinked and time-window recovery finds it
  }
}

/**
 * True when a log row was authored by the turn's own agent loop — a
 * `mainAgent` row, or a legacy row from before call sites were stamped
 * (`call_site` NULL). Companion rows a turn merely hosts (e.g.
 * `compactionAgent`) don't count: a fork-local turn whose only rows are
 * companions still needs the fork-source fallback to surface the turn's
 * real calls.
 */
function isTurnAuthoredLog(row: LogRow): boolean {
  return row.callSite == null || row.callSite === "mainAgent";
}

export async function getRequestLogsByMessageId(
  messageId: string,
): Promise<LogRow[]> {
  // Resolve all assistant message IDs in the same turn so the inspector
  // shows every LLM call from the entire agent turn, not just the queried message.
  const turnMessageIds = await getAssistantMessageIdsInTurn(messageId);
  const turnLogs = await selectLogsByMessageIds(turnMessageIds);
  const seen = new Set(turnLogs.map((l) => l.id));
  const merged = [...turnLogs];

  // Recovery: find logs in the turn's time window that the message-ID-based
  // query missed. Two categories:
  //  1. Orphaned — messageId references a deleted message (retry/deleteLastExchange).
  //  2. Unlinked — messageId is still NULL because the backfill hasn't run yet
  //     or failed silently. This covers the race where the client queries the
  //     inspector before handleMessageComplete persists and backfills.
  const message = await getMessageById(messageId);
  if (message) {
    const bounds = await getTurnTimeBounds(
      message.conversationId,
      message.createdAt,
    );
    if (bounds) {
      const orphanedLogs = await selectOrphanedLogsInRange(
        message.conversationId,
        bounds.startTime,
        bounds.endTime,
      );
      const unlinkedLogs = await selectUnlinkedLogsInRange(
        message.conversationId,
        bounds.startTime,
        bounds.endTime,
      );

      for (const log of [...orphanedLogs, ...unlinkedLogs]) {
        if (!seen.has(log.id)) {
          merged.push(log);
          seen.add(log.id);
        }
      }

      // Opportunistically backfill recovered unlinked logs so future queries
      // hit the fast indexed-by-messageId path. Dispatched through the
      // active write backend like every other table writer — INSERT-only
      // backends no-op.
      //
      // Compaction rows are excluded: the /compact and summarize-up-to routes
      // link them to their result card via the IS-NULL-guarded
      // linkRequestLogsToMessage. Stamping one onto this enclosing turn here
      // (swept in during the window before the card persists) would make that
      // deliberate link a no-op and pin the call to the wrong turn forever.
      // They still surface in this turn's view via the merge above.
      const backfillIds = unlinkedLogs
        .filter((l) => l.callSite !== CALL_SITE_COMPACTION_AGENT)
        .map((l) => l.id);
      if (backfillIds.length > 0 && turnMessageIds.length > 0) {
        try {
          const targetMessageId = turnMessageIds[turnMessageIds.length - 1]!;
          await resolveLlmRequestLogWriter().backfillMessageIdOnRecoveredLogs(
            backfillIds,
            targetMessageId,
          );
        } catch {
          // non-fatal — the recovery already returned the right data
        }
      }
    }
  }

  // Fork-source fallback: pre-fork turns keep their calls under the SOURCE
  // conversation's message ids, so a fork-local turn with no turn-authored
  // row resolves the source turn and merges its calls. Gating on "no
  // turn-authored row" (not "no rows at all") keeps the fallback alive when
  // a companion row — e.g. a summarize-up-to compaction call landing inside
  // the turn's time window — was claimed by the recovery above; without it
  // that companion would eclipse the turn's real calls.
  if (message?.metadata && !merged.some(isTurnAuthoredLog)) {
    try {
      const parsed = messageMetadataSchema.safeParse(
        JSON.parse(message.metadata),
      );
      const sourceMessageId =
        parsed.success && typeof parsed.data.forkSourceMessageId === "string"
          ? parsed.data.forkSourceMessageId
          : null;
      if (sourceMessageId && sourceMessageId !== messageId) {
        const sourceTurnIds =
          await getAssistantMessageIdsInTurn(sourceMessageId);
        for (const log of await selectLogsByMessageIds(sourceTurnIds)) {
          if (!seen.has(log.id)) {
            merged.push(log);
            seen.add(log.id);
          }
        }
      }
    } catch {
      // malformed metadata — no fork source to resolve
    }
  }

  merged.sort((a, b) => a.createdAt - b.createdAt || a.id.localeCompare(b.id));
  return merged;
}
