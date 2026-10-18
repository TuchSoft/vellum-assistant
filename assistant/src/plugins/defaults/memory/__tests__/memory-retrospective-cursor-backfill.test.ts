import { beforeEach, expect, setDefaultTimeout, test } from "bun:test";

setDefaultTimeout(30_000);

import { setConfig } from "../../../../__tests__/helpers/set-config.js";
import { describePg } from "../../../../__tests__/pg-test-db.js";

// Disable memory so persistence writes don't index into the real memory
// pipeline (both flags default true under the real loader).
setConfig("memory", { enabled: false, v2: { enabled: false } });

import { createConversation } from "../../../../persistence/conversation-crud.js";
import { requireMainDb } from "../../../../persistence/db-facade.js";
import { backfillRetrospectiveCursorTimestamps } from "../memory-retrospective-cursor-backfill.js";
import {
  ensureRetrospectiveCursorColumn,
  getRetrospectiveState,
} from "../memory-retrospective-state.js";

async function resetTables(): Promise<void> {
  const db = requireMainDb();
  await db.run(`DELETE FROM messages`);
  await db.run(`DELETE FROM conversations`);
  await db.run(`DELETE FROM memory_retrospective_state`);
}

/** A state row as written before the timestamp column existed. */
async function insertLegacyState(
  conversationId: string,
  messageId: string,
): Promise<void> {
  await ensureRetrospectiveCursorColumn("test");
  await requireMainDb().run(
    `INSERT INTO memory_retrospective_state
       (conversation_id, last_processed_message_id, last_run_at, remembered_log, last_processed_created_at)
     VALUES (?, ?, 1, NULL, NULL)`,
    [conversationId, messageId],
  );
}

async function insertMessage(
  conversationId: string,
  id: string,
  createdAt: number,
): Promise<void> {
  await requireMainDb().run(
    `INSERT INTO messages (id, conversation_id, role, content, created_at, metadata)
     VALUES (?, ?, 'user', '[]', ?, NULL)`,
    [id, conversationId, createdAt],
  );
}

describePg("backfillRetrospectiveCursorTimestamps", () => {
  beforeEach(async () => {
    await resetTables();
  });

  test("fills the timestamp from the cursor's message, leaves vanished cursors NULL, and is idempotent", async () => {
    await createConversation({ id: "conv-a" });
    await createConversation({ id: "conv-b" });
    await createConversation({ id: "conv-c" });
    await insertMessage("conv-a", "a-m1", 1_000);
    await insertLegacyState("conv-a", "a-m1");
    // Cursor row already deleted: nothing left to recover.
    await insertLegacyState("conv-b", "gone");
    // The failure-only sentinel is never a cursor, so it is never scanned.
    await insertLegacyState("conv-c", "");

    const first = await backfillRetrospectiveCursorTimestamps();

    expect(first).toEqual({ scanned: 2, backfilled: 1, unrecoverable: 1 });
    expect(
      (await getRetrospectiveState("conv-a"))?.lastProcessedCreatedAt,
    ).toBe(1_000);
    expect(
      (await getRetrospectiveState("conv-b"))?.lastProcessedCreatedAt,
    ).toBeNull();
    expect(
      (await getRetrospectiveState("conv-c"))?.lastProcessedCreatedAt,
    ).toBeNull();

    const second = await backfillRetrospectiveCursorTimestamps();

    expect(second).toEqual({ scanned: 1, backfilled: 0, unrecoverable: 1 });
  });

  test("pages through the backlog by conversation id, advancing past unrecoverable rows", async () => {
    for (const id of ["conv-1", "conv-2", "conv-3", "conv-4", "conv-5"]) {
      await createConversation({ id });
    }
    await insertMessage("conv-1", "m-1", 1_000);
    await insertLegacyState("conv-1", "m-1");
    await insertLegacyState("conv-2", "gone-2");
    await insertMessage("conv-3", "m-3", 3_000);
    await insertLegacyState("conv-3", "m-3");
    await insertLegacyState("conv-4", "gone-4");
    await insertMessage("conv-5", "m-5", 5_000);
    await insertLegacyState("conv-5", "m-5");

    const result = await backfillRetrospectiveCursorTimestamps({ pageSize: 2 });

    expect(result).toEqual({ scanned: 5, backfilled: 3, unrecoverable: 2 });
    expect(
      (await getRetrospectiveState("conv-1"))?.lastProcessedCreatedAt,
    ).toBe(1_000);
    expect(
      (await getRetrospectiveState("conv-3"))?.lastProcessedCreatedAt,
    ).toBe(3_000);
    expect(
      (await getRetrospectiveState("conv-5"))?.lastProcessedCreatedAt,
    ).toBe(5_000);
    expect(
      (await getRetrospectiveState("conv-4"))?.lastProcessedCreatedAt,
    ).toBeNull();
  });

  test("a table with nothing to fill is a clean no-op", async () => {
    expect(await backfillRetrospectiveCursorTimestamps()).toEqual({
      scanned: 0,
      backfilled: 0,
      unrecoverable: 0,
    });
  });
});
