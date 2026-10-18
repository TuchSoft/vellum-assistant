import { beforeEach, expect, test } from "bun:test";

import { setConfig } from "../../../../__tests__/helpers/set-config.js";
import { describePg } from "../../../../__tests__/pg-test-db.js";

// Disable memory so `addMessage` does not index into the real memory
// pipeline (both flags default true under the real loader).
setConfig("memory", { enabled: false, v2: { enabled: false } });

import {
  addMessage,
  createConversation,
  deleteConversationGently,
  getMessages,
} from "../../../../persistence/conversation-crud.js";
import { deleteConversationRowsInBatches } from "../../../../persistence/conversation-row-batch-delete.js";
import { requireMainDb } from "../../../../persistence/db-facade.js";

async function resetTables(): Promise<void> {
  const db = requireMainDb();
  await db.run("DELETE FROM memory_segments");
  await db.run("DELETE FROM messages");
  await db.run("DELETE FROM conversations");
}

async function countMessages(conversationId: string): Promise<number> {
  return (await getMessages(conversationId)).length;
}

describePg("deleteConversationRowsInBatches", () => {
  beforeEach(async () => {
    await resetTables();
  });

  test("deletes every message across batch boundaries", async () => {
    const conv = await createConversation("source");
    for (let i = 0; i < 5; i++) {
      await addMessage(conv.id, "user", `m${i}`, { skipIndexing: true });
    }
    expect(await countMessages(conv.id)).toBe(5);

    const result = await deleteConversationRowsInBatches({
      conversationId: conv.id,
      table: "messages",
      batchSize: 2,
    });
    expect(result.ok).toBe(true);
    expect(await countMessages(conv.id)).toBe(0);
  });

  test("is a no-op on a conversation with no rows", async () => {
    const conv = await createConversation("empty");
    const result = await deleteConversationRowsInBatches({
      conversationId: conv.id,
      table: "messages",
    });
    expect(result.ok).toBe(true);
    expect(await countMessages(conv.id)).toBe(0);
  });

  test("leaves other conversations' rows untouched", async () => {
    const target = await createConversation("target");
    const keep = await createConversation("keep");
    await addMessage(target.id, "user", "delete me", { skipIndexing: true });
    await addMessage(keep.id, "user", "keep me", { skipIndexing: true });

    const result = await deleteConversationRowsInBatches({
      conversationId: target.id,
      table: "messages",
    });
    expect(result.ok).toBe(true);
    expect(await countMessages(target.id)).toBe(0);
    expect(await countMessages(keep.id)).toBe(1);
  });

  // The low-level batch delete does not cascade to memory_segments: the table
  // is on the memory connection (a different database file), so the main-DB
  // cascade cannot reach it. deleteConversationGently purges those rows through
  // the conversation-deleted hook instead, covered by conversation-memory-purge
  // and the deleteConversationGently test below.
});

describePg("deleteConversationGently", () => {
  beforeEach(async () => {
    await resetTables();
  });

  test("removes the conversation and returns its linked segment ids", async () => {
    const conv = await createConversation("doomed");
    const msg = await addMessage(conv.id, "user", "bye", {
      skipIndexing: true,
    });
    const now = Date.now();
    await requireMainDb().run(
      `INSERT INTO memory_segments
        (id, message_id, conversation_id, role, segment_index, text, token_estimate, created_at, updated_at)
       VALUES (?, ?, ?, 'user', 0, 'bye', 1, ?, ?)`,
      ["seg-gentle", msg.id, conv.id, now, now],
    );

    const result = await deleteConversationGently(conv.id);
    // The ids are collected from the memory connection for the caller's Qdrant
    // purge. The segment rows are purged by the conversation-deleted hook, which
    // is disabled in this memory-off suite. That purge is covered by
    // conversation-memory-purge instead.
    expect(result.segmentIds).toEqual(["seg-gentle"]);
    expect(await countMessages(conv.id)).toBe(0);
    expect(
      await requireMainDb().get<{ c: number }>(
        `SELECT COUNT(*) AS c FROM conversations`,
      ),
    ).toEqual({ c: 0 });
  });
});
