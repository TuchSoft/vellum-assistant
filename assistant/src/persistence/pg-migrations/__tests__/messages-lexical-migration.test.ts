/**
 * Integration tests for the `0005_messages_lexical` migration step.
 *
 * Gated on a Postgres test database (`VELLUM_PG_TEST_URL`) that also carries
 * the `pg_search` extension. Without the extension the step is expected to
 * fail, so the suite reports "unavailable" and skips its assertions instead of
 * failing on a plain Postgres.
 */
import { beforeAll, expect, test } from "bun:test";

import { describePg } from "../../../__tests__/pg-test-db.js";
import { requireMainDb } from "../../db-facade.js";
import {
  deleteMessageLexicalRow,
  upsertMessagesLexicalBatch,
} from "../../message-lexical-store.js";
import { PG_STEPS } from "../pg-steps.js";

const STEP = PG_STEPS.find((step) => step.name === "0005_messages_lexical");

describePg("0005_messages_lexical", () => {
  let available = false;

  beforeAll(async () => {
    if (!STEP) {
      throw new Error("0005_messages_lexical step not found");
    }
    const db = requireMainDb();
    const row = await db.get<{ present: boolean }>(
      `SELECT EXISTS (
         SELECT 1 FROM pg_extension WHERE extname = 'pg_search'
       ) AS present`,
    );
    available = row?.present === true;
    if (available) {
      await db.exec(`DROP TABLE IF EXISTS messages_lexical`);
      await STEP.up(db);
    }
  }, 180_000);

  test("creates the table and both indexes", async () => {
    if (!available) {
      return;
    }
    const db = requireMainDb();
    const table = await db.get<{ present: boolean }>(
      `SELECT to_regclass('messages_lexical') IS NOT NULL AS present`,
    );
    expect(table?.present).toBe(true);
    const indexes = await db.all<{ indexname: string }>(
      `SELECT indexname FROM pg_indexes
       WHERE schemaname = current_schema() AND tablename = 'messages_lexical'
       ORDER BY indexname`,
    );
    expect(indexes.map((index) => index.indexname)).toEqual([
      "idx_messages_lexical_conversation_id",
      "messages_lexical_bm25",
      "messages_lexical_pkey",
    ]);
  }, 60_000);

  test("is idempotent: a second apply does not throw", async () => {
    if (!available || !STEP) {
      return;
    }
    const db = requireMainDb();
    await STEP.up(db);
    await STEP.up(db);
    expect(true).toBe(true);
  }, 60_000);

  test("upsert is keyed on message_id and delete removes the row", async () => {
    if (!available) {
      return;
    }
    const db = requireMainDb();
    await upsertMessagesLexicalBatch([
      {
        messageId: "mig-1",
        conversationId: "conv-1",
        createdAt: 1,
        body: "prima versione",
      },
    ]);
    await upsertMessagesLexicalBatch([
      {
        messageId: "mig-1",
        conversationId: "conv-1",
        createdAt: 1,
        body: "seconda versione",
      },
    ]);
    const rows = await db.all<{ body: string }>(
      `SELECT body FROM messages_lexical WHERE message_id = ?`,
      ["mig-1"],
    );
    expect(rows.map((row) => row.body)).toEqual(["seconda versione"]);

    await deleteMessageLexicalRow("mig-1");
    const after = await db.all(
      `SELECT 1 FROM messages_lexical WHERE message_id = ?`,
      ["mig-1"],
    );
    expect(after).toEqual([]);
  }, 60_000);
});
