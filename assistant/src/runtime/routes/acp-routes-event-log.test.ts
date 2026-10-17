/**
 * Tests for the GET /v1/acp/sessions list handler's `eventLog` population:
 * active in-memory sessions source it from the live ring buffer (each item
 * carrying `seq`), while terminal DB rows source it from persisted
 * `eventLogJson`.
 */

import { afterAll, beforeEach, expect, mock, test } from "bun:test";

import type { AcpSessionState } from "../../acp/index.js";
import type { AcpSessionUpdateEvent } from "../../api/events/acp-session-update.js";

const inMemoryStates = new Map<string, AcpSessionState>();
const bufferedUpdates = new Map<string, AcpSessionUpdateEvent[]>();

mock.module("../../acp/index.js", () => ({
  getAcpSessionManager: () => ({
    getStatus: (id?: string) => {
      if (id === undefined) {
        return Array.from(inMemoryStates.values());
      }
      const state = inMemoryStates.get(id);
      if (!state) {
        throw new Error(`ACP session "${id}" not found`);
      }
      return state;
    },
    getBufferedUpdates: (id: string) => bufferedUpdates.get(id) ?? [],
  }),
}));

import { describePg } from "../../__tests__/pg-test-db.js";
import { requireMainDb } from "../../persistence/db-facade.js";
import { initializeDb } from "../../persistence/db-init.js";

const { ROUTES } = await import("./acp-routes.js");

await initializeDb();

async function clearHistory(): Promise<void> {
  await requireMainDb().run("DELETE FROM acp_session_history");
}

async function insertHistoryRow(row: {
  id: string;
  agentId?: string;
  acpSessionId?: string;
  parentConversationId?: string;
  status?: string;
  startedAt?: number;
  completedAt?: number | null;
  error?: string | null;
  stopReason?: string | null;
  eventLogJson?: string;
  cwd?: string | null;
  task?: string | null;
  parentToolUseId?: string | null;
  usedTokens?: number | null;
  contextSize?: number | null;
  costAmount?: number | null;
  costCurrency?: string | null;
}): Promise<void> {
  const db = requireMainDb();
  await db.orm.insert(db.schema.acpSessionHistory).values({
    id: row.id,
    agentId: row.agentId ?? "claude",
    acpSessionId: row.acpSessionId ?? "proto-old",
    parentConversationId: row.parentConversationId ?? "conv-1",
    startedAt: row.startedAt ?? 1234,
    completedAt: row.completedAt === undefined ? 5678 : row.completedAt,
    status: row.status ?? "completed",
    stopReason: row.stopReason === undefined ? "end_turn" : row.stopReason,
    error: row.error ?? null,
    eventLogJson: row.eventLogJson ?? "[]",
    cwd: row.cwd === undefined ? "/tmp/proj" : row.cwd,
    task: row.task ?? null,
    parentToolUseId: row.parentToolUseId ?? null,
    usedTokens: row.usedTokens ?? null,
    contextSize: row.contextSize ?? null,
    costAmount: row.costAmount ?? null,
    costCurrency: row.costCurrency ?? null,
  });
}

function getListHandler() {
  const route = ROUTES.find(
    (r: { endpoint: string; method: string }) =>
      r.endpoint === "acp/sessions" && r.method === "GET",
  );
  if (!route) {
    throw new Error("GET acp/sessions route not registered");
  }
  return route.handler;
}

function makeInMemoryState(
  id: string,
  parentConversationId: string,
  extra?: Pick<AcpSessionState, "task" | "parentToolUseId" | "latestUsage">,
): AcpSessionState {
  return {
    id,
    agentId: "claude",
    acpSessionId: `proto-${id}`,
    parentConversationId,
    status: "running",
    startedAt: 1_700_000_000_000,
    ...extra,
  };
}

function makeUpdate(seq: number, content: string): AcpSessionUpdateEvent {
  return {
    type: "acp_session_update",
    acpSessionId: "active",
    updateType: "agent_message_chunk",
    content,
    seq,
  };
}

beforeEach(async () => {
  inMemoryStates.clear();
  bufferedUpdates.clear();
  await clearHistory();
});

afterAll(async () => {
  inMemoryStates.clear();
  bufferedUpdates.clear();
  await clearHistory();
});

describePg("GET /v1/acp/sessions — eventLog", () => {
  test("active in-memory session returns eventLog from the live ring buffer with seq", async () => {
    inMemoryStates.set("active", makeInMemoryState("active", "conv-1"));
    bufferedUpdates.set("active", [
      makeUpdate(1, "hello"),
      makeUpdate(2, "world"),
    ]);

    const handler = getListHandler();
    const result = (await handler({
      queryParams: { conversationId: "conv-1" },
    })) as { sessions: Array<Record<string, unknown>> };

    const session = result.sessions.find((s) => s.id === "active");
    expect(session).toBeDefined();
    const eventLog = session?.eventLog as AcpSessionUpdateEvent[];
    expect(eventLog).toHaveLength(2);
    expect(eventLog.map((u) => u.seq)).toEqual([1, 2]);
    expect(eventLog[0]?.content).toBe("hello");
  });

  test("active in-memory session carries task and parentToolUseId from the SessionEntry", async () => {
    inMemoryStates.set(
      "active",
      makeInMemoryState("active", "conv-1", {
        task: "Refactor the auth module",
        parentToolUseId: "tool-use-abc",
      }),
    );

    const handler = getListHandler();
    const result = (await handler({
      queryParams: { conversationId: "conv-1" },
    })) as { sessions: Array<Record<string, unknown>> };

    const session = result.sessions.find((s) => s.id === "active");
    expect(session).toBeDefined();
    expect(session?.task).toBe("Refactor the auth module");
    expect(session?.parentToolUseId).toBe("tool-use-abc");
  });

  test("terminal DB row returns its persisted eventLog", async () => {
    await insertHistoryRow({
      id: "terminal",
      agentId: "claude",
      acpSessionId: "proto-terminal",
      parentConversationId: "conv-1",
      status: "completed",
      startedAt: 1_699_000_000_000,
      completedAt: 1_699_000_001_000,
      error: null,
      stopReason: "end_turn",
      eventLogJson: JSON.stringify([makeUpdate(7, "persisted")]),
    });

    const handler = getListHandler();
    const result = (await handler({
      queryParams: { conversationId: "conv-1" },
    })) as { sessions: Array<Record<string, unknown>> };

    const session = result.sessions.find((s) => s.id === "terminal");
    expect(session).toBeDefined();
    const eventLog = session?.eventLog as AcpSessionUpdateEvent[];
    expect(eventLog).toHaveLength(1);
    expect(eventLog[0]?.seq).toBe(7);
    expect(eventLog[0]?.content).toBe("persisted");
  });

  test("active and terminal sessions both surface tool_call rawInput/rawOutput in eventLog", async () => {
    const rawInput = { command: "grep -rn foo", pattern: "foo" };
    const rawOutput = "src/a.ts:1: foo\nsrc/b.ts:9: foo";

    const activeToolCall: AcpSessionUpdateEvent = {
      type: "acp_session_update",
      acpSessionId: "active",
      updateType: "tool_call",
      toolCallId: "tc-active",
      toolKind: "search",
      toolStatus: "completed",
      rawInput,
      rawOutput,
      seq: 1,
    };
    inMemoryStates.set("active", makeInMemoryState("active", "conv-1"));
    bufferedUpdates.set("active", [activeToolCall]);

    await insertHistoryRow({
      id: "terminal",
      parentConversationId: "conv-1",
      eventLogJson: JSON.stringify([
        {
          type: "acp_session_update",
          acpSessionId: "terminal",
          updateType: "tool_call",
          toolCallId: "tc-terminal",
          toolKind: "search",
          toolStatus: "completed",
          rawInput,
          rawOutput,
          seq: 1,
        } satisfies AcpSessionUpdateEvent,
      ]),
    });

    const handler = getListHandler();
    const result = (await handler({
      queryParams: { conversationId: "conv-1" },
    })) as { sessions: Array<Record<string, unknown>> };

    for (const id of ["active", "terminal"]) {
      const session = result.sessions.find((s) => s.id === id);
      expect(session).toBeDefined();
      const eventLog = session?.eventLog as AcpSessionUpdateEvent[];
      expect(eventLog).toHaveLength(1);
      expect(eventLog[0]?.rawInput).toEqual(rawInput);
      expect(eventLog[0]?.rawOutput).toBe(rawOutput);
    }
  });

  test("active in-memory session surfaces latestUsage as the usage fields", async () => {
    inMemoryStates.set(
      "active",
      makeInMemoryState("active", "conv-1", {
        latestUsage: {
          usedTokens: 1234,
          contextSize: 200_000,
          costAmount: 0.5,
          costCurrency: "USD",
        },
      }),
    );

    const handler = getListHandler();
    const result = (await handler({
      queryParams: { conversationId: "conv-1" },
    })) as { sessions: Array<Record<string, unknown>> };

    const session = result.sessions.find((s) => s.id === "active");
    expect(session).toBeDefined();
    expect(session?.usedTokens).toBe(1234);
    expect(session?.contextSize).toBe(200_000);
    expect(session?.costAmount).toBe(0.5);
    expect(session?.costCurrency).toBe("USD");
  });

  test("terminal DB row returns persisted task, parentToolUseId, and usage", async () => {
    await insertHistoryRow({
      id: "terminal-usage",
      parentConversationId: "conv-1",
      task: "Refactor the parser",
      parentToolUseId: "tool-use-xyz",
      usedTokens: 8000,
      contextSize: 200_000,
      costAmount: 0.0456,
      costCurrency: "USD",
    });

    const handler = getListHandler();
    const result = (await handler({
      queryParams: { conversationId: "conv-1" },
    })) as { sessions: Array<Record<string, unknown>> };

    const session = result.sessions.find((s) => s.id === "terminal-usage");
    expect(session).toBeDefined();
    expect(session?.task).toBe("Refactor the parser");
    expect(session?.parentToolUseId).toBe("tool-use-xyz");
    expect(session?.usedTokens).toBe(8000);
    expect(session?.contextSize).toBe(200_000);
    expect(session?.costAmount).toBe(0.0456);
    expect(session?.costCurrency).toBe("USD");
  });

  test("pre-migration terminal row (NULL usage columns) degrades to undefined", async () => {
    await insertHistoryRow({
      id: "terminal-legacy",
      parentConversationId: "conv-1",
      // task/parentToolUseId/usage columns default to NULL.
    });

    const handler = getListHandler();
    const result = (await handler({
      queryParams: { conversationId: "conv-1" },
    })) as { sessions: Array<Record<string, unknown>> };

    const session = result.sessions.find((s) => s.id === "terminal-legacy");
    expect(session).toBeDefined();
    expect(session?.task).toBeUndefined();
    expect(session?.parentToolUseId).toBeUndefined();
    expect(session?.usedTokens).toBeUndefined();
    expect(session?.contextSize).toBeUndefined();
    expect(session?.costAmount).toBeUndefined();
    expect(session?.costCurrency).toBeUndefined();
  });
});
