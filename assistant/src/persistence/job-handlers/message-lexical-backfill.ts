import { and, asc, eq, gt, or } from "drizzle-orm";

import { getConfigReadOnly } from "../../config/loader.js";
import type { AssistantConfig } from "../../config/types.js";
import { detectDocumentLanguages } from "../../search/language-detector.js";
import {
  resolveIndexLanguage,
  searchLanguageCandidates,
  upsertLanguageRows,
} from "../../search/language-index.js";
import { getLogger } from "../../util/logger.js";
import {
  clearLexicalBackfillComplete,
  clearPgLexicalBackfillComplete,
  isLexicalBackfillComplete,
  isPgLexicalBackfillComplete,
  LEXICAL_BACKFILL_COMPLETE_KEY,
  PG_LEXICAL_BACKFILL_COMPLETE_KEY,
  readMessageCursorCheckpoint,
  resetMessageCursorCheckpoint,
  setMemoryCheckpoint,
  writeMessageCursorCheckpoint,
} from "../checkpoints.js";
import { requireMainDb } from "../db-facade.js";
import { generateSparseEmbedding } from "../embeddings/embedding-backend.js";
import { withQdrantBreaker } from "../embeddings/qdrant-circuit-breaker.js";
import {
  enqueueMemoryJob,
  hasActiveJobOfType,
  type MemoryJob,
} from "../jobs-store.js";
import { upsertMessagesLexicalBatch } from "../message-lexical-store.js";
import { indexableTextOfRow } from "../user-facing-content.js";
import {
  resolveLexicalIndex,
  writesPostgres,
  writesQdrant,
} from "./message-lexical.js";

const log = getLogger("lexical-backfill");

/**
 * Cursor checkpoint keys for the lexical-index backfill. Kept distinct from the
 * dense embedding backfill's keys (`memory:backfill:*`) so the two backfills
 * advance independently — enabling lexical without re-running the dense one, and
 * vice versa.
 */
const LEXICAL_BACKFILL_CHECKPOINT_KEY = "lexical:messages:last_created_at";
const LEXICAL_BACKFILL_CHECKPOINT_ID_KEY = "lexical:messages:last_id";

/**
 * Cursor checkpoint keys for the Postgres lexical backfill. Separate from the
 * Qdrant pair so switching `search.lexicalStore` to `dual`/`postgres` starts a
 * fresh drain even though the Qdrant index has long been complete.
 */
const PG_LEXICAL_BACKFILL_CHECKPOINT_KEY =
  "lexical:pg:messages:last_created_at";
const PG_LEXICAL_BACKFILL_CHECKPOINT_ID_KEY = "lexical:pg:messages:last_id";

/** The cursor and completion bookkeeping for one target store. */
interface BackfillBookkeeping {
  createdAtKey: string;
  messageIdKey: string;
  clearComplete: () => Promise<void>;
  isComplete: () => Promise<boolean>;
}

function bookkeepingFor(
  store: AssistantConfig["search"]["lexicalStore"],
): BackfillBookkeeping {
  if (writesPostgres(store)) {
    return {
      createdAtKey: PG_LEXICAL_BACKFILL_CHECKPOINT_KEY,
      messageIdKey: PG_LEXICAL_BACKFILL_CHECKPOINT_ID_KEY,
      clearComplete: clearPgLexicalBackfillComplete,
      isComplete: isPgLexicalBackfillComplete,
    };
  }
  return {
    createdAtKey: LEXICAL_BACKFILL_CHECKPOINT_KEY,
    messageIdKey: LEXICAL_BACKFILL_CHECKPOINT_ID_KEY,
    clearComplete: clearLexicalBackfillComplete,
    isComplete: isLexicalBackfillComplete,
  };
}

/**
 * One-time, self-healing auto-enqueue of the messages lexical-index backfill,
 * invoked once from daemon startup (`daemon/lifecycle.ts`). Ensures each
 * instance populates its lexical index exactly once on upgrade — in the
 * background — so message-content search does not open onto an empty index.
 *
 * Which index (and which completion sentinel) follows `search.lexicalStore`:
 * the shipped `qdrant` value keeps the original Qdrant keys, while `dual` and
 * `postgres` drain the Postgres table on their own cursor. Switching the flag
 * therefore starts a Postgres backfill even on an instance whose Qdrant
 * backfill completed months ago.
 *
 * Deliberate, narrow exception to the "not run at daemon startup" note carried by
 * the manual backfill route (`messages-lexical-routes.ts`, added in the FTS→Qdrant
 * PR 5): this call only *enqueues* a memory job — it does no indexing, no LLM
 * work, and no other heavy lifting on the boot thread. The backfill itself runs
 * off the event loop via the existing memory job worker, in small
 * cursor-checkpointed batches. It is a one-time, checkpoint-guarded, no-LLM data
 * backfill (migration-like), so it is consistent with the daemon-startup
 * philosophy of never blocking or doing expensive work at boot.
 *
 * Guards (all must pass to enqueue):
 * - The completion sentinel for the selected store must be unset. Once the
 *   backfill has fully drained on this instance there is nothing to do; the
 *   marker makes this idempotent across restarts.
 * - No backfill job may already be pending or running. Without this, every
 *   restart during a long backfill would pile up a duplicate job. (The batches
 *   are idempotent, but redundant jobs waste worker cycles.)
 *
 * Unconditional beyond those guards: message-content search is host
 * infrastructure, so the backfill runs regardless of the memory feature's or
 * memory plugin's state (the job worker drains the lexical types even while
 * memory is disabled).
 *
 * An instance that was already manually backfilled via the route but predates
 * the completion sentinel re-enqueues once here and re-runs the idempotent
 * backfill (no duplicate rows; ~minutes) — an acceptable one-time cost.
 *
 * Best-effort and lightweight: any failure (e.g. the memory database is briefly
 * unavailable at boot) is swallowed and logged so a memory hiccup never blocks
 * daemon startup, matching the surrounding startup steps.
 */
export async function maybeEnqueueLexicalBackfillOnUpgrade(): Promise<void> {
  try {
    const { isComplete } = bookkeepingFor(
      getConfigReadOnly().search.lexicalStore,
    );
    if (await isComplete()) {
      return;
    }
    if (await hasActiveJobOfType("backfill_lexical_index")) {
      return;
    }
    const jobId = enqueueMemoryJob("backfill_lexical_index", {});
    log.info(
      { jobId },
      "Enqueued one-time messages lexical-index backfill on startup",
    );
  } catch (err) {
    log.warn(
      { err },
      "Failed to enqueue startup lexical-index backfill (non-fatal)",
    );
  }
}

/** Messages indexed per job invocation before the job re-enqueues itself. */
const BATCH_SIZE = 200;

/**
 * Resumable, cursor-checkpointed backfill of existing messages into the lexical
 * index. Selects the next {@link BATCH_SIZE} messages ordered by
 * `(createdAt asc, id asc)` after the persisted cursor, extracts each row's
 * indexable text, writes the stores `search.lexicalStore` selects, advances the
 * cursor, and re-enqueues itself when the batch is full — draining the whole
 * `messages` table across many short invocations without blocking the event
 * loop.
 *
 * Idempotent: the Qdrant point id is derived deterministically from the message
 * id and the Postgres row is keyed on `message_id`, so re-indexing the same
 * message overwrites the same entry. Pass `payload.force` to reset the cursor
 * and re-index from the beginning.
 */
export async function backfillLexicalIndexJob(
  job: MemoryJob,
  config: AssistantConfig,
): Promise<void> {
  const db = requireMainDb();
  const messages = db.schema.messages;
  const store = config.search.lexicalStore;
  const bookkeeping = bookkeepingFor(store);
  const force = job.payload.force === true;
  if (force) {
    await resetMessageCursorCheckpoint(
      bookkeeping.createdAtKey,
      bookkeeping.messageIdKey,
    );
    // Clearing the completion sentinel lets a forced re-run drain and re-mark
    // as complete, and re-arms the one-time startup auto-enqueue for this run.
    // The route also clears this at enqueue time (so reads fall back to the
    // previous source before the worker claims the job); clearing again here is
    // idempotent and keeps the forced-run semantics self-contained.
    await bookkeeping.clearComplete();
  }

  const cursor = await readMessageCursorCheckpoint(
    bookkeeping.createdAtKey,
    bookkeeping.messageIdKey,
  );
  const batch = await db.orm
    .select({
      id: messages.id,
      conversationId: messages.conversationId,
      content: messages.content,
      metadata: messages.metadata,
      createdAt: messages.createdAt,
    })
    .from(messages)
    .where(
      and(
        eq(messages.finalized, 1),
        or(
          gt(messages.createdAt, cursor.createdAt),
          and(
            eq(messages.createdAt, cursor.createdAt),
            gt(messages.id, cursor.messageId),
          ),
        ),
      ),
    )
    .orderBy(asc(messages.createdAt), asc(messages.id))
    .limit(BATCH_SIZE);

  if (batch.length > 0) {
    // Indexed as what a user can read, matching the live path: a row a
    // `send_user_message` turn marked private contributes its delivered
    // message, not the model's working notes, and reasoning is appended only
    // under the configured threshold.
    const rows = batch.map((message) => ({
      messageId: message.id,
      conversationId: message.conversationId,
      createdAt: message.createdAt,
      body: indexableTextOfRow(message.content, message.metadata, {
        thinkingIndexMaxChars: config.search.thinkingIndexMaxChars,
      }),
    }));

    if (writesQdrant(store)) {
      const index = resolveLexicalIndex(config);
      const points = rows.map((row) => ({
        messageId: row.messageId,
        sparse: generateSparseEmbedding(row.body),
        conversationId: row.conversationId,
        createdAt: row.createdAt,
      }));
      await withQdrantBreaker(() => index.upsertMessagesBatch(points));
    }
    if (writesPostgres(store)) {
      // Detect the batch in parallel (the addon runs it multithreaded) rather
      // than one call per row: the backfill is the bulk path, and the same
      // language routing rules apply as on the live path. The configured list
      // is the detector's candidate set, so no row can land in a language the
      // instance did not declare.
      const detected = detectDocumentLanguages(
        rows.map((row) => row.body),
        searchLanguageCandidates(config),
      );
      const pgRows = rows.map((row, index) => ({
        ...row,
        language: resolveIndexLanguage(detected[index] ?? null, config),
      }));
      await upsertMessagesLexicalBatch(pgRows);
      await upsertLanguageRows(pgRows);
    }

    const lastMessage = batch[batch.length - 1];
    await writeMessageCursorCheckpoint(
      bookkeeping.createdAtKey,
      bookkeeping.messageIdKey,
      {
        createdAt: lastMessage.createdAt,
        messageId: lastMessage.id,
      },
    );
  }

  // A full batch means there may be more rows past the new cursor — re-enqueue
  // to continue draining. Never carry `force` forward: the reset already
  // happened this invocation, and re-resetting would loop over the same head.
  if (batch.length === BATCH_SIZE) {
    enqueueMemoryJob("backfill_lexical_index", {});
  } else {
    // A short batch (including an empty one) means the cursor has reached the
    // end of the `messages` table — the backfill has fully drained. Record the
    // completion sentinel for the selected store so the one-time startup
    // auto-enqueue never schedules it again on this instance. Idempotent:
    // re-running after completion draws an empty batch and simply re-sets the
    // same marker.
    await setMemoryCheckpoint(
      writesPostgres(store)
        ? PG_LEXICAL_BACKFILL_COMPLETE_KEY
        : LEXICAL_BACKFILL_COMPLETE_KEY,
      "1",
    );
  }
}
