/**
 * Read-path tests for {@link searchConversations} on the Postgres lexical
 * backend (`search.lexicalStore = "postgres"`).
 *
 * The response semantics must match the Qdrant path: content candidates are
 * capped on distinct visible conversations in score order, archived rows are
 * hidden unless `includeArchived`, title `LIKE` matches merge with content
 * matches, the final list is ordered by `updated_at` and limited, and excerpts
 * are built from the same extracted text the index carries. The excerpts come
 * from one batched query, not one per conversation.
 *
 * The Qdrant seam is mocked to return nothing, so a result can only come from
 * the Postgres table; the last test flips the flag back to `qdrant` and proves
 * the table is then ignored.
 *
 * Gated on a Postgres test database carrying `pg_search`.
 */
import { beforeAll, beforeEach, expect, mock, test } from "bun:test";

const searchMessageIdsLexicalMock = mock(
  async (): Promise<Array<{ messageId: string; score: number }>> => [],
);
const actualLexical = await import("../conversation-search-lexical.js");
mock.module("../conversation-search-lexical.js", () => ({
  ...actualLexical,
  searchMessageIdsLexical: searchMessageIdsLexicalMock,
}));

import { describePg } from "../../__tests__/pg-test-db.js";
import {
  invalidateConfigCache,
  loadRawConfig,
  saveRawConfig,
} from "../../config/loader.js";
import {
  LEXICAL_BACKFILL_COMPLETE_KEY,
  PG_LEXICAL_BACKFILL_COMPLETE_KEY,
  setMemoryCheckpoint,
} from "../checkpoints.js";
import { createConversation } from "../conversation-crud.js";
import { searchConversations } from "../conversation-queries.js";
import { requireMainDb } from "../db-facade.js";
import { upsertMessagesLexicalBatch } from "../message-lexical-store.js";
import { PG_STEPS } from "../pg-migrations/pg-steps.js";
import { runPgMigrations } from "../pg-migrations/run-pg-migrations.js";

const STEP = PG_STEPS.find((step) => step.name === "0005_messages_lexical");

/** Point `getConfigReadOnly().search.lexicalStore` at a backend. */
function setLexicalStore(store: "qdrant" | "dual" | "postgres"): void {
  const raw = loadRawConfig();
  const search =
    raw.search && typeof raw.search === "object"
      ? (raw.search as Record<string, unknown>)
      : {};
  saveRawConfig({ ...raw, search: { ...search, lexicalStore: store } });
  invalidateConfigCache();
}

async function resetTables(): Promise<void> {
  const db = requireMainDb();
  await db.run(`DELETE FROM messages_lexical`);
  await db.run(`DELETE FROM messages`);
  await db.run(`DELETE FROM conversations`);
}

async function insertMessage(
  id: string,
  conversationId: string,
  content: string,
  createdAt = 1000,
): Promise<void> {
  await requireMainDb().run(
    "INSERT INTO messages (id, conversation_id, role, content, created_at) VALUES (?, ?, ?, ?, ?)",
    [id, conversationId, "user", content, createdAt],
  );
}

async function insertLexical(
  messageId: string,
  conversationId: string,
  body: string,
  createdAt = 1000,
): Promise<void> {
  await upsertMessagesLexicalBatch([
    { messageId, conversationId, createdAt, body },
  ]);
}

async function setUpdatedAt(
  conversationId: string,
  updatedAt: number,
): Promise<void> {
  await requireMainDb().run(
    "UPDATE conversations SET updated_at = ? WHERE id = ?",
    [updatedAt, conversationId],
  );
}

async function archive(conversationId: string): Promise<void> {
  await requireMainDb().run(
    "UPDATE conversations SET archived_at = ? WHERE id = ?",
    [Date.now(), conversationId],
  );
}

async function setConversationType(
  conversationId: string,
  type: string,
): Promise<void> {
  await requireMainDb().run(
    "UPDATE conversations SET conversation_type = ? WHERE id = ?",
    [type, conversationId],
  );
}

describePg("searchConversations · postgres lexical index", () => {
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
      // The test bootstrap applies only the generated baseline; the ordered
      // steps are what add columns the ORM writes (`0002_alias_model_columns`)
      // and the lexical table (`0005_messages_lexical`).
      await runPgMigrations(db, PG_STEPS);
      await db.exec(`DROP TABLE IF EXISTS messages_lexical`);
      await STEP.up(db);
    }
  }, 180_000);

  beforeEach(async () => {
    if (!available) {
      return;
    }
    await resetTables();
    await setMemoryCheckpoint(PG_LEXICAL_BACKFILL_COMPLETE_KEY, "1");
    await setMemoryCheckpoint(LEXICAL_BACKFILL_COMPLETE_KEY, "1");
    setLexicalStore("postgres");
    searchMessageIdsLexicalMock.mockClear();
  }, 60_000);

  test("returns a content match with its message and a readable excerpt", async () => {
    if (!available) {
      return;
    }
    const conv = await createConversation("Fatture");
    await insertMessage(
      "m-1",
      conv.id,
      JSON.stringify([{ type: "text", text: "le fatture sono state pagate" }]),
    );
    await insertLexical("m-1", conv.id, "le fatture sono state pagate");

    const results = await searchConversations("fatture");

    expect(results.map((result) => result.conversationId)).toEqual([conv.id]);
    expect(results[0]!.matchingMessages.map((m) => m.messageId)).toEqual([
      "m-1",
    ]);
    expect(results[0]!.matchingMessages[0]!.excerpt).toContain("fatture");
  }, 60_000);

  test("hides archived conversations unless includeArchived is set", async () => {
    if (!available) {
      return;
    }
    const conv = await createConversation("Fatture");
    await insertMessage("m-1", conv.id, "fatture pagate");
    await insertLexical("m-1", conv.id, "fatture pagate");
    await archive(conv.id);

    expect(await searchConversations("fatture")).toEqual([]);

    const included = await searchConversations("fatture", {
      includeArchived: true,
    });
    expect(included.map((result) => result.conversationId)).toEqual([conv.id]);
  }, 60_000);

  test("excludes non-surfaced background conversations", async () => {
    if (!available) {
      return;
    }
    const conv = await createConversation("Fatture");
    await insertMessage("m-1", conv.id, "fatture pagate");
    await insertLexical("m-1", conv.id, "fatture pagate");
    await setConversationType(conv.id, "background");

    expect(await searchConversations("fatture")).toEqual([]);
  }, 60_000);

  test("merges title-only matches without content excerpts", async () => {
    if (!available) {
      return;
    }
    const conv = await createConversation("Backup settimanale");

    const results = await searchConversations("backup");

    expect(results.map((result) => result.conversationId)).toEqual([conv.id]);
    expect(results[0]!.matchingMessages).toEqual([]);
  }, 60_000);

  test("orders by updated_at and applies the limit", async () => {
    if (!available) {
      return;
    }
    const older = await createConversation("Vecchia");
    const newer = await createConversation("Nuova");
    await insertMessage("m-1", older.id, "fatture pagate");
    await insertLexical("m-1", older.id, "fatture pagate");
    await insertMessage("m-2", newer.id, "fatture emesse");
    await insertLexical("m-2", newer.id, "fatture emesse");
    await setUpdatedAt(older.id, 1_000);
    await setUpdatedAt(newer.id, 2_000);

    const results = await searchConversations("fatture", { limit: 1 });

    expect(results.map((result) => result.conversationId)).toEqual([newer.id]);
  }, 60_000);

  test("builds the excerpt from extracted text, not the stored JSON", async () => {
    if (!available) {
      return;
    }
    const conv = await createConversation("Salvataggi");
    await insertMessage(
      "m-1",
      conv.id,
      JSON.stringify([
        {
          type: "tool_result",
          tool_use_id: "call_1",
          content: "salvato nel knowledge base",
        },
      ]),
    );
    await insertLexical("m-1", conv.id, "salvato nel knowledge base");

    const results = await searchConversations("salvato");

    const excerpt = results[0]!.matchingMessages[0]!.excerpt;
    expect(excerpt).toContain("salvato");
    expect(excerpt).not.toContain("tool_use_id");
  }, 60_000);

  test("with lexicalStore = qdrant the Postgres table is not read", async () => {
    if (!available) {
      return;
    }
    // The title deliberately does not match the query, so the only way to
    // surface this conversation is through the content arm.
    const conv = await createConversation("Varie");
    await insertMessage("m-1", conv.id, "fatture pagate");
    await insertLexical("m-1", conv.id, "fatture pagate");
    setLexicalStore("qdrant");

    // The Qdrant seam is mocked to return no candidates and the title does not
    // match, so an empty result proves the Postgres table was not consulted.
    expect(await searchConversations("fatture")).toEqual([]);
  }, 60_000);
});
