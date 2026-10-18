import { describe, expect, test } from "bun:test";

import type { StopMode } from "../../util/stop-mode.js";
import { type StopAllDeps, stopAllWork } from "../stop-all.js";

const EMPTY: StopAllDeps = {
  listProcessingConversations: async () => [],
  listRunningMemoryJobs: async () => [],
  listRunningScheduleRuns: async () => [],
  listRunningWorkflowRuns: async () => [],
  listRunningHeartbeatRuns: async () => [],
  cancelGeneration: () => ({ found: true, subagents: 0, acpSessions: 0 }),
  cancelBackgroundTools: () => [],
  findConversationOrSubagent: () => undefined,
  abortWorkflowRun: () => false,
};

describe("stopAllWork", () => {
  test("reports one count per stopped category", async () => {
    const cancelled: Array<{ conversationId: string; mode: StopMode }> = [];
    const scheduleAborts: string[] = [];
    const workflowAborts: string[] = [];
    const cancelledTools: string[] = [];
    const deps: StopAllDeps = {
      ...EMPTY,
      // Two processing conversations: the first has two child subagents, the
      // second is a main turn with no children.
      listProcessingConversations: async () => [
        { conversationId: "conv-a" },
        { conversationId: "conv-b" },
      ],
      cancelGeneration: (conversationId, mode) => {
        cancelled.push({ conversationId, mode });
        return {
          found: true,
          subagents: conversationId === "conv-a" ? 2 : 0,
          acpSessions: conversationId === "conv-a" ? 1 : 0,
        };
      },
      // One background tool.
      cancelBackgroundTools: (shouldCancel, reason) => {
        cancelledTools.push(reason ?? "");
        expect(shouldCancel({})).toBe(true);
        return [{}];
      },
      // One running schedule run whose conversation is live.
      listRunningScheduleRuns: async () => [
        { runId: "schedule-run-1", conversationId: "conv-a" },
      ],
      findConversationOrSubagent: (conversationId) =>
        conversationId === "conv-a"
          ? {
              abortScheduledRun: (runId: string) => {
                scheduleAborts.push(runId);
              },
            }
          : undefined,
      // One in-flight workflow run.
      listRunningWorkflowRuns: async () => [{ runId: "workflow-run-1" }],
      abortWorkflowRun: (runId) => {
        workflowAborts.push(runId);
        return true;
      },
      // One heartbeat run for a conversation that is not in the processing
      // list yet (e.g. its row landed before the turn claim).
      listRunningHeartbeatRuns: async () => [
        { runId: "heartbeat-run-1", conversationId: "conv-c" },
      ],
    };

    const counts = await stopAllWork("hard", deps);

    expect(counts).toEqual({
      conversations: 2,
      subagents: 2,
      acpSessions: 1,
      backgroundTools: 1,
      scheduleRuns: 1,
      workflowRuns: 1,
      heartbeatRuns: 1,
      memoryJobs: 0,
      unsupported: [],
    });
    expect(cancelled).toEqual([
      { conversationId: "conv-a", mode: "hard" },
      { conversationId: "conv-b", mode: "hard" },
      { conversationId: "conv-c", mode: "hard" },
    ]);
    expect(scheduleAborts).toEqual(["schedule-run-1"]);
    expect(workflowAborts).toEqual(["workflow-run-1"]);
    expect(cancelledTools).toEqual(["stop-all:hard"]);
  });

  test("is idempotent with nothing in flight", async () => {
    const counts = await stopAllWork("hard", EMPTY);

    expect(counts).toEqual({
      conversations: 0,
      subagents: 0,
      acpSessions: 0,
      backgroundTools: 0,
      scheduleRuns: 0,
      workflowRuns: 0,
      heartbeatRuns: 0,
      memoryJobs: 0,
      unsupported: [],
    });
  });

  test("reports memory jobs as unsupported without touching them", async () => {
    const counts = await stopAllWork("graceful", {
      ...EMPTY,
      listRunningMemoryJobs: async () => [{ id: "memory-job-1" }],
    });

    expect(counts.memoryJobs).toBe(0);
    expect(counts.unsupported).toEqual(["memoryJobs"]);
  });

  test("passes the requested mode to every conversation stop", async () => {
    const modes: StopMode[] = [];
    await stopAllWork("main-only", {
      ...EMPTY,
      listProcessingConversations: async () => [{ conversationId: "conv-a" }],
      cancelGeneration: (_conversationId, mode) => {
        modes.push(mode);
        return { found: true, subagents: 0, acpSessions: 0 };
      },
    });

    expect(modes).toEqual(["main-only"]);
  });

  test("skips a running row whose conversation is no longer live", async () => {
    const counts = await stopAllWork("hard", {
      ...EMPTY,
      listRunningScheduleRuns: async () => [
        { runId: "schedule-run-gone", conversationId: "conv-gone" },
      ],
      listRunningWorkflowRuns: async () => [{ runId: "workflow-run-gone" }],
      listRunningHeartbeatRuns: async () => [
        { runId: "heartbeat-run-gone", conversationId: "conv-gone" },
      ],
      cancelGeneration: () => ({
        found: false,
        subagents: 0,
        acpSessions: 0,
      }),
      findConversationOrSubagent: () => undefined,
      abortWorkflowRun: () => false,
    });

    expect(counts.scheduleRuns).toBe(0);
    expect(counts.workflowRuns).toBe(0);
    expect(counts.heartbeatRuns).toBe(0);
  });
});
