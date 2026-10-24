/**
 * Read-path tests for {@link searchConversations} on the Postgres lexical
 * backend (`search.lexicalStore = "postgres"`).
 *
 * The response shape and filtering semantics match the Qdrant path: content
 * candidates are capped on distinct visible conversations in score order,
 * archived rows are hidden unless `includeArchived`, title `LIKE` matches merge
 * with content matches, and excerpts are built from the same extracted text the
 * index carries. Ordering is the Postgres-specific part: relevance first (BM25
 * score, `updated_at` as tie-break, title-only matches last), where the Qdrant
 * path keeps `updated_at`. The excerpts come from one batched query, not one
 * per conversation.
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
  language: string | null = null,
): Promise<void> {
  await upsertMessagesLexicalBatch([
    { messageId, conversationId, createdAt, body, language },
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

  test("breaks score ties by updated_at and applies the limit after ordering", async () => {
    if (!available) {
      return;
    }
    // Both bodies carry one `fatture` in a two-token message, so the BM25
    // scores tie and `updated_at` decides.
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

  test("a strong content match outranks a weak but more recent one", async () => {
    if (!available) {
      return;
    }
    // Strong: the term repeated in a short message. Weak: the term once inside
    // a much longer message. The strong match is the older conversation, so a
    // recency ordering would put it second.
    const strongOld = await createConversation("Alfa");
    const weakNew = await createConversation("Beta");
    const strongBody = "fatture fatture fatture fatture fatture";
    const weakBody = `fatture ${"riempimento ".repeat(60).trim()}`;
    await insertMessage("m-strong", strongOld.id, strongBody);
    await insertLexical("m-strong", strongOld.id, strongBody);
    await insertMessage("m-weak", weakNew.id, weakBody);
    await insertLexical("m-weak", weakNew.id, weakBody);
    await setUpdatedAt(strongOld.id, 1_000);
    await setUpdatedAt(weakNew.id, 5_000);

    const results = await searchConversations("fatture");

    expect(results.map((result) => result.conversationId)).toEqual([
      strongOld.id,
      weakNew.id,
    ]);
  }, 60_000);

  test("places title-only matches after content matches regardless of recency", async () => {
    if (!available) {
      return;
    }
    const content = await createConversation("Varie");
    const titleOnly = await createConversation("Fatture 2026");
    await insertMessage("m-1", content.id, "fatture pagate");
    await insertLexical("m-1", content.id, "fatture pagate");
    await setUpdatedAt(content.id, 1_000);
    await setUpdatedAt(titleOnly.id, 9_000);

    const results = await searchConversations("fatture");

    expect(results.map((result) => result.conversationId)).toEqual([
      content.id,
      titleOnly.id,
    ]);
    expect(results[1]!.matchingMessages).toEqual([]);
  }, 60_000);

  test("applies the limit after relevance ordering", async () => {
    if (!available) {
      return;
    }
    // Same shape as the strong-vs-weak case: the older conversation has the
    // stronger match, so a `limit: 1` that cut before ordering would keep the
    // newer, weaker one instead.
    const strongOld = await createConversation("Alfa");
    const weakNew = await createConversation("Beta");
    const strongBody = "fatture fatture fatture fatture fatture";
    const weakBody = `fatture ${"riempimento ".repeat(60).trim()}`;
    await insertMessage("m-strong", strongOld.id, strongBody);
    await insertLexical("m-strong", strongOld.id, strongBody);
    await insertMessage("m-weak", weakNew.id, weakBody);
    await insertLexical("m-weak", weakNew.id, weakBody);
    await setUpdatedAt(strongOld.id, 1_000);
    await setUpdatedAt(weakNew.id, 5_000);

    const results = await searchConversations("fatture", { limit: 1 });

    expect(results.map((result) => result.conversationId)).toEqual([
      strongOld.id,
    ]);
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

  test("defaults to conjunction: every token must appear in a message", async () => {
    if (!available) {
      return;
    }
    const both = await createConversation("Alpha");
    const onlyFirst = await createConversation("Beta");
    const onlySecond = await createConversation("Gamma");
    await insertMessage("m-1", both.id, "fatture non pagate");
    await insertLexical("m-1", both.id, "fatture non pagate");
    await insertMessage("m-2", onlyFirst.id, "fatture emesse");
    await insertLexical("m-2", onlyFirst.id, "fatture emesse");
    await insertMessage("m-3", onlySecond.id, "le tasse sono pagate");
    await insertLexical("m-3", onlySecond.id, "le tasse sono pagate");

    const results = await searchConversations("fatture pagate");

    expect(results.map((result) => result.conversationId)).toEqual([both.id]);
  }, 60_000);

  test("match: all is the explicit form of the default", async () => {
    if (!available) {
      return;
    }
    const both = await createConversation("Alpha");
    const onlyFirst = await createConversation("Beta");
    await insertMessage("m-1", both.id, "fatture non pagate");
    await insertLexical("m-1", both.id, "fatture non pagate");
    await insertMessage("m-2", onlyFirst.id, "fatture emesse");
    await insertLexical("m-2", onlyFirst.id, "fatture emesse");

    const results = await searchConversations("fatture pagate", {
      match: "all",
    });

    expect(results.map((result) => result.conversationId)).toEqual([both.id]);
  }, 60_000);

  test("match: any accepts messages carrying any token", async () => {
    if (!available) {
      return;
    }
    const both = await createConversation("Alpha");
    const onlyFirst = await createConversation("Beta");
    const onlySecond = await createConversation("Gamma");
    await insertMessage("m-1", both.id, "fatture non pagate");
    await insertLexical("m-1", both.id, "fatture non pagate");
    await insertMessage("m-2", onlyFirst.id, "fatture emesse");
    await insertLexical("m-2", onlyFirst.id, "fatture emesse");
    await insertMessage("m-3", onlySecond.id, "le tasse sono pagate");
    await insertLexical("m-3", onlySecond.id, "le tasse sono pagate");

    const results = await searchConversations("fatture pagate", {
      match: "any",
    });

    expect(results.map((result) => result.conversationId).sort()).toEqual(
      [both.id, onlyFirst.id, onlySecond.id].sort(),
    );
  }, 60_000);

  test("a single-token query returns the same set under both modes", async () => {
    if (!available) {
      return;
    }
    const first = await createConversation("Alpha");
    const second = await createConversation("Beta");
    await insertMessage("m-1", first.id, "fatture pagate");
    await insertLexical("m-1", first.id, "fatture pagate");
    await insertMessage("m-2", second.id, "fatture emesse");
    await insertLexical("m-2", second.id, "fatture emesse");

    const all = await searchConversations("fatture", { match: "all" });
    const any = await searchConversations("fatture", { match: "any" });

    expect(all.map((result) => result.conversationId).sort()).toEqual(
      [first.id, second.id].sort(),
    );
    expect(any.map((result) => result.conversationId).sort()).toEqual(
      all.map((result) => result.conversationId).sort(),
    );
  }, 60_000);
});
