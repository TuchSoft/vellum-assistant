import { beforeEach, expect, test } from "bun:test";

import { describePg } from "../../../../__tests__/pg-test-db.js";
import {
  createBookmark,
  deleteBookmarkByMessageId,
  listBookmarks,
} from "../../../../persistence/bookmark-crud.js";
import { requireMainDb } from "../../../../persistence/db-facade.js";

interface SeedOptions {
  conversationId: string;
  messageId: string;
  conversationTitle?: string | null;
  messageContent?: string;
  messageRole?: string;
  messageCreatedAt?: number;
  /** Stored envelope, e.g. the row's user-facing visibility marker. */
  messageMetadata?: string | null;
}

async function seedConversationAndMessage(opts: SeedOptions): Promise<void> {
  const db = requireMainDb();
  const now = Date.now();
  await db.run(
    `INSERT INTO conversations (id, title, created_at, updated_at) VALUES (?, ?, ?, ?)`,
    [opts.conversationId, opts.conversationTitle ?? "Example", now, now],
  );
  await db.run(
    `INSERT INTO messages (id, conversation_id, role, content, created_at, metadata) VALUES (?, ?, ?, ?, ?, ?)`,
    [
      opts.messageId,
      opts.conversationId,
      opts.messageRole ?? "user",
      opts.messageContent ?? "hello",
      opts.messageCreatedAt ?? now,
      opts.messageMetadata ?? null,
    ],
  );
}

describePg("bookmark-crud", () => {
  beforeEach(async () => {
    const db = requireMainDb();
    // Delete in FK-dependency order: bookmarks -> messages -> conversations.
    await db.run("DELETE FROM message_bookmarks");
    await db.run("DELETE FROM messages");
    await db.run("DELETE FROM conversations");
  });

  test("createBookmark is idempotent — second call returns the existing row", async () => {
    await seedConversationAndMessage({
      conversationId: "conv-1",
      messageId: "msg-1",
    });

    const first = await createBookmark({ messageId: "msg-1" });
    const second = await createBookmark({ messageId: "msg-1" });

    expect(first.inserted).toBe(true);
    expect(second.inserted).toBe(false);
    expect(second.bookmark.id).toBe(first.bookmark.id);
    expect(second.bookmark.createdAt).toBe(first.bookmark.createdAt);

    const all = await listBookmarks();
    expect(all.length).toBe(1);
  });

  test("createBookmark returns the JOIN-shaped summary directly", async () => {
    await seedConversationAndMessage({
      conversationId: "conv-summary",
      messageId: "msg-summary",
      conversationTitle: "Title goes here",
      messageContent: "summary body",
      messageRole: "assistant",
    });

    const result = await createBookmark({ messageId: "msg-summary" });

    expect(result.inserted).toBe(true);
    const summary = result.bookmark;
    expect(summary.conversationTitle).toBe("Title goes here");
    expect(summary.messagePreview).toBe("summary body");
    expect(summary.messageRole).toBe("assistant");
    expect(typeof summary.messageCreatedAt).toBe("number");
  });

  test("listBookmarks returns rows newest-first and includes joined fields", async () => {
    await seedConversationAndMessage({
      conversationId: "conv-A",
      messageId: "msg-A",
      conversationTitle: "Older",
      messageContent: "first message",
      messageRole: "user",
    });
    await seedConversationAndMessage({
      conversationId: "conv-B",
      messageId: "msg-B",
      conversationTitle: "Newer",
      messageContent: "second message",
      messageRole: "assistant",
    });

    // Force deterministic ordering by inserting bookmarks with explicit
    // created_at values 1 ms apart.
    const db = requireMainDb();
    await db.run(
      `INSERT INTO message_bookmarks (id, message_id, conversation_id, created_at) VALUES (?, ?, ?, ?)`,
      ["bm-A", "msg-A", "conv-A", 1000],
    );
    await db.run(
      `INSERT INTO message_bookmarks (id, message_id, conversation_id, created_at) VALUES (?, ?, ?, ?)`,
      ["bm-B", "msg-B", "conv-B", 2000],
    );

    const result = await listBookmarks();
    expect(result.map((r) => r.id)).toEqual(["bm-B", "bm-A"]);
    expect(result[0]?.conversationTitle).toBe("Newer");
    expect(result[0]?.messagePreview).toBe("second message");
    expect(result[0]?.messageRole).toBe("assistant");
    expect(result[1]?.conversationTitle).toBe("Older");
    expect(result[1]?.messageRole).toBe("user");
  });

  test("listBookmarks excludes bookmarks whose conversation no longer exists (CASCADE)", async () => {
    await seedConversationAndMessage({
      conversationId: "conv-keep",
      messageId: "msg-keep",
    });
    await seedConversationAndMessage({
      conversationId: "conv-drop",
      messageId: "msg-drop",
    });
    await createBookmark({ messageId: "msg-keep" });
    await createBookmark({ messageId: "msg-drop" });
    expect((await listBookmarks()).length).toBe(2);

    // Deleting the parent conversation cascades through messages -> bookmarks.
    await requireMainDb().run(`DELETE FROM conversations WHERE id = ?`, [
      "conv-drop",
    ]);

    const remaining = await listBookmarks();
    expect(remaining.length).toBe(1);
    expect(remaining[0]?.conversationId).toBe("conv-keep");
  });

  test("deleteBookmarkByMessageId removes the matching row", async () => {
    await seedConversationAndMessage({
      conversationId: "conv-d",
      messageId: "msg-d",
    });
    await createBookmark({ messageId: "msg-d" });
    expect((await listBookmarks()).length).toBe(1);

    expect(await deleteBookmarkByMessageId("msg-d")).toBe(true);
    expect((await listBookmarks()).length).toBe(0);
    // Calling again with no row present returns false.
    expect(await deleteBookmarkByMessageId("msg-d")).toBe(false);
  });

  test("messagePreview decodes JSON-serialized ContentBlock[] rows", async () => {
    await seedConversationAndMessage({
      conversationId: "conv-blocks",
      messageId: "msg-blocks",
      messageContent: JSON.stringify([
        { type: "text", text: "Hello, can you help with…" },
      ]),
      messageRole: "user",
    });

    const { bookmark: summary } = await createBookmark({
      messageId: "msg-blocks",
    });

    // Without the decode step, this would render as the raw JSON literal
    // (`[{"type":"text","text":"…"}]`) rather than the spoken text.
    expect(summary.messagePreview).toBe("Hello, can you help with…");
    const listed = await listBookmarks();
    expect(listed[0]?.messagePreview).toBe("Hello, can you help with…");
  });

  test("messagePreview quotes the delivered message on a private assistant row", async () => {
    await seedConversationAndMessage({
      conversationId: "conv-private",
      messageId: "msg-private",
      messageContent: JSON.stringify([
        { type: "text", text: "Working notes the user never saw." },
        {
          type: "tool_use",
          id: "tu_1",
          name: "send_user_message",
          input: { message: "You have two meetings today." },
        },
      ]),
      messageRole: "assistant",
      messageMetadata: JSON.stringify({ assistantTextVisibility: "private" }),
    });

    const { bookmark: summary } = await createBookmark({
      messageId: "msg-private",
    });

    expect(summary.messagePreview).toBe("You have two meetings today.");
    expect(summary.messagePreview).not.toContain("Working notes");
    expect((await listBookmarks())[0]?.messagePreview).toBe(
      "You have two meetings today.",
    );
  });

  test("messagePreview concatenates multi-text blocks and drops non-text blocks", async () => {
    await seedConversationAndMessage({
      conversationId: "conv-multi",
      messageId: "msg-multi",
      messageContent: JSON.stringify([
        { type: "text", text: "first paragraph" },
        { type: "tool_use", id: "x", name: "noop", input: {} },
        { type: "text", text: "second paragraph" },
      ]),
      messageRole: "assistant",
    });

    const { bookmark: summary } = await createBookmark({
      messageId: "msg-multi",
    });

    expect(summary.messagePreview).toBe("first paragraph\nsecond paragraph");
  });

  test("createBookmark derives conversationId from the message row", async () => {
    await seedConversationAndMessage({
      conversationId: "conv-real",
      messageId: "msg-x",
    });

    const { bookmark: summary } = await createBookmark({ messageId: "msg-x" });
    expect(summary.conversationId).toBe("conv-real");
    expect((await listBookmarks())[0]?.conversationId).toBe("conv-real");
  });

  test("createBookmark throws when the message id does not exist", async () => {
    await expect(createBookmark({ messageId: "ghost" })).rejects.toThrow(
      /Message ghost not found/,
    );
  });

  test.todo(
    "listBookmarks drives the join from message_bookmarks even with planner stats that predate the table",
    () => {},
  );
});
