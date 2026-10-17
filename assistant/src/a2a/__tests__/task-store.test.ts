import { beforeEach, expect, test } from "bun:test";

import { describePg } from "../../__tests__/pg-test-db.js";
import { requireMainDb } from "../../persistence/db-facade.js";
import { initializeDb } from "../../persistence/db-init.js";
import type { A2AMessage, Artifact } from "../protocol-types.js";
import {
  completeWithArtifacts,
  createTask,
  getPushUrl,
  getTask,
  linkConversation,
  updateState,
} from "../task-store.js";

await initializeDb();

function makeRequestMessage(overrides?: Partial<A2AMessage>): A2AMessage {
  return {
    message_id: crypto.randomUUID(),
    role: "user",
    parts: [{ kind: "text", text: "Hello from sender" }],
    ...overrides,
  };
}

describePg("a2a-task-store", () => {
  beforeEach(async () => {
    const db = requireMainDb();
    await db.run("DELETE FROM a2a_tasks");
  });

  // ── State transitions ───────────────────────────────────────────

  test("createTask returns a task in submitted state", async () => {
    const msg = makeRequestMessage();
    const task = await createTask({
      senderAssistantId: "assistant-123",
      requestMessage: msg,
    });

    expect(task.id).toBeTruthy();
    expect(task.status.state).toBe("submitted");
    expect(task.artifacts).toBeUndefined();
  });

  test("submitted -> working -> completed lifecycle", async () => {
    const task = await createTask({
      senderAssistantId: "assistant-123",
      requestMessage: makeRequestMessage(),
    });

    const working = await updateState(task.id, "working", "Processing...");
    expect(working.status.state).toBe("working");
    expect(working.status.message).toBeDefined();

    const completed = await updateState(task.id, "completed");
    expect(completed.status.state).toBe("completed");
  });

  test("cannot transition from terminal state (completed -> working)", async () => {
    const task = await createTask({
      senderAssistantId: "assistant-123",
      requestMessage: makeRequestMessage(),
    });

    await updateState(task.id, "completed");

    await expect(updateState(task.id, "working")).rejects.toThrow(
      /terminal state/,
    );
  });

  test("cannot transition from failed state", async () => {
    const task = await createTask({
      senderAssistantId: "assistant-123",
      requestMessage: makeRequestMessage(),
    });

    await updateState(task.id, "failed");

    await expect(updateState(task.id, "working")).rejects.toThrow(
      /terminal state/,
    );
  });

  test("cannot transition from canceled state", async () => {
    const task = await createTask({
      senderAssistantId: "assistant-123",
      requestMessage: makeRequestMessage(),
    });

    await updateState(task.id, "canceled");

    await expect(updateState(task.id, "submitted")).rejects.toThrow(
      /terminal state/,
    );
  });

  test("cannot transition from rejected state", async () => {
    const task = await createTask({
      senderAssistantId: "assistant-123",
      requestMessage: makeRequestMessage(),
    });

    await updateState(task.id, "rejected");

    await expect(updateState(task.id, "working")).rejects.toThrow(
      /terminal state/,
    );
  });

  // ── Artifact serialization round-trip ─────────────────────────

  test("completeWithArtifacts stores and retrieves artifacts via JSON round-trip", async () => {
    const task = await createTask({
      senderAssistantId: "assistant-123",
      requestMessage: makeRequestMessage(),
    });

    await updateState(task.id, "working");

    const artifacts: Artifact[] = [
      {
        artifact_id: "art-1",
        parts: [{ kind: "text", text: "Result data" }],
        metadata: { score: 0.95 },
      },
      {
        artifact_id: "art-2",
        parts: [
          { kind: "data", data: { key: "value" } },
          {
            kind: "file",
            url: "https://example.com/file.txt",
            filename: "file.txt",
          },
        ],
      },
    ];

    const completed = await completeWithArtifacts(task.id, artifacts);
    expect(completed.status.state).toBe("completed");
    expect(completed.artifacts).toHaveLength(2);
    expect(completed.artifacts![0].artifact_id).toBe("art-1");
    expect(completed.artifacts![0].metadata).toEqual({ score: 0.95 });
    expect(completed.artifacts![1].parts).toHaveLength(2);

    // Verify round-trip via fresh getTask
    const fetched = await getTask(task.id);
    expect(fetched).not.toBeNull();
    expect(fetched!.artifacts).toEqual(completed.artifacts);
  });

  test("completeWithArtifacts rejects terminal task", async () => {
    const task = await createTask({
      senderAssistantId: "assistant-123",
      requestMessage: makeRequestMessage(),
    });

    await updateState(task.id, "completed");

    await expect(
      completeWithArtifacts(task.id, [
        { artifact_id: "art-1", parts: [{ kind: "text", text: "late" }] },
      ]),
    ).rejects.toThrow(/terminal state/);
  });

  // ── Push URL storage and retrieval ────────────────────────────

  test("push URL is stored and retrieved", async () => {
    const task = await createTask({
      senderAssistantId: "assistant-123",
      requestMessage: makeRequestMessage(),
      pushUrl: "https://example.com/push",
    });

    const url = await getPushUrl(task.id);
    expect(url).toBe("https://example.com/push");
  });

  test("getPushUrl returns null when no push URL set", async () => {
    const task = await createTask({
      senderAssistantId: "assistant-123",
      requestMessage: makeRequestMessage(),
    });

    const url = await getPushUrl(task.id);
    expect(url).toBeNull();
  });

  test("getPushUrl returns null for unknown task ID", async () => {
    const url = await getPushUrl("nonexistent-id");
    expect(url).toBeNull();
  });

  // ── getTask ───────────────────────────────────────────────────

  test("getTask returns null for unknown ID", async () => {
    const result = await getTask("nonexistent-id");
    expect(result).toBeNull();
  });

  test("getTask returns task with context_id when provided", async () => {
    const task = await createTask({
      contextId: "ctx-456",
      senderAssistantId: "assistant-123",
      requestMessage: makeRequestMessage(),
    });

    const fetched = await getTask(task.id);
    expect(fetched).not.toBeNull();
    expect(fetched!.context_id).toBe("ctx-456");
  });

  // ── linkConversation ──────────────────────────────────────────

  test("linkConversation associates a conversation ID", async () => {
    const task = await createTask({
      senderAssistantId: "assistant-123",
      requestMessage: makeRequestMessage(),
    });

    await linkConversation(task.id, "conv-789");

    // Verify via raw DB since getTask doesn't expose conversationId
    const db = requireMainDb();
    const row = await db.get<{ conversation_id: string }>(
      "SELECT conversation_id FROM a2a_tasks WHERE id = ?",
      [task.id],
    );
    expect(row!.conversation_id).toBe("conv-789");
  });

  test("linkConversation throws for unknown task ID", async () => {
    await expect(
      linkConversation("nonexistent-id", "conv-123"),
    ).rejects.toThrow(/not found/);
  });

  // ── updateState error cases ───────────────────────────────────

  test("updateState throws for unknown task ID", async () => {
    await expect(updateState("nonexistent-id", "working")).rejects.toThrow(
      /not found/,
    );
  });
});
