import { eq } from "drizzle-orm";

import { memoryDbOrNull } from "../memory-db.js";

/**
 * Persist graph memory state for a conversation (upsert). Writes the dedicated
 * memory connection; an unavailable memory database no-ops.
 */
export async function saveGraphMemoryState(
  conversationId: string,
  stateJson: string,
): Promise<void> {
  const mdb = await memoryDbOrNull("saveGraphMemoryState");
  if (!mdb) {
    return;
  }
  const table = mdb.schema.conversationGraphMemoryState;
  const now = Date.now();
  await mdb.orm
    .insert(table)
    .values({ conversationId, stateJson, createdAt: now, updatedAt: now })
    .onConflictDoUpdate({
      target: table.conversationId,
      set: { stateJson, updatedAt: now },
    });
}

/**
 * Load graph memory state for a conversation, or null if none exists. Reads the
 * dedicated memory connection; an unavailable memory database reports none.
 */
export async function loadGraphMemoryState(
  conversationId: string,
): Promise<string | null> {
  const mdb = await memoryDbOrNull("loadGraphMemoryState");
  if (!mdb) {
    return null;
  }
  const table = mdb.schema.conversationGraphMemoryState;
  const rows = await mdb.orm
    .select({ stateJson: table.stateJson })
    .from(table)
    .where(eq(table.conversationId, conversationId));
  return rows[0]?.stateJson ?? null;
}

/**
 * Copy the parent conversation's graph memory state row to a new conversation
 * id so the forked conversation resumes with the parent's InContextTracker
 * snapshot (in-context node IDs, per-node turn log, current turn). No-op if
 * the parent has no row yet.
 */
export async function forkGraphMemoryState(
  parentConversationId: string,
  newConversationId: string,
): Promise<void> {
  const stateJson = await loadGraphMemoryState(parentConversationId);
  if (stateJson == null) {
    return;
  }
  await saveGraphMemoryState(newConversationId, stateJson);
}
