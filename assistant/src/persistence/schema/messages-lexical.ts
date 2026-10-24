import { index, integer, sqliteTable, text } from "drizzle-orm/sqlite-core";

/**
 * SQLite mirror of the Postgres `messages_lexical` table.
 *
 * The table never existed in SQLite and is not part of the generated baseline:
 * it is created by the `0005_messages_lexical` Postgres migration. This entry
 * exists only because `pg-schema-mirror.test.ts` asserts that the two schema
 * barrels describe the same tables and columns. Do not add it to a SQLite
 * database or to `baseline.generated.ts`.
 */
export const messagesLexical = sqliteTable(
  "messages_lexical",
  {
    messageId: text("message_id").primaryKey(),
    conversationId: text("conversation_id").notNull(),
    createdAt: integer("created_at").notNull(),
    language: text("language"),
    body: text("body").notNull(),
  },
  (table) => [
    index("idx_messages_lexical_conversation_id").on(table.conversationId),
  ],
);
