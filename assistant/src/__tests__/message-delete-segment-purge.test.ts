/**
 * Message-scoped segment/embedding purge. Deleting a single message (its
 * conversation lives on) must remove that message's memory_segments and their
 * embeddings on the memory connection, while a sibling message's rows survive.
 * The conversation-keyed purge does not apply here, so this explicit delete is
 * the sole cleanup for message-scoped rows. There is no orphan-sweep backstop.
 */
import { beforeEach, expect, setDefaultTimeout, test } from "bun:test";
setDefaultTimeout(30_000);

import { setConfig } from "./helpers/set-config.js";

// Disable memory so addMessage does not index into the real pipeline; the
// message-delete cleanup under test is not gated on the plugin being enabled.
setConfig("memory", { enabled: false, v2: { enabled: false } });

import {
  addMessage,
  createConversation,
  deleteMessageById,
} from "../persistence/conversation-crud.js";
import { requireMainDb } from "../persistence/db-facade.js";
import { describePg } from "./pg-test-db.js";

async function seedSegment(
  segmentId: string,
  messageId: string,
  conversationId: string,
): Promise<void> {
  const mem = requireMainDb();
  await mem.run(
    `INSERT INTO memory_segments
       (id, message_id, conversation_id, role, segment_index, text,
        token_estimate, created_at, updated_at)
     VALUES ('${segmentId}', '${messageId}', '${conversationId}', 'user', 0,
             'text', 1, 0, 0)`,
  );
  await mem.run(
    `INSERT INTO memory_embeddings
       (id, target_type, target_id, provider, model, dimensions,
        created_at, updated_at)
     VALUES ('emb-${segmentId}', 'segment', '${segmentId}', 'p', 'm', 3, 0, 0)`,
  );
}

async function memoryRows(table: string): Promise<string[]> {
  const rows = await requireMainDb().all<{ id: string }>(
    `SELECT id FROM ${table} ORDER BY id`,
  );
  return rows.map((r) => r.id);
}

beforeEach(async () => {
  const db = requireMainDb();
  await db.run("DELETE FROM memory_embeddings");
  await db.run("DELETE FROM memory_segments");
  await db.run("DELETE FROM messages");
  await db.run("DELETE FROM conversations");
});

describePg("deleteMessageById segment purge", () => {
  test("purges the deleted message's segments and embeddings, leaving a sibling's intact", async () => {
    const conv = await createConversation("conv");
    const msgA = await addMessage(conv.id, "user", "a", { skipIndexing: true });
    const msgB = await addMessage(conv.id, "user", "b", { skipIndexing: true });
    await seedSegment("seg-a", msgA.id, conv.id);
    await seedSegment("seg-b", msgB.id, conv.id);

    const result = await deleteMessageById(msgA.id);

    // The deleted message's ids are returned for the caller's Qdrant purge.
    expect(result.segmentIds).toEqual(["seg-a"]);
    // Its segment and embedding are gone; the sibling message's survive.
    expect(await memoryRows("memory_segments")).toEqual(["seg-b"]);
    expect(await memoryRows("memory_embeddings")).toEqual(["emb-seg-b"]);
    // The conversation and the sibling message live on.
    expect(
      await requireMainDb().get<{ c: number }>(
        "SELECT COUNT(*) AS c FROM conversations",
      ),
    ).toEqual({ c: 1 });
    expect(await requireMainDb().all("SELECT id FROM messages")).toEqual([
      { id: msgB.id },
    ]);
  });

  test("returns no ids and no-ops when the message has no segments", async () => {
    const conv = await createConversation("conv");
    const msg = await addMessage(conv.id, "user", "no segments", {
      skipIndexing: true,
    });

    const result = await deleteMessageById(msg.id);

    expect(result.segmentIds).toEqual([]);
    expect(await memoryRows("memory_segments")).toEqual([]);
  });
});
