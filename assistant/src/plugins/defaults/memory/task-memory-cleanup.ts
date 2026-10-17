import { requireMainDb } from "../../../persistence/db-facade.js";
import { getLogger } from "./logging.js";

const log = getLogger("task-memory-cleanup");

/**
 * Check whether a conversation belongs to a failed schedule run. Derived from
 * durable storage (cron_runs) so the check survives daemon restarts.
 */
export async function isConversationFailed(
  conversationId: string,
): Promise<boolean> {
  // For reused schedule conversations the same conversation_id appears in
  // multiple cron_runs. A single failed run should NOT mark the conversation
  // as permanently failed, only the *most recent* run for that conversation
  // matters. We therefore check whether the latest cron_run (by created_at,
  // which is a monotonically increasing epoch timestamp) has an error status.
  // Note: cron_runs.id is a UUID v4 (random), so we cannot use MAX(id).
  const db = requireMainDb();
  const row = await db.get<{ found: number }>(
    `SELECT 1 AS found
       FROM cron_runs
      WHERE conversation_id = ?
        AND status = 'error'
        AND id = (
          SELECT id FROM cron_runs WHERE conversation_id = ?
          ORDER BY created_at DESC LIMIT 1
        )
      LIMIT 1`,
    [conversationId, conversationId],
  );
  return row != null;
}

/**
 * Invalidate assistant-inferred memory graph nodes sourced *exclusively* from
 * the given conversation. Called when a background schedule fails, the
 * assistant's optimistic claims are not trustworthy if the run didn't
 * complete.
 *
 * Nodes that also have sources from other non-failed conversations are left
 * alone (corroboration). Uses the `source_conversations` JSON array to
 * determine provenance.
 */
export async function invalidateAssistantInferredItemsForConversation(
  conversationId: string,
): Promise<number> {
  await cancelPendingExtractionJobsForConversation(conversationId);

  const db = requireMainDb();

  // Pull the candidate nodes, ask which of their corroborating conversations
  // failed, then invalidate the nodes with no surviving corroborator in JS.
  const candidates = await db.all<{
    id: string;
    source_conversations: string;
  }>(
    `SELECT id, source_conversations
       FROM memory_graph_nodes
      WHERE source_type = 'inferred'
        AND fidelity != 'gone'
        AND EXISTS (
          SELECT 1 FROM jsonb_array_elements_text(source_conversations::jsonb) AS jc(value)
           WHERE jc.value = ?
        )`,
    [conversationId],
  );
  if (candidates.length === 0) {
    return 0;
  }

  // Gather every corroborating (non-failed-conversation) source id across the
  // candidates, then ask which of them are failed.
  const otherIds = new Set<string>();
  const parsed = candidates.map((c) => {
    let sources: string[] = [];
    try {
      const raw = JSON.parse(c.source_conversations) as unknown;
      if (Array.isArray(raw)) {
        sources = raw.filter((s): s is string => typeof s === "string");
      }
    } catch {
      sources = [];
    }
    const others = sources.filter((s) => s !== conversationId);
    for (const o of others) {
      otherIds.add(o);
    }
    return { id: c.id, others };
  });

  const failedIds = await failedConversationIds(otherIds);

  // A node keeps its memory if at least one other source is a valid corroborator
  // (a conversation whose most recent run did not error, or any id with no run
  // at all). Invalidate the rest.
  const toInvalidate = parsed
    .filter((p) => !p.others.some((o) => !failedIds.has(o)))
    .map((p) => p.id);
  if (toInvalidate.length === 0) {
    return 0;
  }

  // Chunk the id list so a conversation attached to more nodes than Postgres's
  // bound-parameter limit still invalidates them all instead of throwing.
  const now = Date.now();
  const CHUNK = 500;
  let affected = 0;
  for (let i = 0; i < toInvalidate.length; i += CHUNK) {
    const chunk = toInvalidate.slice(i, i + CHUNK);
    const placeholders = chunk.map(() => "?").join(", ");
    affected += await db.run(
      `UPDATE memory_graph_nodes
          SET fidelity = 'gone',
              last_accessed = ?
        WHERE fidelity != 'gone'
          AND id IN (${placeholders})`,
      [now, ...chunk],
    );
  }

  if (affected > 0) {
    log.info(
      { conversationId, affected },
      "Invalidated assistant-inferred memory graph nodes after task failure",
    );
  }

  return affected;
}

/**
 * The subset of `ids` whose most recent `cron_runs` row has status `'error'`.
 * A conversation with no runs is not failed. Chunked to stay under Postgres's
 * bound-parameter limit.
 */
async function failedConversationIds(ids: Set<string>): Promise<Set<string>> {
  const failed = new Set<string>();
  if (ids.size === 0) {
    return failed;
  }

  const db = requireMainDb();
  const all = [...ids];
  const CHUNK = 500;
  for (let i = 0; i < all.length; i += CHUNK) {
    const chunk = all.slice(i, i + CHUNK);
    const placeholders = chunk.map(() => "?").join(", ");
    const rows = await db.all<{ conversation_id: string }>(
      `SELECT cr.conversation_id
         FROM cron_runs cr
        WHERE cr.conversation_id IN (${placeholders})
          AND cr.status = 'error'
          AND cr.id = (
            SELECT cr2.id FROM cron_runs cr2
             WHERE cr2.conversation_id = cr.conversation_id
             ORDER BY cr2.created_at DESC LIMIT 1
          )`,
      [...chunk],
    );
    for (const r of rows) {
      failed.add(r.conversation_id);
    }
  }
  return failed;
}

/**
 * Fail every pending/running job of one of `types` keyed to the given
 * conversation (`payload->>'conversationId'`, e.g. `graph_extract`,
 * `memory_retrospective`). Fired from the `conversation-deleted` hook, so the
 * worker does not burn cycles (and error noise) on jobs whose conversation no
 * longer exists.
 *
 * Two deliberate scope limits:
 * - conversationId-keyed only, it runs after the conversation's rows are
 *   deleted, and jobs for surviving multi-sourced graph nodes must stay
 *   runnable;
 * - restricted to the caller's own job types, the hook dispatch is
 *   fire-and-forget, so the sweep runs concurrently with the host cleanup
 *   jobs the delete primitive enqueues (the lexical purge is itself a
 *   `conversationId`-keyed pending job) and must not be able to fail them.
 */
export async function cancelPendingJobsForConversation(
  conversationId: string,
  types: readonly string[],
  reason: string = "conversation_deleted",
): Promise<number> {
  if (types.length === 0) {
    return 0;
  }
  const db = requireMainDb();
  const placeholders = types.map(() => "?").join(", ");
  const cancelled = await db.run(
    `UPDATE memory_jobs
        SET status = 'failed',
            last_error = ?,
            updated_at = ?
      WHERE status IN ('pending', 'running')
        AND type IN (${placeholders})
        AND payload::jsonb ->> 'conversationId' = ?`,
    [reason, Date.now(), ...types, conversationId],
  );

  if (cancelled > 0) {
    log.info(
      { conversationId, cancelled },
      "Cancelled pending memory jobs for deleted conversation",
    );
  }

  return cancelled;
}

/**
 * Cancel only pending/running `graph_extract` jobs for the given
 * conversation. Used by the task-failure path where we want to
 * stop new extractions but must NOT cancel `embed_graph_node` jobs,
 * those nodes may be multi-sourced and still valid.
 */
async function cancelPendingExtractionJobsForConversation(
  conversationId: string,
): Promise<number> {
  const db = requireMainDb();
  const now = Date.now();
  const cancelled = await db.run(
    `UPDATE memory_jobs
        SET status = 'failed',
            last_error = 'conversation_failed',
            updated_at = ?
      WHERE status IN ('pending', 'running')
        AND type = 'graph_extract'
        AND payload::jsonb ->> 'conversationId' = ?`,
    [now, conversationId],
  );

  if (cancelled > 0) {
    log.info(
      { conversationId, cancelled },
      "Cancelled pending extraction jobs for failed conversation",
    );
  }

  return cancelled;
}
