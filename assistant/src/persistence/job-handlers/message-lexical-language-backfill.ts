/**
 * One-time backfill of the `language` column on `messages_lexical`.
 *
 * Rows indexed before the language lane existed carry `language = NULL` and are
 * only searchable in the language-agnostic index. This pass fills the column
 * from the text already stored in the table: no re-extraction, no re-encode,
 * in small cursor-checkpointed batches off the event loop, then creates the
 * language indexes for whatever it found.
 *
 * A row whose detection returns `null` (or whose language has no stemmer) stays
 * `NULL` and is never revisited: the cursor moves past it, because "no language
 * index" is a terminal answer, not a retryable failure.
 *
 * Runs only when the Postgres lexical table is the read source and the
 * detector is available; otherwise it completes immediately with nothing to do.
 */
import { getConfigReadOnly } from "../../config/loader.js";
import type { AssistantConfig } from "../../config/types.js";
import {
  detectDocumentLanguages,
  getLanguageDetector,
} from "../../search/language-detector.js";
import {
  type LanguageStoreRow,
  resolveIndexLanguage,
  searchLanguageCandidates,
  upsertLanguageRows,
} from "../../search/language-index.js";
import { getLogger } from "../../util/logger.js";
import {
  deleteMemoryCheckpoint,
  getMemoryCheckpoint,
  setMemoryCheckpoint,
} from "../checkpoints.js";
import { requireMainDb } from "../db-facade.js";
import {
  enqueueMemoryJob,
  hasActiveJobOfType,
  type MemoryJob,
} from "../jobs-store.js";
import { writesPostgres } from "./message-lexical.js";

const log = getLogger("lexical-language-backfill");

/** Completion sentinel: the whole table has a language decision. */
export const LANGUAGE_BACKFILL_COMPLETE_KEY =
  "lexical:pg:languages:backfill_complete";

/** Cursor: the last `message_id` this pass looked at. */
const LANGUAGE_BACKFILL_CURSOR_KEY = "lexical:pg:languages:last_id";

/** Rows detected per job invocation before the job re-enqueues itself. */
const BATCH_SIZE = 200;

/** True once the language column has been backfilled on this instance. */
export async function isLanguageBackfillComplete(): Promise<boolean> {
  return (await getMemoryCheckpoint(LANGUAGE_BACKFILL_COMPLETE_KEY)) === "1";
}

/** Clear the sentinel so the next startup re-arms the pass. */
export async function clearLanguageBackfillComplete(): Promise<void> {
  await deleteMemoryCheckpoint(LANGUAGE_BACKFILL_COMPLETE_KEY);
}

/**
 * One-time auto-enqueue of the language backfill, called from daemon startup
 * next to the lexical backfill.
 *
 * Enqueue-only: no detection, no I/O on the boot thread. Guards are the same
 * shape as {@link maybeEnqueueLexicalBackfillOnUpgrade}: the sentinel must be
 * unset, no run may be in flight, and the work must be meaningful (Postgres is
 * the read source and the detector loaded).
 */
export async function maybeEnqueueLanguageBackfillOnUpgrade(): Promise<void> {
  try {
    const config = getConfigReadOnly();
    if (!writesPostgres(config.search.lexicalStore)) {
      return;
    }
    if (getLanguageDetector() === null) {
      return;
    }
    if (await isLanguageBackfillComplete()) {
      return;
    }
    if (await hasActiveJobOfType("backfill_lexical_languages")) {
      return;
    }
    const jobId = enqueueMemoryJob("backfill_lexical_languages", {});
    log.info(
      { jobId },
      "Enqueued one-time messages lexical language backfill on startup",
    );
  } catch (err) {
    log.warn(
      { err },
      "Failed to enqueue startup lexical language backfill (non-fatal)",
    );
  }
}

/**
 * Fill `language` for the next {@link BATCH_SIZE} rows that lack one, advance
 * the cursor, and re-enqueue while batches stay full.
 */
export async function backfillLexicalLanguagesJob(
  job: MemoryJob,
  config: AssistantConfig,
): Promise<void> {
  if (!writesPostgres(config.search.lexicalStore)) {
    return;
  }
  if (getLanguageDetector() === null) {
    // Nothing to detect with. The column stays NULL and search stays
    // agnostic; the sentinel is deliberately not set so a later boot with a
    // working addon retries.
    return;
  }

  const force = job.payload.force === true;
  if (force) {
    await deleteMemoryCheckpoint(LANGUAGE_BACKFILL_CURSOR_KEY);
    await clearLanguageBackfillComplete();
  }

  const db = requireMainDb();
  const cursor =
    (await getMemoryCheckpoint(LANGUAGE_BACKFILL_CURSOR_KEY)) ?? "";
  const batch = await db.all<{
    message_id: string;
    conversation_id: string;
    body: string;
  }>(
    `SELECT "message_id", "conversation_id", "body" FROM "messages_lexical"
     WHERE "message_id" > ? AND "language" IS NULL
     ORDER BY "message_id"
     LIMIT ?`,
    [cursor, BATCH_SIZE],
  );

  if (batch.length === 0) {
    await setMemoryCheckpoint(LANGUAGE_BACKFILL_COMPLETE_KEY, "1");
    return;
  }

  const detected = detectDocumentLanguages(
    batch.map((row) => row.body),
    searchLanguageCandidates(config),
  );
  const idsByLanguage = new Map<string, string[]>();
  const languageRows: LanguageStoreRow[] = [];
  for (let index = 0; index < batch.length; index++) {
    const code = resolveIndexLanguage(detected[index] ?? null, config);
    if (!code) {
      continue;
    }
    const row = batch[index]!;
    const ids = idsByLanguage.get(code) ?? [];
    ids.push(row.message_id);
    idsByLanguage.set(code, ids);
    languageRows.push({
      messageId: row.message_id,
      conversationId: row.conversation_id,
      body: row.body,
      language: code,
    });
  }

  for (const [code, ids] of idsByLanguage) {
    const placeholders = ids.map(() => "?").join(", ");
    await db.run(
      `UPDATE "messages_lexical" SET "language" = ?
       WHERE "message_id" IN (${placeholders})`,
      [code, ...ids],
    );
  }
  // The language copies are the reason the column exists: without them the
  // existing rows would be labeled but absent from the language lane.
  await upsertLanguageRows(languageRows);

  await setMemoryCheckpoint(
    LANGUAGE_BACKFILL_CURSOR_KEY,
    batch[batch.length - 1]!.message_id,
  );

  if (batch.length === BATCH_SIZE) {
    enqueueMemoryJob("backfill_lexical_languages", {});
  } else {
    await setMemoryCheckpoint(LANGUAGE_BACKFILL_COMPLETE_KEY, "1");
  }
}
