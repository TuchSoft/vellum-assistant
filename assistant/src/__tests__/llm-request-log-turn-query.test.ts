import { beforeEach, expect, setDefaultTimeout, test } from "bun:test";
setDefaultTimeout(30_000);

import {
  addMessage,
  createConversation,
  forkConversation,
} from "../persistence/conversation-crud.js";
import { requireMainDb } from "../persistence/db-facade.js";
import {
  backfillMessageIdOnLogs,
  getRequestLogsByMessageId,
  linkRequestLogsToMessage,
  recordRequestLog,
  relinkLlmRequestLogs,
} from "../persistence/llm-request-log-store.js";
import { llmRequestLogs as pgLlmRequestLogs } from "../persistence/pg-schema/index.js";
import { describePg } from "./pg-test-db.js";

async function insertLog(
  values: typeof pgLlmRequestLogs.$inferInsert,
): Promise<void> {
  const db = requireMainDb();
  await db.orm.insert(db.schema.llmRequestLogs).values(values);
}

async function resetTables(): Promise<void> {
  const db = requireMainDb();
  await db.run("DELETE FROM llm_request_logs");
  await db.run("DELETE FROM tool_invocations");
  await db.run("DELETE FROM message_attachments");
  await db.run("DELETE FROM attachments");
  await db.run("DELETE FROM messages");
  await db.run("DELETE FROM conversations");
}

async function insertMessage(
  id: string,
  conversationId: string,
  role: string,
  content: string,
  createdAt: number,
): Promise<void> {
  await requireMainDb().run(
    "INSERT INTO messages (id, conversation_id, role, content, created_at) VALUES (?, ?, ?, ?, ?)",
    [id, conversationId, role, content, createdAt],
  );
}

function toolResultContent(toolUseIds: string[]): string {
  return JSON.stringify(
    toolUseIds.map((id) => ({
      type: "tool_result",
      tool_use_id: id,
      content: "ok",
      is_error: false,
    })),
  );
}

describePg("getRequestLogsByMessageId — turn-aware query", () => {
  beforeEach(async () => {
    await resetTables();
  });

  test("single message, single log: backward compat — returns 1 log", async () => {
    const conv = await createConversation("single-msg");
    await addMessage(conv.id, "user", "Hello", {
      skipIndexing: true,
    });
    const a1 = await addMessage(conv.id, "assistant", "Hi!", {
      skipIndexing: true,
    });

    // Record a log without messageId, then backfill
    await recordRequestLog(conv.id, '{"prompt":"hi"}', '{"result":"hello"}');
    await backfillMessageIdOnLogs(conv.id, a1.id);

    const logs = await getRequestLogsByMessageId(a1.id);
    expect(logs).toHaveLength(1);
    expect(logs[0]?.messageId).toBe(a1.id);
    expect(logs[0]?.conversationId).toBe(conv.id);
  });

  test("multi-step turn: returns logs from all assistant messages in the turn", async () => {
    const conv = await createConversation("multi-step");

    // user → A1 (+ log1) → tool_result → A2 (+ log2)
    await addMessage(conv.id, "user", "Do the task", {
      skipIndexing: true,
    });

    // First LLM call → A1
    await recordRequestLog(conv.id, '{"step":1}', '{"tool_use":"bash"}');
    const a1 = await addMessage(conv.id, "assistant", "Using tool...", {
      skipIndexing: true,
    });
    await backfillMessageIdOnLogs(conv.id, a1.id);

    // tool_result user message
    await addMessage(conv.id, "user", toolResultContent(["tool-1"]), {
      skipIndexing: true,
    });

    // Second LLM call → A2
    await recordRequestLog(conv.id, '{"step":2}', '{"result":"done"}');
    const a2 = await addMessage(conv.id, "assistant", "All done!", {
      skipIndexing: true,
    });
    await backfillMessageIdOnLogs(conv.id, a2.id);

    // Query from A2 (the last message in the turn) → should return both logs
    const logs = await getRequestLogsByMessageId(a2.id);
    expect(logs).toHaveLength(2);
    expect(logs[0]?.messageId).toBe(a1.id);
    expect(logs[1]?.messageId).toBe(a2.id);
    // Verify ordering is by createdAt ASC
    expect(logs[0]!.createdAt).toBeLessThanOrEqual(logs[1]!.createdAt);
  });

  test("fork fallback still works: forked message with no logs, source has turn logs", async () => {
    const source = await createConversation("source-conv");

    // Build a multi-step turn in the source conversation
    await addMessage(source.id, "user", "Original task", {
      skipIndexing: true,
    });

    await recordRequestLog(source.id, '{"step":1}', '{"tool":"bash"}');
    const a1 = await addMessage(source.id, "assistant", "Using tool...", {
      skipIndexing: true,
    });
    await backfillMessageIdOnLogs(source.id, a1.id);

    await addMessage(source.id, "user", toolResultContent(["tool-1"]), {
      skipIndexing: true,
    });

    await recordRequestLog(source.id, '{"step":2}', '{"result":"ok"}');
    const a2 = await addMessage(source.id, "assistant", "Done with source!", {
      skipIndexing: true,
    });
    await backfillMessageIdOnLogs(source.id, a2.id);

    // Fork the conversation
    const fork = await forkConversation({ conversationId: source.id });
    const forkMessages = await (
      await import("../persistence/conversation-crud.js")
    ).getMessages(fork.id);
    const forkLastAssistant = forkMessages
      .filter((m) => m.role === "assistant")
      .at(-1);
    expect(forkLastAssistant).toBeDefined();

    // The fork has no LLM logs of its own — should fall back to source turn's logs
    const logs = await getRequestLogsByMessageId(forkLastAssistant!.id);
    expect(logs).toHaveLength(2);
    expect(logs[0]?.conversationId).toBe(source.id);
    expect(logs[1]?.conversationId).toBe(source.id);
  });

  test("logs from different turns don't bleed", async () => {
    const conv = await createConversation("two-turns");

    // First turn: user → A1 (+ log1)
    await addMessage(conv.id, "user", "First question", {
      skipIndexing: true,
    });
    await recordRequestLog(conv.id, '{"turn":1}', '{"answer":"first"}');
    const a1 = await addMessage(conv.id, "assistant", "First answer", {
      skipIndexing: true,
    });
    await backfillMessageIdOnLogs(conv.id, a1.id);

    // Second turn: user → A2 (+ log2) → tool_result → A3 (+ log3)
    await addMessage(conv.id, "user", "Second question", {
      skipIndexing: true,
    });
    await recordRequestLog(conv.id, '{"turn":2,"step":1}', '{"tool":"bash"}');
    const a2 = await addMessage(conv.id, "assistant", "Using tool...", {
      skipIndexing: true,
    });
    await backfillMessageIdOnLogs(conv.id, a2.id);

    await addMessage(conv.id, "user", toolResultContent(["tool-2"]), {
      skipIndexing: true,
    });

    await recordRequestLog(conv.id, '{"turn":2,"step":2}', '{"result":"done"}');
    const a3 = await addMessage(conv.id, "assistant", "Second done!", {
      skipIndexing: true,
    });
    await backfillMessageIdOnLogs(conv.id, a3.id);

    // Query second turn → should only return logs for A2 and A3, NOT A1
    const secondTurnLogs = await getRequestLogsByMessageId(a3.id);
    expect(secondTurnLogs).toHaveLength(2);
    expect(secondTurnLogs[0]?.messageId).toBe(a2.id);
    expect(secondTurnLogs[1]?.messageId).toBe(a3.id);

    // Query first turn → should only return log for A1
    const firstTurnLogs = await getRequestLogsByMessageId(a1.id);
    expect(firstTurnLogs).toHaveLength(1);
    expect(firstTurnLogs[0]?.messageId).toBe(a1.id);
  });

  test("recovers orphaned logs from deleted intermediate messages", async () => {
    // Simulate a turn where intermediate messages were deleted but logs remain.
    // Use explicit timestamps via raw SQL to avoid timing-dependent flakes.
    const T = 1_700_000_000_000;
    const conv = await createConversation("orphan-test");

    // Insert messages with controlled timestamps via raw SQL.
    await insertMessage("u1-o", conv.id, "user", '"Do the task"', T);
    await insertMessage("a3-o", conv.id, "assistant", '"Done!"', T + 30000);

    // Orphaned log 1: message_id points to a deleted message
    await insertLog({
      id: "log-orphan-1",
      conversationId: conv.id,
      messageId: "deleted-msg-A1",
      provider: "anthropic",
      requestPayload: '{"step":1}',
      responsePayload: '{"tool":"bash"}',
      createdAt: T + 5000,
    });

    // Orphaned log 2
    await insertLog({
      id: "log-orphan-2",
      conversationId: conv.id,
      messageId: "deleted-msg-A2",
      provider: "anthropic",
      requestPayload: '{"step":2}',
      responsePayload: '{"tool":"file_write"}',
      createdAt: T + 15_000,
    });

    // Surviving log: backfilled to the surviving assistant message
    await insertLog({
      id: "log-surviving",
      conversationId: conv.id,
      messageId: "a3-o",
      provider: "anthropic",
      requestPayload: '{"step":3}',
      responsePayload: '{"text":"Done!"}',
      createdAt: T + 29_000,
    });

    // Query from the surviving assistant message → should find all 3 logs
    const logs = await getRequestLogsByMessageId("a3-o");
    expect(logs).toHaveLength(3);
    expect(logs[0]?.id).toBe("log-orphan-1");
    expect(logs[1]?.id).toBe("log-orphan-2");
    expect(logs[2]?.id).toBe("log-surviving");
  });

  test("recovers unlinked logs (messageId IS NULL) within the turn time range", async () => {
    // Simulate the race: logs recorded with NULL messageId, backfill hasn't run yet.
    const T = 1_700_000_000_000;
    const conv = await createConversation("unlinked-test");

    await insertMessage("u1-ul", conv.id, "user", '"Do the task"', T);
    await insertMessage("a1-ul", conv.id, "assistant", '"Done!"', T + 30000);

    // Unlinked log: messageId is NULL (backfill hasn't run yet)
    await insertLog({
      id: "log-unlinked-1",
      conversationId: conv.id,
      messageId: null,
      provider: "anthropic",
      requestPayload: '{"step":1}',
      responsePayload: '{"tool":"bash"}',
      createdAt: T + 5000,
    });

    // Linked log: already backfilled to the assistant message
    await insertLog({
      id: "log-linked-1",
      conversationId: conv.id,
      messageId: "a1-ul",
      provider: "anthropic",
      requestPayload: '{"step":2}',
      responsePayload: '{"text":"Done!"}',
      createdAt: T + 29_000,
    });

    const logs = await getRequestLogsByMessageId("a1-ul");
    expect(logs).toHaveLength(2);
    expect(logs[0]?.id).toBe("log-unlinked-1");
    expect(logs[1]?.id).toBe("log-linked-1");

    // Verify opportunistic backfill ran: the unlinked log should now have a messageId
    const backfilledLog = await requireMainDb().get<{
      message_id: string | null;
    }>("SELECT message_id FROM llm_request_logs WHERE id = ?", [
      "log-unlinked-1",
    ]);
    expect(backfilledLog?.message_id).toBe("a1-ul");
  });

  test("unlinked logs from different conversations don't bleed", async () => {
    const T = 1_700_000_000_000;
    const convA = await createConversation("conv-a");
    const convB = await createConversation("conv-b");

    // Conversation A: user + assistant + unlinked log
    await insertMessage("u1-a", convA.id, "user", '"Hello A"', T);
    await insertMessage("a1-a", convA.id, "assistant", '"Hi A"', T + 10000);
    await insertLog({
      id: "log-conv-a",
      conversationId: convA.id,
      messageId: null,
      provider: "anthropic",
      requestPayload: '{"conv":"A"}',
      responsePayload: '{"r":"A"}',
      createdAt: T + 5000,
    });

    // Conversation B: user + assistant + unlinked log (overlapping timestamps)
    await insertMessage("u1-b", convB.id, "user", '"Hello B"', T);
    await insertMessage("a1-b", convB.id, "assistant", '"Hi B"', T + 10000);
    await insertLog({
      id: "log-conv-b",
      conversationId: convB.id,
      messageId: null,
      provider: "anthropic",
      requestPayload: '{"conv":"B"}',
      responsePayload: '{"r":"B"}',
      createdAt: T + 5000,
    });

    // Query from conv A → should only find conv A's log
    const logsA = await getRequestLogsByMessageId("a1-a");
    expect(logsA).toHaveLength(1);
    expect(logsA[0]?.id).toBe("log-conv-a");

    // Query from conv B → should only find conv B's log
    const logsB = await getRequestLogsByMessageId("a1-b");
    expect(logsB).toHaveLength(1);
    expect(logsB[0]?.id).toBe("log-conv-b");
  });

  test("unlinked logs from different turns don't bleed", async () => {
    const T = 1_700_000_000_000;
    const conv = await createConversation("two-turn-unlinked");

    // Turn 1: user → assistant (with linked log)
    await insertMessage("u1-t", conv.id, "user", '"Turn 1"', T);
    await insertMessage("a1-t", conv.id, "assistant", '"Answer 1"', T + 10000);
    await insertLog({
      id: "log-turn1-unlinked",
      conversationId: conv.id,
      messageId: null,
      provider: "anthropic",
      requestPayload: '{"turn":1}',
      responsePayload: '{"r":1}',
      createdAt: T + 5000,
    });

    // Turn 2: user → assistant (with unlinked log)
    await insertMessage("u2-t", conv.id, "user", '"Turn 2"', T + 60000);
    await insertMessage("a2-t", conv.id, "assistant", '"Answer 2"', T + 70000);
    await insertLog({
      id: "log-turn2-unlinked",
      conversationId: conv.id,
      messageId: null,
      provider: "anthropic",
      requestPayload: '{"turn":2}',
      responsePayload: '{"r":2}',
      createdAt: T + 65000,
    });

    // Query turn 2 → should only find turn 2's unlinked log
    const turn2Logs = await getRequestLogsByMessageId("a2-t");
    expect(turn2Logs).toHaveLength(1);
    expect(turn2Logs[0]?.id).toBe("log-turn2-unlinked");

    // Query turn 1 → should only find turn 1's unlinked log
    const turn1Logs = await getRequestLogsByMessageId("a1-t");
    expect(turn1Logs).toHaveLength(1);
    expect(turn1Logs[0]?.id).toBe("log-turn1-unlinked");
  });

  test("relinkLlmRequestLogs moves logs from deleted messages to consolidated message", async () => {
    const conv = await createConversation("relink-test");

    // Simulate multi-step turn: user → A1 (+ log1) → tool_result → A2 (+ log2)
    await addMessage(conv.id, "user", "Do the task", {
      skipIndexing: true,
    });

    // First LLM call → A1 (tool_use response)
    await recordRequestLog(conv.id, '{"step":1}', '{"tool_use":"bash"}');
    const a1 = await addMessage(conv.id, "assistant", "Using tool...", {
      skipIndexing: true,
    });
    await backfillMessageIdOnLogs(conv.id, a1.id);

    // tool_result user message
    await addMessage(conv.id, "user", toolResultContent(["tool-1"]), {
      skipIndexing: true,
    });

    // Second LLM call → A2 (text response)
    await recordRequestLog(conv.id, '{"step":2}', '{"result":"done"}');
    const a2 = await addMessage(conv.id, "assistant", "All done!", {
      skipIndexing: true,
    });
    await backfillMessageIdOnLogs(conv.id, a2.id);

    // Simulate consolidation: re-link logs from A2 to A1, then delete A2
    await relinkLlmRequestLogs([a2.id], a1.id);

    // Both logs should now be findable via A1
    const logs = await getRequestLogsByMessageId(a1.id);
    expect(logs).toHaveLength(2);
    expect(logs[0]?.messageId).toBe(a1.id);
    expect(logs[1]?.messageId).toBe(a1.id);
  });
});

describePg("compaction-call attribution", () => {
  beforeEach(async () => {
    await resetTables();
  });

  test("fork: an unlinked compactionAgent row does not eclipse the source turn's calls", async () => {
    const source = await createConversation("eclipse-source");
    await addMessage(source.id, "user", "Original question", {
      skipIndexing: true,
    });
    await recordRequestLog(source.id, '{"turn":"src"}', '{"answer":"hi"}');
    const reply = await addMessage(source.id, "assistant", "Answer", {
      skipIndexing: true,
    });
    await backfillMessageIdOnLogs(source.id, reply.id);

    const fork = await forkConversation({ conversationId: source.id });
    const forkMessages = await (
      await import("../persistence/conversation-crud.js")
    ).getMessages(fork.id);
    const forkReply = forkMessages.filter((m) => m.role === "assistant").at(-1);
    expect(forkReply).toBeDefined();

    // A summarize-up-to compaction call lands in the fork, unlinked, inside
    // the pre-fork turn's open-ended time window.
    await recordRequestLog(
      fork.id,
      '{"compaction":true}',
      '{"summary":"..."}',
      undefined,
      "openrouter",
      "compactionAgent",
    );

    const logs = await getRequestLogsByMessageId(forkReply!.id);
    const callSites = logs.map((l) => l.callSite);
    // The recovery may claim the companion row into the window, but the
    // fork-source fallback must still surface the turn's real call.
    expect(callSites).toContain(null);
    expect(logs.some((l) => l.conversationId === source.id)).toBe(true);
  });

  test("a linked compaction row belongs to the card's own group, not the prior turn", async () => {
    const conv = await createConversation("card-group");
    await addMessage(conv.id, "user", "Chat away", { skipIndexing: true });
    await recordRequestLog(conv.id, '{"turn":"main"}', '{"answer":"sure"}');
    const reply = await addMessage(conv.id, "assistant", "Sure!", {
      skipIndexing: true,
    });
    await backfillMessageIdOnLogs(conv.id, reply.id);

    // Summarize-up-to persists a card and links the compaction row to it.
    const compactionLogId = await recordRequestLog(
      conv.id,
      '{"compaction":true}',
      '{"summary":"..."}',
      undefined,
      "openrouter",
      "compactionAgent",
    );
    const card = await addMessage(
      conv.id,
      "assistant",
      "**Conversation summarized**",
      {
        metadata: { messageKind: "system_card" },
        skipIndexing: true,
      },
    );
    await linkRequestLogsToMessage([compactionLogId!], card.id);

    // The prior turn keeps only its own call…
    const turnLogs = await getRequestLogsByMessageId(reply.id);
    expect(turnLogs).toHaveLength(1);
    expect(turnLogs[0]?.messageId).toBe(reply.id);

    // …and the card's group holds exactly the compaction call.
    const cardLogs = await getRequestLogsByMessageId(card.id);
    expect(cardLogs).toHaveLength(1);
    expect(cardLogs[0]?.id).toBe(compactionLogId!);
    expect(cardLogs[0]?.messageId).toBe(card.id);
  });

  test("a card that is a user message's only reply is that turn's group (/compact shape)", async () => {
    const conv = await createConversation("compact-turn");
    const userMsg = await addMessage(conv.id, "user", "/compact", {
      skipIndexing: true,
    });
    const compactionLogId = await recordRequestLog(
      conv.id,
      '{"compaction":true}',
      '{"summary":"..."}',
      undefined,
      "openrouter",
      "compactionAgent",
    );
    const card = await addMessage(conv.id, "assistant", "**Compacted**", {
      metadata: { messageKind: "system_card" },
      skipIndexing: true,
    });
    await linkRequestLogsToMessage([compactionLogId!], card.id);

    const logs = await getRequestLogsByMessageId(userMsg.id);
    expect(logs).toHaveLength(1);
    expect(logs[0]?.id).toBe(compactionLogId!);
  });

  test("recovery on the prior turn cannot defeat the deliberate card link", async () => {
    const conv = await createConversation("link-race");
    await addMessage(conv.id, "user", "Chat away", { skipIndexing: true });
    await recordRequestLog(conv.id, '{"turn":"main"}', '{"answer":"sure"}');
    const reply = await addMessage(conv.id, "assistant", "Sure!", {
      skipIndexing: true,
    });
    await backfillMessageIdOnLogs(conv.id, reply.id);

    // The compaction call is recorded unlinked, before its result card
    // persists — its createdAt falls inside the prior turn's open time window.
    const compactionLogId = await recordRequestLog(
      conv.id,
      '{"compaction":true}',
      '{"summary":"..."}',
      undefined,
      "openrouter",
      "compactionAgent",
    );

    // Race: the inspector queries the prior turn in the window between the
    // compaction call and the card link. Recovery may sweep the unlinked
    // compaction row into the view, but it must NOT durably stamp it onto this
    // turn — otherwise the IS-NULL-guarded link below would no-op.
    await getRequestLogsByMessageId(reply.id);
    const afterRecovery = await requireMainDb().get<{
      message_id: string | null;
    }>("SELECT message_id FROM llm_request_logs WHERE id = ?", [
      compactionLogId!,
    ]);
    expect(afterRecovery?.message_id).toBeNull();

    // The card persists and the route deliberately links the compaction row.
    const card = await addMessage(conv.id, "assistant", "**Compacted**", {
      metadata: { messageKind: "system_card" },
      skipIndexing: true,
    });
    await linkRequestLogsToMessage([compactionLogId!], card.id);

    // The deliberate link wins: the compaction call belongs to the card…
    const cardLogs = await getRequestLogsByMessageId(card.id);
    expect(cardLogs).toHaveLength(1);
    expect(cardLogs[0]?.id).toBe(compactionLogId!);
    expect(cardLogs[0]?.messageId).toBe(card.id);

    // …and the prior turn keeps only its own mainAgent call.
    const turnLogs = await getRequestLogsByMessageId(reply.id);
    expect(turnLogs).toHaveLength(1);
    expect(turnLogs[0]?.messageId).toBe(reply.id);
  });
});
