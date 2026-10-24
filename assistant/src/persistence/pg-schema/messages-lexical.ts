import { bigint, index, pgTable, text } from "drizzle-orm/pg-core";

/**
 * The Postgres lexical index for message content.
 *
 * A lateral table written asynchronously by the lexical indexing jobs, never a
 * generated column or a trigger on `messages`: the write amplification that
 * retired the SQLite FTS5 index (migration 313) must not come back. `body` is
 * the extracted readable text (see `indexableTextOfRow`), not the stored JSON
 * envelope.
 *
 * The BM25 index over `(body::pdb.icu)` is created by the `0005_messages_lexical`
 * migration, not here: Drizzle cannot express an index over a `pg_search`
 * expression, and the migration is the single place that must also fail
 * explicitly when the extension is missing.
 *
 * `language` is nullable and unused until the language phase populates it;
 * creating it now keeps that phase additive.
 *
 * No foreign keys: the read path joins `messages` (the Qdrant backend this
 * replaces also filtered orphaned points at read time), and the async delete
 * jobs own removal.
 */
export const messagesLexical = pgTable(
  "messages_lexical",
  {
    messageId: text("message_id").primaryKey(),
    conversationId: text("conversation_id").notNull(),
    createdAt: bigint("created_at", { mode: "number" }).notNull(),
    language: text("language"),
    body: text("body").notNull(),
  },
  (table) => [
    index("idx_messages_lexical_conversation_id").on(table.conversationId),
  ],
);
