/**
 * Database tests for the language lane of {@link searchConversations}.
 *
 * The agnostic index has no stemmer, so `fattura` does not match `fatture`.
 * The language store of the message's language does, and the two lanes are
 * fused with reciprocal rank fusion. These tests drive the real route against
 * a Postgres test database carrying `pg_search`, with the native detector
 * replaced by a fake so each gate can be exercised on its own.
 *
 * The Qdrant seam is mocked to return nothing, so every result comes from the
 * Postgres tables.
 */
import { afterEach, beforeAll, beforeEach, expect, mock, test } from "bun:test";

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
  type LanguageDetector,
  setLanguageDetectorForTests,
} from "../../search/language-detector.js";
import {
  resetLanguageIndexCacheForTests,
  upsertLanguageRows,
} from "../../search/language-index.js";
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

/** A detector that answers `code` for every text, and honors the floor. */
function detectorReturning(code: string | null): LanguageDetector {
  return {
    supportedLanguages: () => ["it", "en", "et"],
    detectWithMinDistance: (_text: string, minimum: number) =>
      minimum > 0.2 ? null : code,
    detectBatch: (texts: readonly string[]) => texts.map(() => code),
  };
}

/** Point `getConfigReadOnly().search` at the Postgres backend and a language setup. */
function setSearchConfig(search: {
  languages?: string[];
  queryMinRelativeDistance?: number;
}): void {
  const raw = loadRawConfig();
  const current =
    raw.search && typeof raw.search === "object"
      ? (raw.search as Record<string, unknown>)
      : {};
  saveRawConfig({
    ...raw,
    search: {
      ...current,
      lexicalStore: "postgres",
      languages: search.languages ?? [],
      queryMinRelativeDistance: search.queryMinRelativeDistance ?? 0.1,
    },
  });
  invalidateConfigCache();
}

async function resetTables(): Promise<void> {
  const db = requireMainDb();
  await db.run(`DELETE FROM messages_lexical`);
  for (const code of ["it", "en", "et"]) {
    await db.run(`DELETE FROM "messages_lexical_${code}"`).catch(() => 0);
  }
  await db.run(`DELETE FROM messages`);
  await db.run(`DELETE FROM conversations`);
}

async function insertMessage(
  id: string,
  conversationId: string,
  text: string,
  createdAt = 1000,
): Promise<void> {
  await requireMainDb().run(
    "INSERT INTO messages (id, conversation_id, role, content, created_at) VALUES (?, ?, ?, ?, ?)",
    [id, conversationId, "user", text, createdAt],
  );
}

/** Seed one message in the agnostic table and, when it has a language, its copy. */
async function indexMessage(
  messageId: string,
  conversationId: string,
  body: string,
  language: string | null,
  createdAt = 1000,
): Promise<void> {
  const row = { messageId, conversationId, body, createdAt, language };
  await upsertMessagesLexicalBatch([row]);
  await upsertLanguageRows([row]);
}

describePg("searchConversations · language lane", () => {
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
      await runPgMigrations(db, PG_STEPS);
      await db.exec(`DROP TABLE IF EXISTS messages_lexical`);
      await db.exec(`DROP TABLE IF EXISTS messages_lexical_it`);
      await db.exec(`DROP TABLE IF EXISTS messages_lexical_en`);
      await STEP.up(db);
    }
  }, 180_000);

  beforeEach(async () => {
    if (!available) {
      return;
    }
    resetLanguageIndexCacheForTests();
    await resetTables();
    await setMemoryCheckpoint(PG_LEXICAL_BACKFILL_COMPLETE_KEY, "1");
    await setMemoryCheckpoint(LEXICAL_BACKFILL_COMPLETE_KEY, "1");
    setSearchConfig({});
    searchMessageIdsLexicalMock.mockClear();
  }, 60_000);

  afterEach(() => {
    setLanguageDetectorForTests(null);
  });

  test("the language lane finds a morphological variant the agnostic index misses", async () => {
    if (!available) {
      return;
    }
    const conv = await createConversation("Fatture");
    await insertMessage("m-1", conv.id, "le fatture sono state pagate");
    await indexMessage("m-1", conv.id, "le fatture sono state pagate", "it");

    // No detector: the agnostic index has no stemmer, so `fattura` misses.
    expect(await searchConversations("fattura")).toEqual([]);

    setLanguageDetectorForTests(detectorReturning("it"));
    const results = await searchConversations("fattura");
    expect(results.map((result) => result.conversationId)).toEqual([conv.id]);
    expect(results[0]!.matchingMessages.map((m) => m.messageId)).toEqual([
      "m-1",
    ]);
  });

  test("fuses the lanes by rank, so a conversation matching both outranks a language-only match", async () => {
    if (!available) {
      return;
    }
    const both = await createConversation("Fattura esatta");
    const languageOnly = await createConversation("Solo plurale");
    await insertMessage("m-1", both.id, "fattura pagata", 1000);
    await indexMessage("m-1", both.id, "fattura pagata", "it", 1000);
    await insertMessage("m-2", languageOnly.id, "le fatture", 2000);
    await indexMessage("m-2", languageOnly.id, "le fatture", "it", 2000);

    setLanguageDetectorForTests(detectorReturning("it"));
    const results = await searchConversations("fattura", { limit: 5 });

    expect(results.map((result) => result.conversationId)).toEqual([
      both.id,
      languageOnly.id,
    ]);
  });

  test("a detected language outside search.languages keeps the agnostic lane only", async () => {
    if (!available) {
      return;
    }
    setSearchConfig({ languages: ["en"] });
    const conv = await createConversation("Fatture");
    await insertMessage("m-1", conv.id, "le fatture sono state pagate");
    await indexMessage("m-1", conv.id, "le fatture sono state pagate", "it");

    setLanguageDetectorForTests(detectorReturning("it"));
    expect(await searchConversations("fattura")).toEqual([]);
  });

  test("a language without a store keeps the agnostic lane only", async () => {
    if (!available) {
      return;
    }
    const conv = await createConversation("Fatture");
    await insertMessage("m-1", conv.id, "le fatture sono state pagate");
    await indexMessage("m-1", conv.id, "le fatture sono state pagate", "et");

    setLanguageDetectorForTests(detectorReturning("et"));
    expect(await searchConversations("fattura")).toEqual([]);
  });

  test("a query below the confidence floor keeps the agnostic lane only", async () => {
    if (!available) {
      return;
    }
    const conv = await createConversation("Fatture");
    await insertMessage("m-1", conv.id, "le fatture sono state pagate");
    await indexMessage("m-1", conv.id, "le fatture sono state pagate", "it");
    setLanguageDetectorForTests(detectorReturning("it"));

    setSearchConfig({ queryMinRelativeDistance: 0.5 });
    expect(await searchConversations("fattura")).toEqual([]);

    setSearchConfig({ queryMinRelativeDistance: 0.1 });
    expect((await searchConversations("fattura")).length).toBe(1);
  });

  test("the agnostic lane still answers a query the language store does not cover", async () => {
    if (!available) {
      return;
    }
    const italian = await createConversation("Fatture");
    const english = await createConversation("Invoices");
    await insertMessage("m-1", italian.id, "le fatture sono state pagate");
    await indexMessage("m-1", italian.id, "le fatture sono state pagate", "it");
    await insertMessage("m-2", english.id, "the invoice was paid");
    await indexMessage("m-2", english.id, "the invoice was paid", "en");

    setLanguageDetectorForTests(detectorReturning("it"));
    // "invoice" is in the agnostic index of the English row, and the Italian
    // store does not carry it: the agnostic lane alone must find it.
    const results = await searchConversations("invoice");
    expect(results.map((result) => result.conversationId)).toEqual([
      english.id,
    ]);
  });
});
