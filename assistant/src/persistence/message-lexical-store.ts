/**
 * Postgres lexical index for message content (`messages_lexical`).
 *
 * The lateral table the `pg_search` (BM25) backend replaces the Qdrant
 * `messages_lexical` collection with. Writes are driven by the same jobs that
 * maintain the Qdrant collection, gated by `search.lexicalStore`; this module
 * performs the writes and knows nothing about the flag.
 *
 * Every write is idempotent: the primary key is the message id, so re-indexing
 * a row overwrites it. Deletes are keyed the same way, so a delete job that
 * runs twice is harmless.
 */

import { requireMainDb } from "./db-facade.js";

/** Rows per multi-row INSERT. Keeps the statement well under the parameter cap. */
const UPSERT_BATCH_SIZE = 200;

export interface LexicalIndexRow {
  messageId: string;
  conversationId: string;
  createdAt: number;
  body: string;
  /**
   * Detected ISO 639-1 language, or `null` for agnostic-only. Only a language
   * with a BM25 stemmer gets a value: it is what the partial language index
   * filters on, so a wrong value would route a row to a lane it does not
   * belong to.
   */
  language: string | null;
}

/**
 * Upsert one message's lexical row. Empty bodies are not written: the
 * extraction rule already drops rows with no readable text, and this is the
 * last line of defense against an empty index entry.
 */
export async function upsertMessageLexical(
  row: LexicalIndexRow,
): Promise<void> {
  if (row.body.length === 0) {
    return;
  }
  await upsertMessagesLexicalBatch([row]);
}

/**
 * Upsert a batch of lexical rows in multi-row INSERT statements, chunked to
 * {@link UPSERT_BATCH_SIZE} rows. Idempotent via `ON CONFLICT (message_id)`.
 */
export async function upsertMessagesLexicalBatch(
  rows: readonly LexicalIndexRow[],
): Promise<void> {
  const nonEmpty = rows.filter((row) => row.body.length > 0);
  if (nonEmpty.length === 0) {
    return;
  }
  const db = requireMainDb();
  for (let start = 0; start < nonEmpty.length; start += UPSERT_BATCH_SIZE) {
    const chunk = nonEmpty.slice(start, start + UPSERT_BATCH_SIZE);
    const placeholders = chunk.map(() => "(?, ?, ?, ?, ?)").join(", ");
    const params: Array<string | number | null> = [];
    for (const row of chunk) {
      params.push(
        row.messageId,
        row.conversationId,
        row.createdAt,
        row.language,
        row.body,
      );
    }
    await db.run(
      `INSERT INTO "messages_lexical" ("message_id", "conversation_id", "created_at", "language", "body")
       VALUES ${placeholders}
       ON CONFLICT ("message_id") DO UPDATE SET
         "conversation_id" = EXCLUDED."conversation_id",
         "created_at" = EXCLUDED."created_at",
         "language" = EXCLUDED."language",
         "body" = EXCLUDED."body"`,
      params,
    );
  }
}

/** Remove one message's lexical row. */
export async function deleteMessageLexicalRow(
  messageId: string,
): Promise<void> {
  const db = requireMainDb();
  await db.run(`DELETE FROM "messages_lexical" WHERE "message_id" = ?`, [
    messageId,
  ]);
}

/** Remove every lexical row of a conversation. */
export async function purgeConversationLexicalRows(
  conversationId: string,
): Promise<void> {
  const db = requireMainDb();
  await db.run(`DELETE FROM "messages_lexical" WHERE "conversation_id" = ?`, [
    conversationId,
  ]);
}

/** Drop every lexical row. Used by "clear all conversations". */
export async function clearMessagesLexicalRows(): Promise<void> {
  const db = requireMainDb();
  await db.run(`DELETE FROM "messages_lexical"`);
}
