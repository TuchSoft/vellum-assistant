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

interface Harness {
  deps: StopAllDeps;
  cancelled: Array<{ conversationId: string; mode: StopMode }>;
  scheduleAborts: string[];
  workflowAborts: string[];
  cancelledTools: string[];
  enumerated: { schedule: number; workflow: number; heartbeat: number };
}

/**
 * A stop-all world with two processing conversations, one background tool,
 * one running schedule run, one in-flight workflow run, and one running
 * heartbeat run. The conversation stop mirrors `cancelGenerationWithMode`:
 * `main-only` reports no child subagents or ACP sessions.
 */
function makeHarness(): Harness {
  const cancelled: Harness["cancelled"] = [];
  const scheduleAborts: string[] = [];
  const workflowAborts: string[] = [];
  const cancelledTools: string[] = [];
  const enumerated = { schedule: 0, workflow: 0, heartbeat: 0 };

  const deps: StopAllDeps = {
    ...EMPTY,
    // Two processing conversations: the first has two child subagents and one
    // ACP session, the second is a main turn with no children.
    listProcessingConversations: async () => [
      { conversationId: "conv-a" },
      { conversationId: "conv-b" },
    ],
    cancelGeneration: (conversationId, mode) => {
      cancelled.push({ conversationId, mode });
      const mainOnly = mode === "main-only";
      return {
        found: true,
        subagents: mainOnly ? 0 : conversationId === "conv-a" ? 2 : 0,
        acpSessions: mainOnly ? 0 : conversationId === "conv-a" ? 1 : 0,
      };
    },
    cancelBackgroundTools: (shouldCancel, reason) => {
      cancelledTools.push(reason ?? "");
      expect(shouldCancel({})).toBe(true);
      return [{}];
    },
    listRunningScheduleRuns: async () => {
      enumerated.schedule += 1;
      return [{ runId: "schedule-run-1", conversationId: "conv-a" }];
    },
    findConversationOrSubagent: (conversationId) =>
      conversationId === "conv-a"
        ? {
            abortScheduledRun: (runId: string) => {
              scheduleAborts.push(runId);
            },
          }
        : undefined,
    listRunningWorkflowRuns: async () => {
      enumerated.workflow += 1;
      return [{ runId: "workflow-run-1" }];
    },
    abortWorkflowRun: (runId) => {
      workflowAborts.push(runId);
      return true;
    },
    // A heartbeat run whose conversation is not in the processing list (e.g.
    // its row landed before the turn claim).
    listRunningHeartbeatRuns: async () => {
      enumerated.heartbeat += 1;
      return [{ runId: "heartbeat-run-1", conversationId: "conv-c" }];
    },
  };

  return {
    deps,
    cancelled,
    scheduleAborts,
    workflowAborts,
    cancelledTools,
    enumerated,
  };
}

describe("stopAllWork", () => {
  for (const mode of ["hard", "graceful"] as const) {
    test(`${mode} stops every category`, async () => {
      const harness = makeHarness();

      const counts = await stopAllWork(mode, harness.deps);

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
      expect(harness.cancelled).toEqual([
        { conversationId: "conv-a", mode },
        { conversationId: "conv-b", mode },
        { conversationId: "conv-c", mode },
      ]);
      expect(harness.scheduleAborts).toEqual(["schedule-run-1"]);
      expect(harness.workflowAborts).toEqual(["workflow-run-1"]);
      expect(harness.cancelledTools).toEqual([`stop-all:${mode}`]);
      expect(harness.enumerated).toEqual({
        schedule: 1,
        workflow: 1,
        heartbeat: 1,
      });
    });
  }

  test("main-only leaves non-conversation work untouched", async () => {
    const harness = makeHarness();

    const counts = await stopAllWork("main-only", harness.deps);

    // Only the conversations' main turns are stopped. `cancelGenerationWithMode`
    // already reports no subagents or ACP sessions for this mode.
    expect(counts).toEqual({
      conversations: 2,
      subagents: 0,
      acpSessions: 0,
      backgroundTools: 0,
      scheduleRuns: 0,
      workflowRuns: 0,
      heartbeatRuns: 0,
      memoryJobs: 0,
      unsupported: [],
    });
    expect(harness.cancelled).toEqual([
      { conversationId: "conv-a", mode: "main-only" },
      { conversationId: "conv-b", mode: "main-only" },
    ]);
    // The non-conversation categories are not even enumerated, so nothing can
    // be aborted by accident.
    expect(harness.cancelledTools).toEqual([]);
    expect(harness.scheduleAborts).toEqual([]);
    expect(harness.workflowAborts).toEqual([]);
    expect(harness.enumerated).toEqual({
      schedule: 0,
      workflow: 0,
      heartbeat: 0,
    });
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
