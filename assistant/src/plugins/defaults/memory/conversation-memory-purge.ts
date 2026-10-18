import { getLogger } from "./logging.js";
import { memoryDbOrNull } from "./memory-db.js";

const log = getLogger("conversation-memory-purge");

/**
 * Per-conversation memory tables on the dedicated memory connection that a
 * conversation delete must purge. SQLite foreign keys cannot span database
 * files, so the main-DB conversation-delete cascade never reaches these rows;
 * the `conversation-deleted` hook deletes them explicitly instead. Each table
 * keys on `conversation_id`; a table joins this list when it moves to the
 * memory connection.
 */
export const CONVERSATION_KEYED_MEMORY_TABLES: readonly string[] = [
  "memory_recall_logs",
  "memory_v3_selections",
  "memory_v3_pools",
  // The pool input capture keys its turn rows here; its companion texts
  // table is content-addressed and page-derived, so it has no conversation
  // rows to purge.
  "memory_v3_pool_inputs",
  "activation_sessions",
  "conversation_graph_memory_state",
  "memory_v3_ever_injected",
  "memory_v3_injected_sections",
  "memory_retrospective_state",
  // Re-derivable, but carries its conversation_id column, so a conversation
  // delete purges it here. A single-message delete (conversation survives) is
  // NOT covered by this conversation-keyed purge. Those message-scoped segments
  // are deleted explicitly in the message-delete paths, with no sweep backstop.
  "memory_segments",
];

/**
 * Delete the given conversation's rows from every table in
 * {@link CONVERSATION_KEYED_MEMORY_TABLES} on the memory connection.
 *
 * Best-effort: an unavailable memory database no-ops, and one table's failing
 * delete is logged and swallowed so the remaining tables are still purged. A
 * lost purge must never break conversation deletion — for these derived tables
 * a stray orphan row is harmless garbage.
 */
export async function purgeConversationMemoryTables(
  conversationId: string,
): Promise<void> {
  const db = memoryDbOrNull("purgeConversationMemoryTables");
  if (!db) {
    return;
  }
  for (const table of CONVERSATION_KEYED_MEMORY_TABLES) {
    try {
      await db.run(`DELETE FROM ${table} WHERE conversation_id = ?`, [
        conversationId,
      ]);
    } catch (err) {
      log.warn(
        { err, conversationId, table },
        "Failed to purge memory table for deleted conversation; continuing",
      );
    }
  }
}

/**
 * Wipe every table in {@link CONVERSATION_KEYED_MEMORY_TABLES} wholesale on the
 * memory connection. The clear-all reset drops all conversations at once, so
 * there is no id to key on — every row in these per-conversation tables is
 * orphaned by the wipe. Best-effort with the same guarantees as
 * {@link purgeConversationMemoryTables}: an unavailable memory database no-ops,
 * and a single table's failing delete is logged and swallowed.
 */
export async function clearAllConversationMemoryTables(): Promise<void> {
  const db = memoryDbOrNull("clearAllConversationMemoryTables");
  if (!db) {
    return;
  }
  for (const table of CONVERSATION_KEYED_MEMORY_TABLES) {
    try {
      await db.run(`DELETE FROM ${table}`);
    } catch (err) {
      log.warn(
        { err, table },
        "Failed to clear memory table during clear-all; continuing",
      );
    }
  }
}
