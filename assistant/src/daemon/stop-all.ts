/**
 * Global stop: terminate every category of in-flight work the daemon can
 * enumerate, using the same enumerators as `GET /lifecycle/drain-status`.
 *
 * Stop modes apply per conversation (see {@link cancelGenerationWithMode}).
 * Background tools are cancelled unconditionally: their cancel path has no
 * modes. Schedule and heartbeat runs are stopped through the conversation that
 * owns their turn. Workflow runs are aborted through the in-flight registry,
 * and a `running` row this process does not own is reported as unreachable
 * rather than rewritten: the engine owns its own row's terminal status.
 *
 * Memory jobs are listed but never touched. Their manager exposes no safe
 * per-job cancel, so the category is reported in `unsupported` instead of a
 * best-effort interruption that could strand a claimed job.
 */

import {
  listRunningHeartbeatRuns,
  RUNNING_HEARTBEAT_MAX_AGE_MS,
} from "../heartbeat/heartbeat-run-store.js";
import { listProcessingConversations } from "../persistence/conversation-crud.js";
import { listRunningMemoryJobs } from "../persistence/jobs-store.js";
import { listRunningScheduleRuns } from "../schedule/schedule-store.js";
import { cancelBackgroundTools } from "../tools/background-tool-registry.js";
import { getLogger } from "../util/logger.js";
import type { StopMode } from "../util/stop-mode.js";
import { listRuns as listWorkflowRuns } from "../workflows/journal-store.js";
import { getWorkflowRunManager } from "../workflows/run-manager.js";
import { findConversationOrSubagent } from "./conversation-registry.js";
import {
  type CancelGenerationOutcome,
  cancelGenerationWithMode,
} from "./handlers/conversations.js";

const log = getLogger("stop-all");

/**
 * Stop-all must not leave work behind, so its enumerator calls are unbounded.
 * The drain snapshot caps its lists because it renders them; this operation
 * does not.
 */
const UNBOUNDED = Number.MAX_SAFE_INTEGER;

export interface StopAllCounts {
  /** Processing conversations whose main turn was signalled. */
  conversations: number;
  /** Child subagents aborted as part of a parent stop. */
  subagents: number;
  /** ACP agent sessions a cancel was kicked off for. */
  acpSessions: number;
  /** Background tools cancelled from the registry. */
  backgroundTools: number;
  /** Running schedule runs whose conversation turn was stopped. */
  scheduleRuns: number;
  /** In-flight workflow runs aborted in this process. */
  workflowRuns: number;
  /** Running heartbeat runs whose conversation turn was stopped. */
  heartbeatRuns: number;
  /** Always 0: memory jobs are never interrupted (see `unsupported`). */
  memoryJobs: number;
  /** Categories this build cannot stop safely. */
  unsupported: string[];
}

interface RunningScheduleRun {
  runId: string;
  conversationId: string | null;
}

interface RunningWorkflowRun {
  runId: string;
}

interface RunningHeartbeatRun {
  runId: string;
  conversationId: string | null;
}

interface StopableConversation {
  abortScheduledRun(runId: string): void;
}

export interface StopAllDeps {
  listProcessingConversations: () => Promise<Array<{ conversationId: string }>>;
  listRunningMemoryJobs: () => Promise<Array<unknown>>;
  listRunningScheduleRuns: () => Promise<RunningScheduleRun[]>;
  listRunningWorkflowRuns: () => Promise<RunningWorkflowRun[]>;
  listRunningHeartbeatRuns: () => Promise<RunningHeartbeatRun[]>;
  cancelGeneration: (
    conversationId: string,
    mode: StopMode,
  ) => CancelGenerationOutcome;
  cancelBackgroundTools: (
    shouldCancel: (tool: unknown) => boolean,
    reason?: string,
  ) => Array<unknown>;
  findConversationOrSubagent: (
    conversationId: string | undefined,
  ) => StopableConversation | undefined;
  abortWorkflowRun: (runId: string) => boolean;
}

function defaultDeps(): StopAllDeps {
  return {
    listProcessingConversations: () => listProcessingConversations(UNBOUNDED),
    listRunningMemoryJobs,
    listRunningScheduleRuns: () => listRunningScheduleRuns(UNBOUNDED),
    listRunningWorkflowRuns: async () =>
      (
        await listWorkflowRuns({
          limit: UNBOUNDED,
          status: "running",
        })
      ).map((run) => ({ runId: run.id })),
    listRunningHeartbeatRuns: () =>
      listRunningHeartbeatRuns(RUNNING_HEARTBEAT_MAX_AGE_MS, UNBOUNDED),
    cancelGeneration: cancelGenerationWithMode,
    cancelBackgroundTools: (shouldCancel, reason) =>
      cancelBackgroundTools((tool) => shouldCancel(tool), reason),
    findConversationOrSubagent,
    abortWorkflowRun: (runId) => getWorkflowRunManager().abort(runId),
  };
}

export async function stopAllWork(
  mode: StopMode,
  deps: StopAllDeps = defaultDeps(),
): Promise<StopAllCounts> {
  const counts: StopAllCounts = {
    conversations: 0,
    subagents: 0,
    acpSessions: 0,
    backgroundTools: 0,
    scheduleRuns: 0,
    workflowRuns: 0,
    heartbeatRuns: 0,
    memoryJobs: 0,
    unsupported: [],
  };
  const stoppedConversationIds = new Set<string>();

  const activeConversations = await deps.listProcessingConversations();
  for (const conversation of activeConversations) {
    const outcome = deps.cancelGeneration(conversation.conversationId, mode);
    if (!outcome.found) {
      continue;
    }
    counts.conversations += 1;
    counts.subagents += outcome.subagents;
    counts.acpSessions += outcome.acpSessions;
    stoppedConversationIds.add(conversation.conversationId);
  }

  counts.backgroundTools = deps.cancelBackgroundTools(
    () => true,
    `stop-all:${mode}`,
  ).length;

  const scheduleRuns = await deps.listRunningScheduleRuns();
  for (const run of scheduleRuns) {
    const conversation = deps.findConversationOrSubagent(
      run.conversationId ?? undefined,
    );
    if (!conversation) {
      log.warn(
        { runId: run.runId, conversationId: run.conversationId },
        "Running schedule run has no live conversation in this process",
      );
      continue;
    }
    conversation.abortScheduledRun(run.runId);
    counts.scheduleRuns += 1;
  }

  const workflowRuns = await deps.listRunningWorkflowRuns();
  for (const run of workflowRuns) {
    if (deps.abortWorkflowRun(run.runId)) {
      counts.workflowRuns += 1;
    } else {
      log.warn(
        { runId: run.runId },
        "Running workflow run is not in flight in this process; leaving its row to its owner",
      );
    }
  }

  const heartbeatRuns = await deps.listRunningHeartbeatRuns();
  for (const run of heartbeatRuns) {
    const conversationId = run.conversationId ?? undefined;
    if (!conversationId) {
      log.warn(
        { runId: run.runId },
        "Running heartbeat run has no conversation to stop",
      );
      continue;
    }
    if (!stoppedConversationIds.has(conversationId)) {
      const outcome = deps.cancelGeneration(conversationId, mode);
      if (!outcome.found) {
        log.warn(
          { runId: run.runId, conversationId },
          "Running heartbeat run has no live conversation in this process",
        );
        continue;
      }
      counts.subagents += outcome.subagents;
      counts.acpSessions += outcome.acpSessions;
    }
    counts.heartbeatRuns += 1;
  }

  const memoryJobs = await deps.listRunningMemoryJobs();
  if (memoryJobs.length > 0) {
    counts.unsupported.push("memoryJobs");
  }

  log.info(
    {
      mode,
      conversations: counts.conversations,
      subagents: counts.subagents,
      acpSessions: counts.acpSessions,
      backgroundTools: counts.backgroundTools,
      scheduleRuns: counts.scheduleRuns,
      workflowRuns: counts.workflowRuns,
      heartbeatRuns: counts.heartbeatRuns,
      runningMemoryJobs: memoryJobs.length,
      unsupported: counts.unsupported,
    },
    "Stop-all finished",
  );

  return counts;
}
