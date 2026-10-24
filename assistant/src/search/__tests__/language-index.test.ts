/**
 * Database tests for the lazy per-language BM25 stores.
 *
 * Gated on a Postgres test database carrying `pg_search` (the BM25 index needs
 * the extension). Pins the contract the write path relies on: one table per
 * language (ParadeDB allows a single BM25 index per relation, so a partial
 * index alongside the agnostic one is impossible), built with that language's
 * Snowball stemmer, idempotent, and never created for a language ParadeDB has
 * no stemmer for.
 */
import { beforeAll, beforeEach, expect, test } from "bun:test";

import { describePg } from "../../__tests__/pg-test-db.js";
import { requireMainDb } from "../../persistence/db-facade.js";
import { PG_STEPS } from "../../persistence/pg-migrations/pg-steps.js";
import { runPgMigrations } from "../../persistence/pg-migrations/run-pg-migrations.js";
import {
  ensureLanguageIndex,
  ensureLanguageIndexes,
  hasLanguageIndex,
  languageIndexExists,
  languageIndexName,
  languageTableName,
  listLanguageCodes,
  resetLanguageIndexCacheForTests,
  stemmedLanguages,
} from "../language-index.js";

const STEP = PG_STEPS.find((step) => step.name === "0005_messages_lexical");

describePg("language stores", () => {
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
      await STEP.up(db);
    }
  }, 180_000);

  beforeEach(async () => {
    if (!available) {
      return;
    }
    const db = requireMainDb();
    for (const code of ["it", "en", "et"]) {
      await db.exec(`DROP TABLE IF EXISTS "${languageTableName(code)}"`);
    }
    resetLanguageIndexCacheForTests();
  }, 60_000);

  test("creates a table with the language stemmer in its BM25 index", async () => {
    if (!available) {
      return;
    }
    expect(await ensureLanguageIndex("it")).toBe(true);

    const db = requireMainDb();
    const row = await db.get<{ indexdef: string }>(
      `SELECT indexdef FROM pg_indexes
       WHERE schemaname = current_schema() AND indexname = ?`,
      [languageIndexName("it")],
    );
    expect(row?.indexdef).toContain("USING bm25");
    expect(row?.indexdef).toContain("stemmer=italian");
    // One BM25 index per relation is a ParadeDB constraint, so the language
    // index is unconditional: the table itself is the language filter.
    expect(row?.indexdef).not.toContain("WHERE");

    const columns = await db.all<{ column_name: string }>(
      `SELECT column_name FROM information_schema.columns
       WHERE table_schema = current_schema() AND table_name = ?
       ORDER BY ordinal_position`,
      [languageTableName("it")],
    );
    expect(columns.map((column) => column.column_name)).toEqual([
      "message_id",
      "conversation_id",
      "body",
    ]);

    // The agnostic table keeps its own single BM25 index.
    const agnostic = await db.get<{ indexdef: string }>(
      `SELECT indexdef FROM pg_indexes
       WHERE schemaname = current_schema() AND indexname = 'messages_lexical_bm25'`,
    );
    expect(agnostic?.indexdef).toContain("USING bm25");
  });

  test("is idempotent", async () => {
    if (!available) {
      return;
    }
    expect(await ensureLanguageIndex("it")).toBe(true);
    resetLanguageIndexCacheForTests();
    expect(await ensureLanguageIndex("it")).toBe(true);
    await ensureLanguageIndexes(["it", "it"]);
    expect(await languageIndexExists("it")).toBe(true);
  });

  test("reports whether a store exists", async () => {
    if (!available) {
      return;
    }
    expect(await languageIndexExists("it")).toBe(false);
    await ensureLanguageIndex("it");
    resetLanguageIndexCacheForTests();
    expect(await languageIndexExists("it")).toBe(true);
  });

  test("lists the existing language stores only", async () => {
    if (!available) {
      return;
    }
    await ensureLanguageIndex("it");
    await ensureLanguageIndex("en");
    expect((await listLanguageCodes()).sort()).toEqual(["en", "it"]);
  });

  test("estonian has no stemmer, so it gets no store", async () => {
    if (!available) {
      return;
    }
    expect(hasLanguageIndex("et")).toBe(false);
    expect(await ensureLanguageIndex("et")).toBe(false);
    expect(await languageIndexExists("et")).toBe(false);
    const db = requireMainDb();
    const row = await db.get<{ present: boolean }>(
      `SELECT to_regclass(?) IS NOT NULL AS present`,
      [languageTableName("et")],
    );
    expect(row?.present).toBe(false);
  });

  test("covers the eleven stemmed languages", () => {
    expect(stemmedLanguages().sort()).toEqual([
      "da",
      "de",
      "en",
      "es",
      "fr",
      "it",
      "nl",
      "pl",
      "pt",
      "ro",
      "sv",
    ]);
  });
});
