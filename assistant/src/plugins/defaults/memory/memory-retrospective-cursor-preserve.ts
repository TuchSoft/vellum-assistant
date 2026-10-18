// ---------------------------------------------------------------------------
// Memory retrospective: keep the cursor's timestamp when its row is deleted.
// ---------------------------------------------------------------------------
//
// The cursor normally sits on the latest assistant reply, and the retry route
// deletes exactly that row when the user regenerates it. A cursor written
// before the timestamp column existed carries only the id, so once the row is
// gone nothing can place it. The `message-deleted` hook delivers each deleted
// row's `(createdAt, id)` here: when the conversation's cursor is among the
// rows and has no timestamp yet, the row's `createdAt` is recorded. The
// timestamps travel in the call, so the write does not need the rows to
// still exist.

import { and, eq, isNull } from "drizzle-orm";

import { withSqliteRetry } from "./host-utils.js";
import { getLogger } from "./logging.js";
import { memoryDbOrNull } from "./memory-db.js";
import { ensureRetrospectiveCursorColumn } from "./memory-retrospective-state.js";

const log = getLogger("memory-retrospective-cursor-preserve");

/**
 * Record `createdAt` on the conversation's retrospective cursor when it points
 * at one of `rows` and has no timestamp yet. Best-effort: an unavailable
 * memory connection or column is a no-op, and a cursor the job has moved
 * since the caller read it is skipped by the `IS NULL` guard.
 */
export async function preserveRetrospectiveCursorTimestamps(
  conversationId: string,
  rows: ReadonlyArray<{ id: string; createdAt: number }>,
): Promise<void> {
  if (rows.length === 0) {
    return;
  }
  const context = "preserveRetrospectiveCursorTimestamps";
  try {
    const mdb = memoryDbOrNull(context);
    if (!mdb || !(await ensureRetrospectiveCursorColumn(context))) {
      return;
    }
    const table = mdb.schema.memoryRetrospectiveState;
    const state = (
      await mdb.orm
        .select({
          messageId: table.lastProcessedMessageId,
          createdAt: table.lastProcessedCreatedAt,
        })
        .from(table)
        .where(eq(table.conversationId, conversationId))
        .limit(1)
    )[0];
    if (!state || state.createdAt !== null) {
      return;
    }
    const row = rows.find((candidate) => candidate.id === state.messageId);
    if (!row) {
      return;
    }
    await withSqliteRetry(
      () =>
        mdb.orm
          .update(table)
          .set({ lastProcessedCreatedAt: row.createdAt })
          .where(
            and(
              eq(table.conversationId, conversationId),
              eq(table.lastProcessedMessageId, row.id),
              isNull(table.lastProcessedCreatedAt),
            ),
          ),
      { op: context, context: { conversationId } },
    );
  } catch (err) {
    log.warn(
      { err, conversationId },
      "could not preserve the retrospective cursor timestamp before its row was deleted",
    );
  }
}
