import { beforeEach, expect, test } from "bun:test";

import { describePg } from "../__tests__/pg-test-db.js";
import { createConversation } from "./conversation-crud.js";
import { requireMainDb } from "./db-facade.js";
import {
  countMessagesByRoleForConversations,
  existingMessageIds,
  latestAssistantMessage,
  latestAssistantMessageBefore,
  latestUserMessageRawContent,
  messageConversationId,
} from "./message-reads.js";

let seq = 0;
async function insertRow(opts: {
  conversationId: string;
  role: string;
  createdAt: number;
  content?: string;
  finalized?: 0 | 1;
}): Promise<string> {
  const id = `msg-${String(++seq).padStart(4, "0")}`;
  await requireMainDb().run(
    "INSERT INTO messages (id, conversation_id, role, content, created_at, metadata, finalized) VALUES (?, ?, ?, ?, ?, ?, ?)",
    [
      id,
      opts.conversationId,
      opts.role,
      opts.content ?? JSON.stringify([{ type: "text", text: "hi" }]),
      opts.createdAt,
      null,
      opts.finalized ?? 1,
    ],
  );
  return id;
}

async function seedConversation(): Promise<string> {
  return (await createConversation("Message reads test")).id;
}

describePg("message-reads", () => {
  beforeEach(async () => {
    const db = requireMainDb();
    await db.run("DELETE FROM messages");
    await db.run("DELETE FROM conversations");
  });

  test("latestAssistantMessage returns the newest finalized assistant row", async () => {
    const conv = await seedConversation();
    await insertRow({ conversationId: conv, role: "user", createdAt: 1_000 });
    const older = await insertRow({
      conversationId: conv,
      role: "assistant",
      createdAt: 2_000,
    });
    const newer = await insertRow({
      conversationId: conv,
      role: "assistant",
      createdAt: 3_000,
    });

    expect((await latestAssistantMessage(conv))?.id).toBe(newer);
    expect((await latestAssistantMessage(conv))?.id).not.toBe(older);
    expect(await latestAssistantMessage("missing-conv")).toBeNull();
  });

  test("latestAssistantMessage never anchors on a streaming row", async () => {
    const conv = await seedConversation();
    const finalizedReply = await insertRow({
      conversationId: conv,
      role: "assistant",
      createdAt: 1_000,
    });
    await insertRow({
      conversationId: conv,
      role: "assistant",
      createdAt: 2_000,
      finalized: 0,
    });

    // The streaming row is newest but is not a reply yet; the watermark must
    // sit on the completed one until the turn finishes.
    expect((await latestAssistantMessage(conv))?.id).toBe(finalizedReply);
  });

  test("a streaming row qualifies on its own once finalized", async () => {
    const conv = await seedConversation();
    await insertRow({
      conversationId: conv,
      role: "assistant",
      createdAt: 1_000,
    });
    const streaming = await insertRow({
      conversationId: conv,
      role: "assistant",
      createdAt: 2_000,
      finalized: 0,
    });

    await requireMainDb().run(
      "UPDATE messages SET finalized = 1 WHERE id = ?",
      [streaming],
    );

    expect((await latestAssistantMessage(conv))?.id).toBe(streaming);
  });

  test("latestAssistantMessageBefore is strict and skips streaming rows", async () => {
    const conv = await seedConversation();
    const first = await insertRow({
      conversationId: conv,
      role: "assistant",
      createdAt: 1_000,
    });
    await insertRow({
      conversationId: conv,
      role: "assistant",
      createdAt: 2_000,
      finalized: 0,
    });
    await insertRow({
      conversationId: conv,
      role: "assistant",
      createdAt: 3_000,
    });

    // Strictly before 3000: the streaming row at 2000 is passed over in
    // favour of the completed row at 1000.
    expect((await latestAssistantMessageBefore(conv, 3_000))?.id).toBe(first);
    // Strictly before 1000: nothing.
    expect(await latestAssistantMessageBefore(conv, 1_000)).toBeNull();
  });

  test("latestUserMessageRawContent resolves same-timestamp rows by insertion order", async () => {
    const conv = await seedConversation();
    await insertRow({
      conversationId: conv,
      role: "user",
      createdAt: 1_000,
      content: "first",
    });
    await insertRow({
      conversationId: conv,
      role: "user",
      createdAt: 1_000,
      content: "second",
    });
    await insertRow({
      conversationId: conv,
      role: "assistant",
      createdAt: 2_000,
    });

    expect(await latestUserMessageRawContent(conv)).toBe("second");
    expect(await latestUserMessageRawContent("missing-conv")).toBeNull();
  });

  test("countMessagesByRoleForConversations aggregates per conversation", async () => {
    const convA = await seedConversation();
    const convB = await seedConversation();
    await insertRow({
      conversationId: convA,
      role: "assistant",
      createdAt: 1_000,
    });
    await insertRow({
      conversationId: convA,
      role: "assistant",
      createdAt: 2_000,
    });
    await insertRow({ conversationId: convA, role: "user", createdAt: 3_000 });
    await insertRow({
      conversationId: convB,
      role: "assistant",
      createdAt: 4_000,
    });

    const stats = await countMessagesByRoleForConversations(
      [convA, convB],
      "assistant",
    );
    expect(stats.get(convA)).toEqual({ count: 2, lastAt: 2_000 });
    expect(stats.get(convB)).toEqual({ count: 1, lastAt: 4_000 });
    expect(
      (await countMessagesByRoleForConversations([], "assistant")).size,
    ).toBe(0);
  });

  test("existingMessageIds returns only ids that exist", async () => {
    const conv = await seedConversation();
    const present = await insertRow({
      conversationId: conv,
      role: "user",
      createdAt: 1_000,
    });

    const existing = await existingMessageIds([present, "msg-not-there"]);
    expect(existing.has(present)).toBe(true);
    expect(existing.has("msg-not-there")).toBe(false);
    expect((await existingMessageIds([])).size).toBe(0);
  });

  test("messageConversationId resolves ownership in any state", async () => {
    const conv = await seedConversation();
    const streaming = await insertRow({
      conversationId: conv,
      role: "assistant",
      createdAt: 1_000,
      finalized: 0,
    });

    expect(await messageConversationId(streaming)).toBe(conv);
    expect(await messageConversationId("msg-not-there")).toBeNull();
  });
});
