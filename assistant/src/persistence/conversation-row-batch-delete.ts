// ---------------------------------------------------------------------------
// Conversation-row batch delete, bulk delete of a conversation's rows from
// one table, in bounded batches.
// ---------------------------------------------------------------------------
//
// Deleting a conversation that owns a large history is expensive on two tables:
// the `messages` rows (potentially an entire copied conversation history) and
// the `llm_request_logs` rows (one bulky row per model call). A single
// `DELETE FROM <table> WHERE conversation_id = ?` holds one statement open for
// the whole drain, and deletes can contend with a live user turn writing to the
// same database.
//
// This module deletes those rows in batches. Each batch selects at most
// `batchSize` row ids, deletes exactly those rows, and yields between batches so
// foreground writers can interleave. Two properties matter for correctness:
//
//   1. **Bounded batches.** Each batch deletes at most `batchSize` rows by id,
//      so the statement stays short and the loop can yield to foreground
//      writes between batches.
//
//   2. **Cascade parity.** Postgres enforces foreign keys per statement, so
//      deleting a `messages` row cascades to its `memory_segments`,
//      `message_attachments`, `bookmarks`, and `channel_inbound_events` rows.
//      (`memory_embeddings` is not FK-linked to segments; the caller deletes
//      those explicitly.)

import { setTimeout as sleep } from "node:timers/promises";

import { withBulkWriteGate } from "./bulk-write-gate.js";
import { requireMainDb } from "./db-facade.js";

/**
 * Default batch size for the chunked delete. Each batch is one bounded
 * `DELETE`, so this caps the per-statement row count; the worst-case wait for a
 * contending foreground write is one batch, and delete latency doesn't matter
 * (nobody waits on a background GC).
 *
 * A deleted row costs a plain b-tree delete plus any FK cascade deletes,
 * cheap and roughly proportional to the row count, with no per-row trigger
 * work, so a batch this size stays short while amortizing the per-batch
 * round-trip cost.
 */
export const DEFAULT_DELETE_BATCH_SIZE = 200;

/**
 * Pause inserted between batches. Without it the delete releases its statement
 * and re-acquires it microseconds later, so a concurrent foreground writer (a
 * live user turn persisting a message) can lose the race. A brief yield lets
 * foreground writes reliably slip in between batches. The extra delete latency
 * is free, nothing waits on a background GC, so we trade delete speed for
 * foreground fairness.
 */
export const DEFAULT_DELETE_INTER_BATCH_DELAY_MS = 25;

export interface DeleteConversationRowsOptions {
  /** The conversation whose rows should be deleted. */
  conversationId: string;
  /** Table to delete from (e.g. `messages`, `llm_request_logs`). */
  table: string;
  /** Column holding the conversation id on `table`. Defaults to `conversation_id`. */
  conversationColumn?: string;
  /** Override the per-batch row count (see {@link DEFAULT_DELETE_BATCH_SIZE}). */
  batchSize?: number;
}

export interface DeleteConversationRowsResult {
  ok: boolean;
  error: string | null;
  elapsedMs: number;
  /** Rows deleted from `table` across every batch. */
  deleted: number;
}

// Table/column identifiers are interpolated unquoted, so constrain them to a
// plain SQL identifier shape. Call sites pass compile-time constants, but this
// keeps the interpolation safe regardless.
const SAFE_IDENTIFIER = /^[A-Za-z_][A-Za-z0-9_]*$/;

function assertSafeIdentifier(name: string, kind: string): void {
  if (!SAFE_IDENTIFIER.test(name)) {
    throw new Error(
      `conversation-row delete: unsafe ${kind} identifier: ${JSON.stringify(name)}`,
    );
  }
}

/**
 * Delete a conversation's rows from one table in batches. Each batch selects up
 * to `batchSize` row ids, deletes them by id, and yields before the next batch
 * (see {@link DEFAULT_DELETE_INTER_BATCH_DELAY_MS}) so foreground writers
 * reliably interleave. Loops until a batch finds no rows, and resolves once
 * every batch has committed, or returns the failing batch's `ok: false` result,
 * leaving any already-deleted rows gone (the caller's GC is best-effort and an
 * orphan sweep is the backstop).
 *
 * Only this table's rows (and their FK cascades) are removed; the caller is
 * responsible for the remaining tables and the conversation row.
 */
export async function deleteConversationRowsInBatches(
  options: DeleteConversationRowsOptions,
): Promise<DeleteConversationRowsResult> {
  assertSafeIdentifier(options.table, "table");
  const column = options.conversationColumn ?? "conversation_id";
  assertSafeIdentifier(column, "column");
  const batchSize = Math.max(1, options.batchSize ?? DEFAULT_DELETE_BATCH_SIZE);

  return await withBulkWriteGate(
    `conversation-row-delete:${options.table}:${options.conversationId}`,
    () => drainBatches(options, column, batchSize),
  );
}

async function drainBatches(
  options: DeleteConversationRowsOptions,
  column: string,
  batchSize: number,
): Promise<DeleteConversationRowsResult> {
  const startMs = Date.now();
  let deleted = 0;
  const db = requireMainDb();

  try {
    // Loop until a batch finds no rows, that batch drained the remaining rows,
    // so there is nothing left to delete. Each DELETE strictly shrinks the row
    // set, so the loop always terminates.
    for (;;) {
      const rows = await db.all<{ id: string }>(
        `SELECT id FROM ${options.table} WHERE ${column} = ? LIMIT ${batchSize}`,
        [options.conversationId],
      );
      if (rows.length === 0) {
        break;
      }

      const ids = rows.map((row) => row.id);
      const placeholders = ids.map(() => "?").join(", ");
      deleted += await db.run(
        `DELETE FROM ${options.table} WHERE id IN (${placeholders})`,
        ids,
      );

      if (rows.length < batchSize) {
        break;
      }
      await sleep(DEFAULT_DELETE_INTER_BATCH_DELAY_MS);
    }
  } catch (err) {
    return {
      ok: false,
      error: err instanceof Error ? err.message : String(err),
      elapsedMs: Date.now() - startMs,
      deleted,
    };
  }

  return { ok: true, error: null, elapsedMs: Date.now() - startMs, deleted };
}
