import { beforeEach, expect, test } from "bun:test";

import {
  addMessage,
  createConversation,
  getAssistantMessageIdsInTurn,
  PROVIDER_ERROR_MESSAGE_KIND,
  SYSTEM_CARD_MESSAGE_KIND,
} from "../persistence/conversation-crud.js";
import { getLogsDb } from "../persistence/db-connection.js";
import { requireMainDb } from "../persistence/db-facade.js";
import { initializeDb } from "../persistence/db-init.js";
import { llmRequestLogs } from "../persistence/schema/index.js";
import { describePg } from "./pg-test-db.js";

await initializeDb();

async function resetTables(): Promise<void> {
  const db = requireMainDb();
  getLogsDb()!.delete(llmRequestLogs).run();
  await db.run("DELETE FROM tool_invocations");
  await db.run("DELETE FROM message_attachments");
  await db.run("DELETE FROM attachments");
  await db.run("DELETE FROM messages");
  await db.run("DELETE FROM conversations");
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

describePg("getAssistantMessageIdsInTurn", () => {
  beforeEach(async () => {
    await resetTables();
  });

  test("single-step turn: returns only the one assistant message", async () => {
    const conv = await createConversation("single-step");
    await addMessage(conv.id, "user", "Hello", {
      skipIndexing: true,
    });
    const a1 = await addMessage(conv.id, "assistant", "Hi there!", {
      skipIndexing: true,
    });

    const result = await getAssistantMessageIdsInTurn(a1.id);
    expect(result).toEqual([a1.id]);
  });

  test("multi-step turn: user → A1 → tool_result → A2 → query A2 → returns [A1, A2]", async () => {
    const conv = await createConversation("multi-step");
    await addMessage(conv.id, "user", "Do the thing", {
      skipIndexing: true,
    });
    const a1 = await addMessage(conv.id, "assistant", "Using tool...", {
      skipIndexing: true,
    });
    await addMessage(conv.id, "user", toolResultContent(["tool-1"]), {
      skipIndexing: true,
    });
    const a2 = await addMessage(conv.id, "assistant", "Done!", {
      skipIndexing: true,
    });

    const result = await getAssistantMessageIdsInTurn(a2.id);
    expect(result).toEqual([a1.id, a2.id]);
  });

  test("3-step turn: user → A1 → tool_result → A2 → tool_result → A3 → query A3 → returns [A1, A2, A3]", async () => {
    const conv = await createConversation("three-step");
    await addMessage(conv.id, "user", "Complex task", {
      skipIndexing: true,
    });
    const a1 = await addMessage(conv.id, "assistant", "Step 1...", {
      skipIndexing: true,
    });
    await addMessage(conv.id, "user", toolResultContent(["tool-1"]), {
      skipIndexing: true,
    });
    const a2 = await addMessage(conv.id, "assistant", "Step 2...", {
      skipIndexing: true,
    });
    await addMessage(conv.id, "user", toolResultContent(["tool-2"]), {
      skipIndexing: true,
    });
    const a3 = await addMessage(conv.id, "assistant", "All done!", {
      skipIndexing: true,
    });

    const result = await getAssistantMessageIdsInTurn(a3.id);
    expect(result).toEqual([a1.id, a2.id, a3.id]);
  });

  test("query intermediate message: query A1 in a 2-step turn → returns [A1, A2]", async () => {
    const conv = await createConversation("intermediate");
    await addMessage(conv.id, "user", "Start task", {
      skipIndexing: true,
    });
    const a1 = await addMessage(conv.id, "assistant", "Using tool...", {
      skipIndexing: true,
    });
    await addMessage(conv.id, "user", toolResultContent(["tool-1"]), {
      skipIndexing: true,
    });
    const a2 = await addMessage(conv.id, "assistant", "Done!", {
      skipIndexing: true,
    });

    const result = await getAssistantMessageIdsInTurn(a1.id);
    expect(result).toEqual([a1.id, a2.id]);
  });

  test("message not found: returns [messageId]", async () => {
    const result = await getAssistantMessageIdsInTurn("nonexistent-id");
    expect(result).toEqual(["nonexistent-id"]);
  });

  test("consecutive turns: query message in second turn → returns only that turn's messages", async () => {
    const conv = await createConversation("consecutive");

    // First turn
    await addMessage(conv.id, "user", "First question", {
      skipIndexing: true,
    });
    const a1 = await addMessage(conv.id, "assistant", "First answer", {
      skipIndexing: true,
    });

    // Second turn
    await addMessage(conv.id, "user", "Second question", {
      skipIndexing: true,
    });
    const a2 = await addMessage(conv.id, "assistant", "Using tool...", {
      skipIndexing: true,
    });
    await addMessage(conv.id, "user", toolResultContent(["tool-1"]), {
      skipIndexing: true,
    });
    const a3 = await addMessage(conv.id, "assistant", "Done with second", {
      skipIndexing: true,
    });

    // Query second turn → should NOT include a1
    const result = await getAssistantMessageIdsInTurn(a3.id);
    expect(result).toEqual([a2.id, a3.id]);

    // Query first turn → should only include a1
    const firstTurnResult = await getAssistantMessageIdsInTurn(a1.id);
    expect(firstTurnResult).toEqual([a1.id]);
  });

  test("provider-error row after an assistant row: not grouped into the turn", async () => {
    const conv = await createConversation("provider-error-after");
    await addMessage(conv.id, "user", "Do the thing", {
      skipIndexing: true,
    });
    const a1 = await addMessage(conv.id, "assistant", "Partial progress...", {
      skipIndexing: true,
    });
    const pe = await addMessage(conv.id, "assistant", "Provider failed.", {
      skipIndexing: true,
      metadata: { messageKind: PROVIDER_ERROR_MESSAGE_KIND },
    });

    expect(await getAssistantMessageIdsInTurn(a1.id)).toEqual([a1.id]);
    expect(await getAssistantMessageIdsInTurn(pe.id)).toEqual([pe.id]);
  });

  test("assistant row after a provider-error row: earlier standalone row excluded", async () => {
    const conv = await createConversation("provider-error-before");
    await addMessage(conv.id, "user", "Do the thing", {
      skipIndexing: true,
    });
    const pe = await addMessage(conv.id, "assistant", "Provider failed.", {
      skipIndexing: true,
      metadata: { messageKind: PROVIDER_ERROR_MESSAGE_KIND },
    });
    const a1 = await addMessage(conv.id, "assistant", "Recovered reply", {
      skipIndexing: true,
    });

    expect(await getAssistantMessageIdsInTurn(a1.id)).toEqual([a1.id]);
    expect(await getAssistantMessageIdsInTurn(pe.id)).toEqual([pe.id]);
  });

  test("system card adjacent to an assistant row: not grouped into the turn", async () => {
    const conv = await createConversation("system-card-adjacent");
    await addMessage(conv.id, "user", "Summarize please", {
      skipIndexing: true,
    });
    const a1 = await addMessage(conv.id, "assistant", "Working on it...", {
      skipIndexing: true,
    });
    const card = await addMessage(conv.id, "assistant", "Compacted.", {
      skipIndexing: true,
      metadata: { messageKind: SYSTEM_CARD_MESSAGE_KIND },
    });

    expect(await getAssistantMessageIdsInTurn(a1.id)).toEqual([a1.id]);
    expect(await getAssistantMessageIdsInTurn(card.id)).toEqual([card.id]);
  });
});
