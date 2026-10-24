/**
 * The language lane: one BM25 store per language.
 *
 * Every message is indexed in the language-agnostic `messages_lexical` table.
 * A message whose detected language also has a language store is additionally
 * written to `messages_lexical_<code>`, whose BM25 index is built with that
 * language's Snowball stemmer, so morphology collapses
 * (`fattura`/`fatture`) and accented text matches an unaccented query.
 *
 * Each language gets its own TABLE, not a partial index on the shared one:
 * ParadeDB 0.26.3 refuses a second BM25 index on a relation
 * (`a relation may only have one ParadeDB index`), partial or not, so the
 * agnostic index and a per-language index cannot coexist on one table.
 * Separate tables keep one BM25 index per relation and leave the agnostic
 * table untouched.
 *
 * Stores are created LAZILY: a language gets its table the first time it
 * appears in the data, never as a pre-created set. When `search.languages` is
 * non-empty it is the detector's candidate set, so a language outside the list
 * can never be detected and therefore never gets a store. `estonian` has no
 * stemmer in ParadeDB 0.26.3, so `et` deliberately gets no store and its
 * messages stay agnostic-only.
 *
 * Creation is idempotent and safe across processes (the daemon and the memory
 * job worker both write): a transaction-scoped advisory lock serializes the
 * create, and the names are derived from the language code.
 */

import type { AssistantConfig } from "../config/types.js";
import { requireMainDb } from "../persistence/db-facade.js";
import { getLogger } from "../util/logger.js";
import {
  detectDocumentLanguage,
  supportedLanguages,
} from "./language-detector.js";

const log = getLogger("language-index");

/**
 * ISO 639-1 code -> ParadeDB stemmer name. The values are the Snowball
 * stemmers `pg_search` exposes; a language missing here cannot get a language
 * store (ParadeDB rejects the name).
 */
const LANGUAGE_STEMMERS: Readonly<Record<string, string>> = {
  it: "italian",
  en: "english",
  fr: "french",
  de: "german",
  es: "spanish",
  pt: "portuguese",
  nl: "dutch",
  pl: "polish",
  ro: "romanian",
  sv: "swedish",
  da: "danish",
};

/** ISO 639-1 shape. The code is interpolated into DDL, so it is checked. */
const LANGUAGE_CODE = /^[a-z]{2}$/;

/** Rows per multi-row INSERT into a language store. */
const UPSERT_BATCH_SIZE = 200;

/** Stores this process knows to exist (a table never disappears on its own). */
const knownStores = new Set<string>();

/** In-flight creations, so concurrent callers share one DDL run. */
const inFlight = new Map<string, Promise<boolean>>();

/** A row of the shared agnostic table, as the write paths produce it. */
export interface LanguageStoreRow {
  messageId: string;
  conversationId: string;
  body: string;
  language: string | null;
}

/**
 * Normalize a configured language list: trim, lowercase, drop blanks, dedupe.
 * An empty result means "no restriction".
 */
export function normalizeLanguageCodes(codes: readonly string[]): string[] {
  const normalized = new Set<string>();
  for (const raw of codes) {
    const code = raw.trim().toLowerCase();
    if (code.length > 0) {
      normalized.add(code);
    }
  }
  return [...normalized];
}

/** The languages that can get a language store (i.e. have a stemmer). */
export function stemmedLanguages(): string[] {
  return Object.keys(LANGUAGE_STEMMERS);
}

/** Whether `code` gets a language store. `et` does not: ParadeDB has no stemmer. */
export function hasLanguageIndex(code: string): boolean {
  return Object.hasOwn(LANGUAGE_STEMMERS, code);
}

/** The table backing a language code. */
export function languageTableName(code: string): string {
  return `messages_lexical_${code}`;
}

/** The BM25 index of a language code's table. */
export function languageIndexName(code: string): string {
  return `${languageTableName(code)}_bm25`;
}

/**
 * Refuse a configuration that names a language the detector cannot detect.
 *
 * The list is the user's declared search languages; a language the addon was
 * not compiled with can never be detected, so accepting it would silently
 * disable the feature for that language. Startup fails instead.
 *
 * When the addon itself is unavailable there is nothing to validate against:
 * that is the one declared degradation (search stays agnostic) and it is
 * logged, not thrown, so a missing addon never blocks the daemon.
 */
export function assertSearchLanguageConfiguration(
  config: AssistantConfig,
): void {
  const configured = normalizeLanguageCodes(config.search.languages);
  if (configured.length === 0) {
    return;
  }
  const supported = supportedLanguages();
  if (supported.length === 0) {
    log.error(
      { configured },
      "search.languages is set but the language detector is unavailable, message search stays language-agnostic",
    );
    return;
  }
  const supportedSet = new Set(supported);
  const invalid = configured.filter(
    (code) => !LANGUAGE_CODE.test(code) || !supportedSet.has(code),
  );
  if (invalid.length > 0) {
    throw new Error(
      `search.languages declares unsupported language(s): ${invalid.join(", ")}. ` +
        `The language detector was compiled with: ${[...supported].sort().join(", ")}. ` +
        `Fix search.languages, or rebuild the detector with the language included.`,
    );
  }
  const withoutStemmer = configured.filter((code) => !hasLanguageIndex(code));
  if (withoutStemmer.length > 0) {
    log.warn(
      { languages: withoutStemmer },
      "search.languages names a language with no BM25 stemmer, its messages stay in the language-agnostic index",
    );
  }
}

/**
 * The candidate set handed to the detector: the configured languages,
 * normalized. An empty result means "no restriction" (every compiled
 * language), which is the shipped behavior.
 *
 * This is the list's PRIMARY effect. The downstream filter in
 * {@link resolveIndexLanguage} is the defense: it also drops a code with no
 * stemmer, and a code an older addon returned because it had no candidate-set
 * entry point.
 */
export function searchLanguageCandidates(config: AssistantConfig): string[] {
  return normalizeLanguageCodes(config.search.languages);
}

/**
 * The language to store on an indexed row, or `null` for agnostic-only.
 *
 * `null` covers three cases, all intentional: the detector is unavailable, no
 * language cleared the confidence floor, or the detected language is outside
 * the configured list / has no store. The indexed body is never affected.
 */
export function languageForIndexing(
  text: string,
  config: AssistantConfig,
): string | null {
  return resolveIndexLanguage(
    detectDocumentLanguage(text, searchLanguageCandidates(config)),
    config,
  );
}

/**
 * Apply the configured language list and the stemmer constraint to an already
 * detected code. Shared by the single-message write path and the batch
 * backfill, which detects the whole batch at once.
 *
 * The list already reached the detector as its candidate set; this filter is
 * the defense that keeps a code without a store out of the column.
 */
export function resolveIndexLanguage(
  code: string | null,
  config: AssistantConfig,
): string | null {
  if (!code) {
    return null;
  }
  const configured = normalizeLanguageCodes(config.search.languages);
  if (configured.length > 0 && !configured.includes(code)) {
    return null;
  }
  return hasLanguageIndex(code) ? code : null;
}

/** Whether a language's table and its BM25 index exist in the current schema. */
export async function languageIndexExists(code: string): Promise<boolean> {
  if (!hasLanguageIndex(code)) {
    return false;
  }
  if (knownStores.has(code)) {
    return true;
  }
  const db = requireMainDb();
  const row = await db.get<{ present: boolean }>(
    `SELECT to_regclass(?) IS NOT NULL AND to_regclass(?) IS NOT NULL AS present`,
    [languageTableName(code), languageIndexName(code)],
  );
  if (row?.present === true) {
    knownStores.add(code);
    return true;
  }
  return false;
}

/** Every language whose store exists in the current schema. */
export async function listLanguageCodes(): Promise<string[]> {
  const db = requireMainDb();
  const rows = await db.all<{ code: string }>(
    `SELECT substring(c.relname from char_length('messages_lexical_') + 1) AS code
     FROM pg_class c
     JOIN pg_namespace n ON n.oid = c.relnamespace
     WHERE n.nspname = current_schema()
       AND c.relkind = 'r'
       AND c.relname ~ '^messages_lexical_[a-z]{2}$'`,
  );
  return rows.map((row) => row.code).filter((code) => hasLanguageIndex(code));
}

/**
 * Create a language store if it does not exist yet: the table, its
 * conversation index for purges, and its BM25 index.
 *
 * Idempotent: every statement is `IF NOT EXISTS` and the sequence runs under a
 * transaction-scoped advisory lock, so two processes racing the first message
 * of a language produce one store and one no-op. Returns whether the store
 * exists afterwards.
 */
export function ensureLanguageIndex(code: string): Promise<boolean> {
  if (!hasLanguageIndex(code)) {
    return Promise.resolve(false);
  }
  const pending = inFlight.get(code);
  if (pending) {
    return pending;
  }
  const promise = createLanguageStore(code).finally(() => {
    inFlight.delete(code);
  });
  inFlight.set(code, promise);
  return promise;
}

/** Ensure every language in `codes` has its store. */
export async function ensureLanguageIndexes(
  codes: Iterable<string>,
): Promise<void> {
  for (const code of new Set(codes)) {
    try {
      await ensureLanguageIndex(code);
    } catch (err) {
      // Store creation is an optimization: the rows are already in the
      // agnostic table, so a failure degrades to agnostic-only for that
      // language instead of failing the indexing job.
      log.warn({ err, code }, "Failed to create language store");
    }
  }
}

async function createLanguageStore(code: string): Promise<boolean> {
  const stemmer = LANGUAGE_STEMMERS[code];
  if (!LANGUAGE_CODE.test(code) || stemmer === undefined) {
    throw new Error(`No language store for "${code}"`);
  }
  if (knownStores.has(code)) {
    return true;
  }
  const table = languageTableName(code);
  const index = languageIndexName(code);
  const db = requireMainDb();
  const created = await db.transaction(async (tx) => {
    // One creator per store across processes. A caller that loses the race
    // returns immediately: the winner's commit makes the store visible, and a
    // later message retries.
    const lock = await tx.get<{ locked: boolean }>(
      `SELECT pg_try_advisory_xact_lock(hashtext(?)::bigint) AS locked`,
      [table],
    );
    if (lock?.locked !== true) {
      return false;
    }
    const present = await tx.get<{ present: boolean }>(
      `SELECT to_regclass(?) IS NOT NULL AND to_regclass(?) IS NOT NULL AS present`,
      [table, index],
    );
    if (present?.present === true) {
      return true;
    }
    await tx.exec(
      `CREATE TABLE IF NOT EXISTS "${table}" (
         "message_id" text PRIMARY KEY,
         "conversation_id" text NOT NULL,
         "body" text NOT NULL
       )`,
    );
    await tx.exec(
      `CREATE INDEX IF NOT EXISTS "${table}_conversation_id" ON "${table}" ("conversation_id")`,
    );
    await tx.exec(
      `CREATE INDEX IF NOT EXISTS "${index}"
         ON "${table}" USING bm25 ("message_id", ("body"::pdb.icu('stemmer=${stemmer}')))`,
    );
    return true;
  });
  if (created) {
    knownStores.add(code);
    return true;
  }
  // A lost advisory-lock race leaves the winner's store uncommitted at this
  // instant; report the honest answer and let the next write retry.
  return languageIndexExists(code);
}

/**
 * Write the language copies of a batch: one multi-row upsert per language.
 *
 * Rows without a language (or with a language that has no store) are skipped:
 * they live only in the agnostic table, which is always written separately by
 * the caller.
 */
export async function upsertLanguageRows(
  rows: readonly LanguageStoreRow[],
): Promise<void> {
  const byLanguage = new Map<string, LanguageStoreRow[]>();
  for (const row of rows) {
    const code = row.language;
    if (!code || row.body.length === 0 || !hasLanguageIndex(code)) {
      continue;
    }
    const group = byLanguage.get(code) ?? [];
    group.push(row);
    byLanguage.set(code, group);
  }
  const db = requireMainDb();
  for (const [code, group] of byLanguage) {
    if (!(await ensureLanguageIndex(code))) {
      continue;
    }
    const table = languageTableName(code);
    for (let start = 0; start < group.length; start += UPSERT_BATCH_SIZE) {
      const chunk = group.slice(start, start + UPSERT_BATCH_SIZE);
      const placeholders = chunk.map(() => "(?, ?, ?)").join(", ");
      const params: string[] = [];
      for (const row of chunk) {
        params.push(row.messageId, row.conversationId, row.body);
      }
      await db.run(
        `INSERT INTO "${table}" ("message_id", "conversation_id", "body")
         VALUES ${placeholders}
         ON CONFLICT ("message_id") DO UPDATE SET
           "conversation_id" = EXCLUDED."conversation_id",
           "body" = EXCLUDED."body"`,
        params,
      );
    }
  }
}

/** Remove one message from every language store. */
export async function deleteLanguageRow(messageId: string): Promise<void> {
  const db = requireMainDb();
  for (const code of await listLanguageCodes()) {
    await db.run(
      `DELETE FROM "${languageTableName(code)}" WHERE "message_id" = ?`,
      [messageId],
    );
  }
}

/** Remove a conversation from every language store. */
export async function purgeLanguageRows(conversationId: string): Promise<void> {
  const db = requireMainDb();
  for (const code of await listLanguageCodes()) {
    await db.run(
      `DELETE FROM "${languageTableName(code)}" WHERE "conversation_id" = ?`,
      [conversationId],
    );
  }
}

/** Empty every language store. */
export async function clearLanguageRows(): Promise<void> {
  const db = requireMainDb();
  for (const code of await listLanguageCodes()) {
    await db.run(`DELETE FROM "${languageTableName(code)}"`);
  }
}

/** Test seam: forget which stores this process has seen. */
export function resetLanguageIndexCacheForTests(): void {
  knownStores.clear();
  inFlight.clear();
}
