import { beforeEach, expect, test } from "bun:test";

import {
  getAttachmentById,
  getAttachmentsForMessage,
  linkAttachmentToMessage,
  uploadAttachment,
} from "../persistence/attachments-store.js";
import {
  addMessage,
  clearAll,
  createConversation,
  deleteConversation,
  deleteConversationGently,
  deleteLastExchange,
  getConversation,
  getMessages,
} from "../persistence/conversation-crud.js";
import { isLastUserMessageToolResult } from "../persistence/conversation-queries.js";
import { requireMainDb } from "../persistence/db-facade.js";
import { initializeDb } from "../persistence/db-init.js";
import { describePg } from "./pg-test-db.js";
// Initialize db once before all tests
await initializeDb();

/** Seed a pending telemetry outbox row (default name: skill_loaded). */
async function seedTelemetryEvent(
  id: string,
  createdAt: number,
  conversationId: string | null,
  name = "skill_loaded",
): Promise<void> {
  await requireMainDb().run(
    `INSERT INTO telemetry_events (id, name, created_at, conversation_id, payload)
     VALUES (?, ?, ?, ?, ?)`,
    [id, name, createdAt, conversationId, "{}"],
  );
}

async function pendingTelemetryEventIds(): Promise<string[]> {
  const rows = await requireMainDb().all<{ id: string }>(
    "SELECT id FROM telemetry_events",
  );
  return rows.map((row) => row.id).sort();
}

describePg("deleteLastExchange", () => {
  beforeEach(async () => {
    // Reset database between tests by dropping and recreating tables
    const db = requireMainDb();
    await db.run(`DELETE FROM messages`);
    await db.run(`DELETE FROM conversations`);
  });

  test("deletes last user message and subsequent assistant messages", async () => {
    const conv = await createConversation("test");
    await addMessage(conv.id, "user", "first question");
    await addMessage(conv.id, "assistant", "first answer");
    await addMessage(conv.id, "user", "second question");
    await addMessage(conv.id, "assistant", "second answer");

    const deleted = await deleteLastExchange(conv.id);
    expect(deleted).toBe(2);

    const remaining = await getMessages(conv.id);
    expect(remaining).toHaveLength(2);
    expect(remaining[0].content).toEqual([
      { type: "text", text: "first question" },
    ]);
    expect(remaining[1].content).toEqual([
      { type: "text", text: "first answer" },
    ]);
  });

  test("returns 0 when no user messages exist", async () => {
    const conv = await createConversation("test");
    await addMessage(conv.id, "assistant", "hello");

    const deleted = await deleteLastExchange(conv.id);
    expect(deleted).toBe(0);
  });

  test("returns 0 for empty conversation", async () => {
    const conv = await createConversation("test");
    const deleted = await deleteLastExchange(conv.id);
    expect(deleted).toBe(0);
  });

  test("uses rowid ordering so same-timestamp messages are handled correctly", async () => {
    const conv = await createConversation("test");
    const db = requireMainDb();
    const now = Date.now();

    // Insert three user messages with the exact same timestamp.
    // rowid order determines which is "last", not timestamp.
    for (const [id, role, content] of [
      ["m1", "user", "first"],
      ["m2", "assistant", "reply1"],
      ["m3", "user", "second"],
      ["m4", "assistant", "reply2"],
    ] as const) {
      await db.run(
        "INSERT INTO messages (id, conversation_id, role, content, created_at) VALUES (?, ?, ?, ?, ?)",
        [id, conv.id, role, content, now],
      );
    }

    // deleteLastExchange should find m3 (the last user message by rowid),
    // then delete m3 and m4 (everything at rowid >= m3's rowid).
    const deleted = await deleteLastExchange(conv.id);
    expect(deleted).toBe(2);

    const remaining = await getMessages(conv.id);
    expect(remaining).toHaveLength(2);
    expect(remaining[0].content).toEqual([{ type: "text", text: "first" }]);
    expect(remaining[1].content).toEqual([{ type: "text", text: "reply1" }]);
  });
});

describePg("isLastUserMessageToolResult", () => {
  beforeEach(async () => {
    const db = requireMainDb();
    await db.run(`DELETE FROM messages`);
    await db.run(`DELETE FROM conversations`);
  });

  test("returns true when last user message is tool_result only", async () => {
    const conv = await createConversation("test");
    await addMessage(conv.id, "user", "hello");
    await addMessage(
      conv.id,
      "assistant",
      JSON.stringify([
        { type: "tool_use", id: "tu1", name: "bash", input: {} },
      ]),
    );
    await addMessage(
      conv.id,
      "user",
      JSON.stringify([
        { type: "tool_result", tool_use_id: "tu1", content: "ok" },
      ]),
    );

    expect(await isLastUserMessageToolResult(conv.id)).toBe(true);
  });

  test("returns false when last user message is plain text", async () => {
    const conv = await createConversation("test");
    await addMessage(conv.id, "user", "hello");

    expect(await isLastUserMessageToolResult(conv.id)).toBe(false);
  });

  test("returns false when no user messages exist", async () => {
    const conv = await createConversation("test");
    expect(await isLastUserMessageToolResult(conv.id)).toBe(false);
  });

  test("returns false when last user message has mixed content types", async () => {
    const conv = await createConversation("test");
    await addMessage(
      conv.id,
      "user",
      JSON.stringify([
        { type: "text", text: "hello" },
        { type: "tool_result", tool_use_id: "tu1", content: "ok" },
      ]),
    );

    expect(await isLastUserMessageToolResult(conv.id)).toBe(false);
  });
});

describePg("deleteLastExchange with tool_result messages", () => {
  beforeEach(async () => {
    const db = requireMainDb();
    await db.run(`DELETE FROM messages`);
    await db.run(`DELETE FROM conversations`);
  });

  test("looping deleteLastExchange cleans up tool_result user messages", async () => {
    const conv = await createConversation("test");
    // Simulate: user asks question -> assistant uses tool -> tool_result -> assistant responds
    await addMessage(conv.id, "user", "What files are in /tmp?");
    await addMessage(
      conv.id,
      "assistant",
      JSON.stringify([
        {
          type: "tool_use",
          id: "tu1",
          name: "bash",
          input: { command: "ls /tmp" },
        },
      ]),
    );
    await addMessage(
      conv.id,
      "user",
      JSON.stringify([
        { type: "tool_result", tool_use_id: "tu1", content: "file1.txt" },
      ]),
    );
    await addMessage(
      conv.id,
      "assistant",
      JSON.stringify([{ type: "text", text: "There is file1.txt in /tmp" }]),
    );

    // First deleteLastExchange removes the tool_result user msg + final assistant msg
    let deleted = await deleteLastExchange(conv.id);
    expect(deleted).toBe(2);

    // After deleting the tool_result user + assistant, the remaining are:
    // user: "What files are in /tmp?" and assistant: tool_use
    let remaining = await getMessages(conv.id);
    expect(remaining).toHaveLength(2);

    // The last user message is the real one, so isLastUserMessageToolResult should be false
    expect(await isLastUserMessageToolResult(conv.id)).toBe(false);

    // Now delete again to remove the real user message + tool_use assistant
    deleted = await deleteLastExchange(conv.id);
    expect(deleted).toBe(2);

    remaining = await getMessages(conv.id);
    expect(remaining).toHaveLength(0);
  });

  test("looping pattern handles multiple tool uses in sequence", async () => {
    const conv = await createConversation("test");
    // user -> assistant(tool_use) -> user(tool_result) -> assistant(tool_use) -> user(tool_result) -> assistant(text)
    await addMessage(conv.id, "user", "Do two things");
    await addMessage(
      conv.id,
      "assistant",
      JSON.stringify([
        { type: "tool_use", id: "tu1", name: "bash", input: {} },
      ]),
    );
    await addMessage(
      conv.id,
      "user",
      JSON.stringify([
        { type: "tool_result", tool_use_id: "tu1", content: "result1" },
      ]),
    );
    await addMessage(
      conv.id,
      "assistant",
      JSON.stringify([
        { type: "tool_use", id: "tu2", name: "bash", input: {} },
      ]),
    );
    await addMessage(
      conv.id,
      "user",
      JSON.stringify([
        { type: "tool_result", tool_use_id: "tu2", content: "result2" },
      ]),
    );
    await addMessage(
      conv.id,
      "assistant",
      JSON.stringify([{ type: "text", text: "Done both" }]),
    );

    // First delete: removes last tool_result user (row 5) + final assistant (row 6)
    await deleteLastExchange(conv.id);
    // Last user is now row 3 (tool_result tu1)
    expect(await isLastUserMessageToolResult(conv.id)).toBe(true);

    // Second delete: removes tool_result user (row 3) + assistant tool_use (row 4)
    await deleteLastExchange(conv.id);
    // Last user is now row 1 (real user message)
    expect(await isLastUserMessageToolResult(conv.id)).toBe(false);

    // Final delete removes the real user message + assistant tool_use
    await deleteLastExchange(conv.id);

    const remaining = await getMessages(conv.id);
    expect(remaining).toHaveLength(0);
  });
});

describePg("attachment orphan cleanup", () => {
  beforeEach(async () => {
    const db = requireMainDb();
    await db.run("DELETE FROM message_attachments");
    await db.run("DELETE FROM attachments");
    await db.run("DELETE FROM messages");
    await db.run("DELETE FROM conversations");
  });

  test("deleteLastExchange cleans up orphaned attachments", async () => {
    const conv = await createConversation("test");
    await addMessage(conv.id, "user", "hello");
    const assistantMsg = await addMessage(
      conv.id,
      "assistant",
      "Here is a file",
    );

    const stored = await uploadAttachment("chart.png", "image/png", "iVBOR");
    await linkAttachmentToMessage(assistantMsg.id, stored.id, 0);

    // Verify attachment is linked
    expect(await getAttachmentsForMessage(assistantMsg.id)).toHaveLength(1);

    // Delete the exchange — should also clean up orphaned attachments
    await deleteLastExchange(conv.id);

    // Attachment row should be gone
    const remaining = (await requireMainDb().get<{ c: number }>(
      "SELECT COUNT(*) AS c FROM attachments",
    ))!;
    expect(remaining.c).toBe(0);
  });

  test("deleteLastExchange preserves attachments still linked to other messages", async () => {
    const conv = await createConversation("test");
    const msg1 = await addMessage(conv.id, "assistant", "first");
    await addMessage(conv.id, "user", "question");
    const msg2 = await addMessage(conv.id, "assistant", "second");

    const shared = await uploadAttachment("shared.png", "image/png", "AAAA");
    await linkAttachmentToMessage(msg1.id, shared.id, 0);
    await linkAttachmentToMessage(msg2.id, shared.id, 0);

    // Delete last exchange (removes msg2 + user question)
    await deleteLastExchange(conv.id);

    // Attachment should survive because msg1 still links to it
    const remaining = (await requireMainDb().get<{ c: number }>(
      "SELECT COUNT(*) AS c FROM attachments",
    ))!;
    expect(remaining.c).toBe(1);
  });

  test("clearAll removes all attachments", async () => {
    const conv = await createConversation("test");
    const msg = await addMessage(conv.id, "assistant", "file");
    const stored = await uploadAttachment(
      "doc.pdf",
      "application/pdf",
      "JVBER",
    );
    await linkAttachmentToMessage(msg.id, stored.id, 0);

    await clearAll();

    const attachmentCount = (await requireMainDb().get<{ c: number }>(
      "SELECT COUNT(*) AS c FROM attachments",
    ))!;
    const linkCount = (await requireMainDb().get<{ c: number }>(
      "SELECT COUNT(*) AS c FROM message_attachments",
    ))!;
    expect(attachmentCount.c).toBe(0);
    expect(linkCount.c).toBe(0);
  });

  test("clearAll removes pending skill_loaded telemetry_events rows", async () => {
    // Privacy posture: Clear All wins over unflushed telemetry — the pending
    // skill_loaded rows (conversation id, skill name, model attribution)
    // must not survive the wipe and ship later.
    await requireMainDb().run("DELETE FROM telemetry_events");
    const conv = await createConversation("test");
    await seedTelemetryEvent("sle-clear-1", 1000, conv.id);
    // Rows without a conversation are wiped too.
    await seedTelemetryEvent("sle-clear-2", 2000, null);

    await clearAll();

    const skillRows = (
      await requireMainDb().all<{ name: string }>(
        "SELECT name FROM telemetry_events",
      )
    ).filter((r) => r.name === "skill_loaded");
    expect(skillRows).toHaveLength(0);
  });

  test("deleteConversation removes that conversation's telemetry_events rows", async () => {
    await requireMainDb().run("DELETE FROM telemetry_events");
    const conv = await createConversation("doomed");
    await addMessage(conv.id, "user", "hello");
    const other = await createConversation("kept");
    await seedTelemetryEvent("te-del-1", 1000, conv.id);
    await seedTelemetryEvent("te-del-2", 2000, other.id);
    // Redaction keys on conversation_id regardless of event name.
    await seedTelemetryEvent("te-del-3", 3000, conv.id, "future_event");

    await deleteConversation(conv.id);

    expect(await pendingTelemetryEventIds()).toEqual(["te-del-2"]);
  });

  test("deleteConversation removes telemetry_events rows when the conversation has no messages", async () => {
    await requireMainDb().run("DELETE FROM telemetry_events");
    const conv = await createConversation("empty");
    await seedTelemetryEvent("te-del-empty", 1000, conv.id);

    await deleteConversation(conv.id);

    expect(await pendingTelemetryEventIds()).toHaveLength(0);
  });

  test("deleteConversationGently removes that conversation's telemetry_events rows", async () => {
    await requireMainDb().run("DELETE FROM telemetry_events");
    const conv = await createConversation("doomed");
    await addMessage(conv.id, "user", "hello");
    const other = await createConversation("kept");
    await seedTelemetryEvent("te-gentle-1", 1000, conv.id);
    await seedTelemetryEvent("te-gentle-2", 2000, other.id);

    await deleteConversationGently(conv.id);

    expect(await pendingTelemetryEventIds()).toEqual(["te-gentle-2"]);
  });

  test("deleteLastExchange does not delete unlinked user uploads", async () => {
    const conv = await createConversation("test");
    await addMessage(conv.id, "user", "hello");
    const assistantMsg = await addMessage(
      conv.id,
      "assistant",
      "Here is a file",
    );

    // An attachment linked to the assistant message (should be cleaned up)
    const linked = await uploadAttachment("chart.png", "image/png", "iVBOR");
    await linkAttachmentToMessage(assistantMsg.id, linked.id, 0);

    // A freshly uploaded attachment not linked to any message (should survive)
    await uploadAttachment("pending.png", "image/png", "AAAA");

    await deleteLastExchange(conv.id);

    const remaining = (await requireMainDb().get<{ c: number }>(
      "SELECT COUNT(*) AS c FROM attachments",
    ))!;
    expect(remaining.c).toBe(1); // only the unlinked upload survives
  });
});

// clearAll fires the `conversations-cleared` hook; the memory plugin's hook is
// what wipes the relocated per-conversation tables. That cascade is covered
// directly in the memory plugin's `conversation-memory-purge.test.ts`.

describePg("conversation metadata defaults", () => {
  beforeEach(async () => {
    const db = requireMainDb();
    await db.run(`DELETE FROM messages`);
    await db.run(`DELETE FROM conversations`);
  });

  test("new conversation has conversationType defaulting to standard", async () => {
    const conv = await createConversation("test");
    expect(conv.conversationType).toBe("standard");
  });

  test("defaults are persisted and retrievable from DB", async () => {
    const conv = await createConversation("test");
    const loaded = await getConversation(conv.id);
    expect(loaded).not.toBeNull();
    expect(loaded!.conversationType).toBe("standard");
  });

  test("existing conversations without explicit values get defaults via migration", async () => {
    // Insert a conversation row directly without the new columns
    // (simulates a pre-migration row — the ALTER TABLE DEFAULT handles it)
    const db = requireMainDb();
    const now = Date.now();
    const id = "legacy-conv-" + now;
    await db.run(
      "INSERT INTO conversations (id, title, created_at, updated_at) VALUES (?, ?, ?, ?)",
      [id, "legacy", now, now],
    );

    const loaded = await getConversation(id);
    expect(loaded).not.toBeNull();
    expect(loaded!.conversationType).toBe("standard");
  });
});

describePg("createConversation with conversation type option", () => {
  beforeEach(async () => {
    const db = requireMainDb();
    await db.run(`DELETE FROM messages`);
    await db.run(`DELETE FROM conversations`);
  });

  test("standard create with string title uses defaults", async () => {
    const conv = await createConversation("hello");
    expect(conv.title).toBe("hello");
    expect(conv.conversationType).toBe("standard");
  });

  test("standard create with options object uses defaults", async () => {
    const conv = await createConversation({
      title: "hello",
      conversationType: "standard",
    });
    expect(conv.conversationType).toBe("standard");
  });

  test("no-arg create uses defaults", async () => {
    const conv = await createConversation();
    expect(conv.conversationType).toBe("standard");
  });
});

// ---------------------------------------------------------------------------
// Baseline: attachment reuse across conversations
// ---------------------------------------------------------------------------

describePg("attachment reuse across conversation lifecycles", () => {
  beforeEach(async () => {
    const db = requireMainDb();
    await db.run("DELETE FROM message_attachments");
    await db.run("DELETE FROM attachments");
    await db.run("DELETE FROM messages");
    await db.run("DELETE FROM conversations");
  });

  test("attachment uploaded in conversation A is retrievable by ID without any conversation reference", async () => {
    const convA = await createConversation("Conversation A");
    const msgA = await addMessage(convA.id, "assistant", "Here is a file");
    const stored = await uploadAttachment(
      "report.pdf",
      "application/pdf",
      "JVBERA==",
    );
    await linkAttachmentToMessage(msgA.id, stored.id, 0);

    // Create a completely separate conversation
    const convB = await createConversation("Conversation B");
    await addMessage(convB.id, "user", "hello");

    // The attachment is retrievable by ID regardless of which conversation is active.
    const fetched = await getAttachmentById(stored.id, {
      hydrateFileData: true,
    });
    expect(fetched).not.toBeNull();
    expect(fetched!.id).toBe(stored.id);
    expect(fetched!.originalFilename).toBe("report.pdf");
    expect(fetched!.dataBase64).toBe("JVBERA==");
  });

  test("re-linking an attachment across conversations creates a conversation-local row", async () => {
    const convA = await createConversation("Conversation A");
    const convB = await createConversation("Conversation B");

    const msgA = await addMessage(convA.id, "assistant", "Original file");
    const msgB = await addMessage(convB.id, "assistant", "Reused file");

    // Upload once, link to both conversations
    const stored = await uploadAttachment(
      "shared.png",
      "image/png",
      "iVBORw0K",
    );
    await linkAttachmentToMessage(msgA.id, stored.id, 0);
    await linkAttachmentToMessage(msgB.id, stored.id, 0);

    // Both messages see the attachment, but each conversation keeps its own row.
    const linkedA = await getAttachmentsForMessage(msgA.id);
    expect(linkedA).toHaveLength(1);
    expect(linkedA[0].id).toBe(stored.id);

    const linkedB = await getAttachmentsForMessage(msgB.id);
    expect(linkedB).toHaveLength(1);
    expect(linkedB[0].id).not.toBe(stored.id);
  });

  test("deleting conversation A does not remove the copied attachment in conversation B", async () => {
    const convA = await createConversation("Conversation A");
    const convB = await createConversation("Conversation B");

    // deleteLastExchange deletes from the last user message onward,
    // so we need a user message before the assistant message that carries the attachment.
    await addMessage(convA.id, "user", "Please generate a chart");
    const msgA = await addMessage(convA.id, "assistant", "Original");
    await addMessage(convB.id, "user", "Show me the chart");
    const msgB = await addMessage(convB.id, "assistant", "Reused");

    const stored = await uploadAttachment("chart.png", "image/png", "AAAA");
    await linkAttachmentToMessage(msgA.id, stored.id, 0);
    await linkAttachmentToMessage(msgB.id, stored.id, 0);
    const linkedB = await getAttachmentsForMessage(msgB.id);
    expect(linkedB).toHaveLength(1);

    // Delete conversation A's exchange
    await deleteLastExchange(convA.id);

    // Conversation B keeps its own attachment row and file.
    const fetched = await getAttachmentById(linkedB[0].id);
    expect(fetched).not.toBeNull();

    // convB's message still has the attachment linked
    const linkedBAfterDelete = await getAttachmentsForMessage(msgB.id);
    expect(linkedBAfterDelete).toHaveLength(1);
    expect(linkedBAfterDelete[0].id).toBe(linkedB[0].id);
  });

  test("identical uploads remain distinct across conversations", async () => {
    const convA = await createConversation("Conversation A");
    const convB = await createConversation("Conversation B");

    await addMessage(convA.id, "user", "upload in A");
    await addMessage(convB.id, "user", "upload in B");

    const first = await uploadAttachment(
      "photo.png",
      "image/png",
      "DEDUPCROSS",
    );
    const second = await uploadAttachment(
      "photo.png",
      "image/png",
      "DEDUPCROSS",
    );

    expect(second.id).not.toBe(first.id);
  });
});
