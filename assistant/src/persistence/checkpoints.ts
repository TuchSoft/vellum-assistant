import { eq } from "drizzle-orm";

import { requireMainDb } from "./db-facade.js";

export interface MessageCursorCheckpoint {
  createdAt: number;
  messageId: string;
}

export async function getMemoryCheckpoint(key: string): Promise<string | null> {
  const db = requireMainDb();
  const checkpoints = db.schema.memoryCheckpoints;
  const [row] = await db.orm
    .select({ value: checkpoints.value })
    .from(checkpoints)
    .where(eq(checkpoints.key, key));
  return row?.value ?? null;
}

export async function setMemoryCheckpoint(
  key: string,
  value: string,
): Promise<void> {
  const db = requireMainDb();
  const checkpoints = db.schema.memoryCheckpoints;
  const now = Date.now();
  await db.orm
    .insert(checkpoints)
    .values({ key, value, updatedAt: now })
    .onConflictDoUpdate({
      target: checkpoints.key,
      set: { value, updatedAt: now },
    });
}

export async function deleteMemoryCheckpoint(key: string): Promise<void> {
  const db = requireMainDb();
  const checkpoints = db.schema.memoryCheckpoints;
  await db.orm.delete(checkpoints).where(eq(checkpoints.key, key));
}

export async function readMessageCursorCheckpoint(
  createdAtKey: string,
  messageIdKey: string,
): Promise<MessageCursorCheckpoint> {
  const [createdAtRaw, messageIdRaw] = await Promise.all([
    getMemoryCheckpoint(createdAtKey),
    getMemoryCheckpoint(messageIdKey),
  ]);
  const createdAt = Number.parseInt(createdAtRaw ?? "0", 10) || 0;
  const messageId = messageIdRaw ?? "";
  return { createdAt, messageId };
}

export async function writeMessageCursorCheckpoint(
  createdAtKey: string,
  messageIdKey: string,
  checkpoint: MessageCursorCheckpoint,
): Promise<void> {
  await setMemoryCheckpoint(createdAtKey, String(checkpoint.createdAt));
  await setMemoryCheckpoint(messageIdKey, checkpoint.messageId);
}

export async function resetMessageCursorCheckpoint(
  createdAtKey: string,
  messageIdKey: string,
): Promise<void> {
  await writeMessageCursorCheckpoint(createdAtKey, messageIdKey, {
    createdAt: 0,
    messageId: "",
  });
}

/**
 * Completion sentinel for the messages lexical-index backfill. Set once the
 * backfill has drained the entire `messages` table into the Qdrant lexical
 * index (`messages_lexical`); cleared on a `force` re-run.
 *
 * Lives here — in `persistence/` — so it is the single source of truth for the
 * backfill handler (plugin layer, which writes it) AND the message-search read
 * sites (persistence + plugin layers, which gate the read backend on it).
 * Keeping the key and its reader here lets `conversation-queries.ts` (also
 * `persistence/`) read it without a persistence -> plugin import.
 */
export const LEXICAL_BACKFILL_COMPLETE_KEY =
  "lexical:messages:backfill_complete";

/**
 * True once the messages lexical-index backfill has fully drained on this
 * instance.
 *
 * Gates two things: the one-time startup auto-enqueue (skip when already
 * complete) and — critically — the message-search read backend. An upgraded
 * instance whose backfill has not finished must keep reading from SQLite FTS,
 * because a `qdrant`-backed read against the still-filling `messages_lexical`
 * collection returns an empty result (not a throw), so the Qdrant-error degrade
 * path never fires and content search would silently return nothing. Switch
 * reads to Qdrant only once this marker confirms the index is fully populated.
 */
export async function isLexicalBackfillComplete(): Promise<boolean> {
  return (await getMemoryCheckpoint(LEXICAL_BACKFILL_COMPLETE_KEY)) === "1";
}

/**
 * Clear the lexical-backfill completion sentinel so {@link
 * isLexicalBackfillComplete} reads false until a run re-marks it.
 *
 * Called when a `force` re-index is requested — both at enqueue time (so reads
 * fall back to SQLite FTS the instant the rebuild is queued, rather than serving
 * from a stale/emptying `messages_lexical` collection in the window before the
 * worker claims the job) and again inside the backfill handler (idempotent).
 * Co-located with the key and its reader here so callers clear it without
 * re-declaring the key string.
 */
export async function clearLexicalBackfillComplete(): Promise<void> {
  await deleteMemoryCheckpoint(LEXICAL_BACKFILL_COMPLETE_KEY);
}

/**
 * Completion sentinel for the Postgres lexical backfill, kept distinct from
 * {@link LEXICAL_BACKFILL_COMPLETE_KEY} so the Qdrant and Postgres indexes
 * drain independently. Switching `search.lexicalStore` to `dual` or
 * `postgres` starts a fresh Postgres backfill even though the Qdrant one has
 * long been complete.
 */
export const PG_LEXICAL_BACKFILL_COMPLETE_KEY =
  "lexical:pg:messages:backfill_complete";

/**
 * True once the Postgres lexical index has fully drained on this instance.
 * Gates the Postgres read path: an index that is still filling returns fewer
 * results (not an error), so switching reads before the marker is set would
 * silently under-report matches.
 */
export async function isPgLexicalBackfillComplete(): Promise<boolean> {
  return (await getMemoryCheckpoint(PG_LEXICAL_BACKFILL_COMPLETE_KEY)) === "1";
}

/** Clear the Postgres lexical-backfill sentinel so a `force` re-run drains again. */
export async function clearPgLexicalBackfillComplete(): Promise<void> {
  await deleteMemoryCheckpoint(PG_LEXICAL_BACKFILL_COMPLETE_KEY);
}
