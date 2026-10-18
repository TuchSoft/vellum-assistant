/**
 * Store operations for conversation-level attention tracking.
 *
 * Tracks whether the user has seen the latest assistant message using two
 * tables: an append-only evidence log (conversation_attention_events) and a
 * single-row projection per conversation (conversation_assistant_attention_state).
 */

import { and, eq, inArray, isNull, lt, or, type SQL, sql } from "drizzle-orm";
import { v4 as uuid } from "uuid";

import { UserError } from "../util/errors.js";
import type { AsyncDb, SchemaTables } from "./db-facade.js";
import { requireMainDb } from "./db-facade.js";
import {
  latestAssistantMessage,
  latestAssistantMessageBefore,
} from "./message-reads.js";

// ── Types ────────────────────────────────────────────────────────────

export type SignalType =
  | "macos_notification_view"
  | "macos_conversation_opened"
  | "ios_conversation_opened"
  | "web_bulk_mark_read"
  | "telegram_inbound_message"
  | "telegram_callback"
  | "slack_inbound_message"
  | "slack_callback";

export type Confidence = "explicit" | "inferred";

export interface AttentionEvent {
  id: string;
  conversationId: string;
  sourceChannel: string;
  signalType: SignalType;
  confidence: Confidence;
  source: string;
  evidenceText: string | null;
  metadataJson: string;
  observedAt: number;
  createdAt: number;
}

export interface AttentionState {
  conversationId: string;
  latestAssistantMessageId: string | null;
  latestAssistantMessageAt: number | null;
  lastSeenAssistantMessageId: string | null;
  lastSeenAssistantMessageAt: number | null;
  lastSeenEventAt: number | null;
  lastSeenConfidence: Confidence | null;
  lastSeenSignalType: SignalType | null;
  lastSeenSourceChannel: string | null;
  lastSeenSource: string | null;
  lastSeenEvidenceText: string | null;
  createdAt: number;
  updatedAt: number;
}

type AttentionStateRow =
  SchemaTables["conversationAssistantAttentionState"]["$inferSelect"];

/**
 * True when the latest assistant cursor is ahead of the last-seen cursor.
 *
 * The single definition of "unseen" for the sidebar indicator
 * (`buildAssistantAttention` in `runtime/services/conversation-serializer.ts`)
 * and the assistant-reply push producer, so the badge and the notification
 * cannot disagree. An absent state row reads as seen.
 */
export function hasUnseenLatestAssistantMessage(
  state:
    | Pick<
        AttentionState,
        "latestAssistantMessageAt" | "lastSeenAssistantMessageAt"
      >
    | null
    | undefined,
): boolean {
  if (!state || state.latestAssistantMessageAt == null) {
    return false;
  }
  return (
    state.lastSeenAssistantMessageAt == null ||
    state.lastSeenAssistantMessageAt < state.latestAssistantMessageAt
  );
}

/**
 * SQL twin of {@link hasUnseenLatestAssistantMessage}: conditions over
 * `conversation_assistant_attention_state` selecting rows whose latest
 * assistant cursor is ahead of the last-seen cursor. Shared by
 * {@link listConversationAttention} and `countUnreadConversations`
 * (`conversation-queries.ts`) so every SQL reader of "unseen" agrees with
 * the TS predicate.
 */
export function unseenAttentionStateConditions(): SQL[] {
  const attentionState =
    requireMainDb().schema.conversationAssistantAttentionState;
  return [
    sql`${attentionState.latestAssistantMessageAt} IS NOT NULL`,
    or(
      isNull(attentionState.lastSeenAssistantMessageAt),
      sql`${attentionState.lastSeenAssistantMessageAt} < ${attentionState.latestAssistantMessageAt}`,
    )!,
  ];
}

// ── Row mappers ──────────────────────────────────────────────────────

function rowToState(row: AttentionStateRow): AttentionState {
  return {
    conversationId: row.conversationId,
    latestAssistantMessageId: row.latestAssistantMessageId,
    latestAssistantMessageAt: row.latestAssistantMessageAt,
    lastSeenAssistantMessageId: row.lastSeenAssistantMessageId,
    lastSeenAssistantMessageAt: row.lastSeenAssistantMessageAt,
    lastSeenEventAt: row.lastSeenEventAt,
    lastSeenConfidence: row.lastSeenConfidence as Confidence | null,
    lastSeenSignalType: row.lastSeenSignalType as SignalType | null,
    lastSeenSourceChannel: row.lastSeenSourceChannel,
    lastSeenSource: row.lastSeenSource,
    lastSeenEvidenceText: row.lastSeenEvidenceText,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}

// ── projectAssistantMessage ──────────────────────────────────────────

/**
 * Update the latest-assistant cursor when a new assistant message is persisted.
 * Monotonic: the cursor never moves backward.
 */
export async function projectAssistantMessage(params: {
  conversationId: string;
  messageId: string;
  messageAt: number;
}): Promise<boolean> {
  const { conversationId, messageId, messageAt } = params;
  const db = requireMainDb();
  const attentionState = db.schema.conversationAssistantAttentionState;
  const now = Date.now();

  const [existing] = await db.orm
    .select()
    .from(attentionState)
    .where(eq(attentionState.conversationId, conversationId));

  if (!existing) {
    await db.orm.insert(attentionState).values({
      conversationId,
      latestAssistantMessageId: messageId,
      latestAssistantMessageAt: messageAt,
      lastSeenAssistantMessageId: null,
      lastSeenAssistantMessageAt: null,
      lastSeenEventAt: null,
      lastSeenConfidence: null,
      lastSeenSignalType: null,
      lastSeenSourceChannel: null,
      lastSeenSource: null,
      lastSeenEvidenceText: null,
      createdAt: now,
      updatedAt: now,
    });
    return true;
  }

  // Monotonic: only advance if the new message is strictly later
  if (
    existing.latestAssistantMessageAt != null &&
    messageAt <= existing.latestAssistantMessageAt
  ) {
    return false;
  }

  // Determine whether the conversation was previously in a "seen" state.
  // Two cases count as seen:
  //   1. latestAssistantMessageAt is null — no prior assistant message existed,
  //      so there was nothing unseen. The first assistant message transitions
  //      the conversation to unseen.
  //   2. lastSeenAssistantMessageAt >= latestAssistantMessageAt — the user saw
  //      the most recent assistant message.
  const wasSeen =
    existing.latestAssistantMessageAt == null ||
    (existing.lastSeenAssistantMessageAt != null &&
      existing.lastSeenAssistantMessageAt >= existing.latestAssistantMessageAt);

  await db.orm
    .update(attentionState)
    .set({
      latestAssistantMessageId: messageId,
      latestAssistantMessageAt: messageAt,
      updatedAt: now,
    })
    .where(eq(attentionState.conversationId, conversationId));

  return wasSeen;
}

/**
 * Seed a forked conversation's assistant-attention projection so copied
 * assistant history is treated as already seen from the outset.
 */
export async function seedForkedConversationAttention(params: {
  conversationId: string;
  latestAssistantMessageId: string | null;
  latestAssistantMessageAt: number | null;
  db?: AsyncDb;
}): Promise<void> {
  const { conversationId, latestAssistantMessageId, latestAssistantMessageAt } =
    params;

  if (!latestAssistantMessageId || latestAssistantMessageAt == null) {
    return;
  }

  const db = params.db ?? requireMainDb();
  const attentionState = db.schema.conversationAssistantAttentionState;
  const now = Date.now();
  const [existing] = await db.orm
    .select()
    .from(attentionState)
    .where(eq(attentionState.conversationId, conversationId));

  if (!existing) {
    await db.orm.insert(attentionState).values({
      conversationId,
      latestAssistantMessageId,
      latestAssistantMessageAt,
      lastSeenAssistantMessageId: latestAssistantMessageId,
      lastSeenAssistantMessageAt: latestAssistantMessageAt,
      lastSeenEventAt: null,
      lastSeenConfidence: null,
      lastSeenSignalType: null,
      lastSeenSourceChannel: null,
      lastSeenSource: null,
      lastSeenEvidenceText: null,
      createdAt: now,
      updatedAt: now,
    });
    return;
  }

  await db.orm
    .update(attentionState)
    .set({
      latestAssistantMessageId,
      latestAssistantMessageAt,
      lastSeenAssistantMessageId: latestAssistantMessageId,
      lastSeenAssistantMessageAt: latestAssistantMessageAt,
      lastSeenEventAt: null,
      lastSeenConfidence: null,
      lastSeenSignalType: null,
      lastSeenSourceChannel: null,
      lastSeenSource: null,
      lastSeenEvidenceText: null,
      updatedAt: now,
    })
    .where(eq(attentionState.conversationId, conversationId));
}

// ── recordConversationSeenSignal ─────────────────────────────────────

/**
 * Record a "seen" signal: appends an immutable event row and advances the
 * seen cursor in the state projection to the current latest assistant message.
 */
export async function recordConversationSeenSignal(params: {
  conversationId: string;
  sourceChannel: string;
  signalType: SignalType;
  confidence: Confidence;
  source: string;
  evidenceText?: string;
  metadata?: Record<string, unknown>;
  observedAt?: number;
}): Promise<AttentionEvent> {
  const {
    conversationId,
    sourceChannel,
    signalType,
    confidence,
    source,
    evidenceText,
    metadata,
    observedAt,
  } = params;

  const db = requireMainDb();
  const attentionEvents = db.schema.conversationAttentionEvents;
  const attentionState = db.schema.conversationAssistantAttentionState;
  const now = Date.now();
  const eventId = uuid();
  const eventObservedAt = observedAt ?? now;
  const metadataJson = metadata ? JSON.stringify(metadata) : "{}";

  const event: SchemaTables["conversationAttentionEvents"]["$inferInsert"] = {
    id: eventId,
    conversationId,
    sourceChannel,
    signalType,
    confidence,
    source,
    evidenceText: evidenceText ?? null,
    metadataJson,
    observedAt: eventObservedAt,
    createdAt: now,
  };

  await db.transaction(async (tx) => {
    // 1. Append immutable evidence row
    await tx.orm.insert(attentionEvents).values(event);

    // 2. Advance the seen cursor to the current latest assistant message
    const [state] = await tx.orm
      .select()
      .from(attentionState)
      .where(eq(attentionState.conversationId, conversationId));

    if (!state) {
      // No state row yet — look up the conversation's latest assistant message so
      // upgraded databases (with existing messages but no attention row) correctly
      // initialize the full state on the first seen signal. Finalized-only via
      // the accessor: a still-streaming reply is not a reply the user has seen,
      // and anchoring the watermark on it would classify the finished reply as
      // seen the moment it completes.
      const latestMsg = await latestAssistantMessage(conversationId, {
        db: tx,
      });

      const latestMsgId = latestMsg?.id ?? null;
      const latestMsgAt = latestMsg?.createdAt ?? null;

      await tx.orm.insert(attentionState).values({
        conversationId,
        latestAssistantMessageId: latestMsgId,
        latestAssistantMessageAt: latestMsgAt,
        lastSeenAssistantMessageId: latestMsgId,
        lastSeenAssistantMessageAt: latestMsgAt,
        lastSeenEventAt: eventObservedAt,
        lastSeenConfidence: confidence,
        lastSeenSignalType: signalType,
        lastSeenSourceChannel: sourceChannel,
        lastSeenSource: source,
        lastSeenEvidenceText: evidenceText ?? null,
        createdAt: now,
        updatedAt: now,
      });
      return;
    }

    // Only advance the seen cursor if there is a latest assistant message to mark as seen,
    // and the seen cursor hasn't already reached or passed it (monotonic invariant).
    const shouldAdvanceSeen =
      state.latestAssistantMessageAt != null &&
      (state.lastSeenAssistantMessageAt == null ||
        state.latestAssistantMessageAt > state.lastSeenAssistantMessageAt);

    // Guard seen metadata monotonicity: only update lastSeen* metadata when the
    // new signal's observedAt is at least as recent as the existing projection.
    // Out-of-order delivery (e.g. delayed channel callbacks) must not regress
    // the projected channel/source/confidence metadata.
    const isNewerSignal =
      state.lastSeenEventAt == null || eventObservedAt >= state.lastSeenEventAt;

    const updates: Record<string, unknown> = {
      updatedAt: now,
    };

    if (isNewerSignal) {
      updates.lastSeenEventAt = eventObservedAt;
      updates.lastSeenConfidence = confidence;
      updates.lastSeenSignalType = signalType;
      updates.lastSeenSourceChannel = sourceChannel;
      updates.lastSeenSource = source;
      updates.lastSeenEvidenceText = evidenceText ?? null;
    }

    if (shouldAdvanceSeen) {
      updates.lastSeenAssistantMessageId = state.latestAssistantMessageId;
      updates.lastSeenAssistantMessageAt = state.latestAssistantMessageAt;
    }

    await tx.orm
      .update(attentionState)
      .set(updates)
      .where(eq(attentionState.conversationId, conversationId));
  });

  return {
    id: eventId,
    conversationId,
    sourceChannel,
    signalType,
    confidence,
    source,
    evidenceText: evidenceText ?? null,
    metadataJson,
    observedAt: eventObservedAt,
    createdAt: now,
  };
}

// ── markConversationUnread ───────────────────────────────────────────

async function resolveAssistantCursor(params: {
  db: AsyncDb;
  conversationId: string;
  latestAssistantMessageId?: string | null;
  latestAssistantMessageAt?: number | null;
}): Promise<{
  latestAssistantMessageId: string;
  latestAssistantMessageAt: number;
  previousAssistantMessageId: string | null;
  previousAssistantMessageAt: number | null;
} | null> {
  const {
    db,
    conversationId,
    latestAssistantMessageId,
    latestAssistantMessageAt,
  } = params;

  if (latestAssistantMessageId && latestAssistantMessageAt != null) {
    const previousMessage = await latestAssistantMessageBefore(
      conversationId,
      latestAssistantMessageAt,
      { db },
    );

    return {
      latestAssistantMessageId,
      latestAssistantMessageAt,
      previousAssistantMessageId: previousMessage?.id ?? null,
      previousAssistantMessageAt: previousMessage?.createdAt ?? null,
    };
  }

  const latestMessage = await latestAssistantMessage(conversationId, { db });

  if (!latestMessage) {
    return null;
  }

  const previousMessage = await latestAssistantMessageBefore(
    conversationId,
    latestMessage.createdAt,
    { db },
  );
  return {
    latestAssistantMessageId: latestMessage.id,
    latestAssistantMessageAt: latestMessage.createdAt,
    previousAssistantMessageId: previousMessage?.id ?? null,
    previousAssistantMessageAt: previousMessage?.createdAt ?? null,
  };
}

/**
 * Rewind the seen cursor so the current latest assistant reply becomes unread.
 * This uses the existing attention projection instead of adding a separate
 * manual-unread state machine.
 */
/**
 * Returns `true` when the seen cursor was actually rewound (state changed),
 * `false` when the conversation was already unread (no-op).
 * Throws `UserError` when there is no assistant message to mark unread.
 */
export async function markConversationUnread(
  conversationId: string,
): Promise<boolean> {
  const db = requireMainDb();
  const attentionState = db.schema.conversationAssistantAttentionState;
  const now = Date.now();
  let changed = false;

  await db.transaction(async (tx) => {
    const [state] = await tx.orm
      .select()
      .from(attentionState)
      .where(eq(attentionState.conversationId, conversationId));

    const cursor = await resolveAssistantCursor({
      db: tx,
      conversationId,
      latestAssistantMessageId: state?.latestAssistantMessageId,
      latestAssistantMessageAt: state?.latestAssistantMessageAt,
    });

    if (!cursor) {
      throw new UserError(
        "Conversation has no assistant message to mark unread",
      );
    }

    const isAlreadyUnread =
      state != null &&
      (state.lastSeenAssistantMessageAt == null ||
        state.lastSeenAssistantMessageAt < cursor.latestAssistantMessageAt);

    if (isAlreadyUnread) {
      return;
    }

    if (!state) {
      await tx.orm.insert(attentionState).values({
        conversationId,
        latestAssistantMessageId: cursor.latestAssistantMessageId,
        latestAssistantMessageAt: cursor.latestAssistantMessageAt,
        lastSeenAssistantMessageId: cursor.previousAssistantMessageId,
        lastSeenAssistantMessageAt: cursor.previousAssistantMessageAt,
        lastSeenEventAt: null,
        lastSeenConfidence: null,
        lastSeenSignalType: null,
        lastSeenSourceChannel: null,
        lastSeenSource: null,
        lastSeenEvidenceText: null,
        createdAt: now,
        updatedAt: now,
      });
      changed = true;
      return;
    }

    await tx.orm
      .update(attentionState)
      .set({
        lastSeenAssistantMessageId: cursor.previousAssistantMessageId,
        lastSeenAssistantMessageAt: cursor.previousAssistantMessageAt,
        updatedAt: now,
      })
      .where(eq(attentionState.conversationId, conversationId));
    changed = true;
  });

  return changed;
}

// ── getAttentionStateByConversationIds ───────────────────────────────

/**
 * Batch read for conversation list enrichment.
 * Returns a map of conversationId -> AttentionState.
 */
export async function getAttentionStateByConversationIds(
  conversationIds: string[],
): Promise<Map<string, AttentionState>> {
  if (conversationIds.length === 0) {
    return new Map();
  }

  const db = requireMainDb();
  const attentionState = db.schema.conversationAssistantAttentionState;
  const rows = await db.orm
    .select()
    .from(attentionState)
    .where(inArray(attentionState.conversationId, conversationIds));

  const result = new Map<string, AttentionState>();
  for (const row of rows) {
    result.set(row.conversationId, rowToState(row));
  }
  return result;
}

// ── listConversationAttention ────────────────────────────────────────

export type AttentionFilterState = "seen" | "unseen" | "all";

export interface ListConversationAttentionParams {
  state?: AttentionFilterState;
  sourceChannel?: string;
  source?: string;
  limit?: number;
  before?: number;
}

/**
 * Filtered list for assistant/LLM reporting API.
 * Supports filters: state (seen/unseen/all), source channel, limit, before cursor.
 */
export async function listConversationAttention(
  params: ListConversationAttentionParams,
): Promise<AttentionState[]> {
  const {
    state: filterState = "all",
    sourceChannel,
    source,
    limit = 50,
    before,
  } = params;

  const db = requireMainDb();
  const attentionState = db.schema.conversationAssistantAttentionState;
  const conversations = db.schema.conversations;
  const conditions: SQL[] = [];

  if (sourceChannel) {
    conditions.push(eq(conversations.originChannel, sourceChannel));
  }

  if (source) {
    conditions.push(eq(conversations.source, source));
  }

  if (before !== undefined) {
    conditions.push(lt(attentionState.latestAssistantMessageAt, before));
  }

  if (filterState === "unseen") {
    // Unseen: latest assistant message exists but no seen cursor, or seen cursor is behind latest
    conditions.push(...unseenAttentionStateConditions());
  } else if (filterState === "seen") {
    // Seen: seen cursor equals latest assistant message
    conditions.push(
      sql`${attentionState.latestAssistantMessageAt} IS NOT NULL`,
    );
    conditions.push(
      sql`${attentionState.lastSeenAssistantMessageAt} = ${attentionState.latestAssistantMessageAt}`,
    );
  }

  let query = db.orm
    .select({
      conversationId: attentionState.conversationId,
      latestAssistantMessageId: attentionState.latestAssistantMessageId,
      latestAssistantMessageAt: attentionState.latestAssistantMessageAt,
      lastSeenAssistantMessageId: attentionState.lastSeenAssistantMessageId,
      lastSeenAssistantMessageAt: attentionState.lastSeenAssistantMessageAt,
      lastSeenEventAt: attentionState.lastSeenEventAt,
      lastSeenConfidence: attentionState.lastSeenConfidence,
      lastSeenSignalType: attentionState.lastSeenSignalType,
      lastSeenSourceChannel: attentionState.lastSeenSourceChannel,
      lastSeenSource: attentionState.lastSeenSource,
      lastSeenEvidenceText: attentionState.lastSeenEvidenceText,
      createdAt: attentionState.createdAt,
      updatedAt: attentionState.updatedAt,
    })
    .from(attentionState);

  // Only join conversations table when filtering by source or sourceChannel
  if (source || sourceChannel) {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    query = (query as any).innerJoin(
      conversations,
      eq(attentionState.conversationId, conversations.id),
    );
  }

  const rows = await (
    conditions.length > 0 ? query.where(and(...conditions)) : query
  )
    .orderBy(sql`${attentionState.latestAssistantMessageAt} DESC NULLS LAST`)
    .limit(limit);

  return rows.map(rowToState);
}
