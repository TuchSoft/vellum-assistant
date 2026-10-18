/**
 * Lifecycle drain endpoints backing `vellum sleep --wait`.
 *
 * The quiesce lease pauses the STARTING of new background LLM work (heartbeat
 * beats, schedule/watcher/sequence claims, memory-job claims) across the
 * daemon and its worker processes; drain-status reports what is still in
 * flight so a client can wait for the assistant to go idle before stopping
 * it. Enqueue paths stay open — work queued during a drain runs after the
 * next start. The lease is TTL-bound and refreshed by the waiting client, so
 * an abandoned drain can never leave background work paused.
 */

import { z } from "zod";

import { stopAllWork } from "../../daemon/stop-all.js";
import {
  listRunningHeartbeatRuns,
  RUNNING_HEARTBEAT_MAX_AGE_MS,
} from "../../heartbeat/heartbeat-run-store.js";
import { listProcessingConversations } from "../../persistence/conversation-crud.js";
import { listRunningMemoryJobs } from "../../persistence/jobs-store.js";
import {
  clearLifecycleQuiesce,
  DEFAULT_QUIESCE_TTL_MS,
  getLifecycleQuiesceUntil,
  setLifecycleQuiesce,
} from "../../persistence/lifecycle-quiesce.js";
import { listRunningScheduleRuns } from "../../schedule/schedule-store.js";
import { getLogger } from "../../util/logger.js";
import { listRuns as listWorkflowRuns } from "../../workflows/journal-store.js";
import { ACTOR_PRINCIPALS } from "../auth/route-policy.js";
import { BadRequestError } from "./errors.js";
import { parseStopMode } from "./stop-mode.js";
import type { RouteDefinition, RouteHandlerArgs } from "./types.js";

const log = getLogger("lifecycle-routes");

const quiesceResponseSchema = z.object({
  quiescedUntil: z
    .number()
    .describe("Epoch ms when the quiesce lease expires."),
});

const activeConversationSchema = z.object({
  conversationId: z.string(),
  title: z.string().nullable(),
  originChannel: z.string().nullable(),
  originInterface: z.string().nullable(),
  processingStartedAt: z.number(),
});

const runningMemoryJobSchema = z.object({
  id: z.string(),
  type: z.string(),
  startedAt: z.number().nullable(),
});

const runningScheduleRunSchema = z.object({
  runId: z.string(),
  scheduleName: z.string().nullable(),
  startedAt: z.number(),
});

const runningWorkflowRunSchema = z.object({
  runId: z.string(),
  name: z.string().nullable(),
  startedAt: z.number().nullable(),
});

const runningHeartbeatRunSchema = z.object({
  runId: z.string(),
  startedAt: z.number(),
});

const stopAllResponseSchema = z.object({
  conversations: z.number(),
  subagents: z.number(),
  acpSessions: z.number(),
  backgroundTools: z.number(),
  scheduleRuns: z.number(),
  workflowRuns: z.number(),
  heartbeatRuns: z.number(),
  memoryJobs: z.number(),
  unsupported: z.array(z.string()),
});

const drainStatusResponseSchema = z.object({
  quiescedUntil: z.number().nullable(),
  idle: z
    .boolean()
    .describe(
      "True when no conversation turn, memory job, schedule run, workflow run, or heartbeat run is in flight.",
    ),
  activeConversations: z.array(activeConversationSchema),
  memoryJobs: z.array(runningMemoryJobSchema),
  scheduleRuns: z.array(runningScheduleRunSchema),
  workflowRuns: z.array(runningWorkflowRunSchema),
  heartbeatRuns: z.array(runningHeartbeatRunSchema),
});

export const ROUTES: RouteDefinition[] = [
  {
    operationId: "quiesceLifecycle",
    endpoint: "lifecycle/quiesce",
    method: "POST",
    policy: {
      requiredScopes: ["settings.write"],
      allowedPrincipalTypes: ACTOR_PRINCIPALS,
    },
    summary: "Arm or refresh the drain quiesce lease",
    description:
      "Pauses the starting of new background work (heartbeat, schedules, watchers, sequences, memory jobs) for the lease TTL. Refresh by calling again; the lease self-expires so an abandoned drain never leaves background work paused.",
    tags: ["system"],
    requestBody: z.object({
      ttlMs: z
        .number()
        .optional()
        .describe("Lease TTL in ms (clamped to a sane range)."),
    }),
    responseBody: quiesceResponseSchema,
    handler: async (args: RouteHandlerArgs) => {
      const raw = args.body?.ttlMs;
      let ttlMs = DEFAULT_QUIESCE_TTL_MS;
      if (raw !== undefined) {
        if (typeof raw !== "number" || !Number.isFinite(raw)) {
          throw new BadRequestError("ttlMs must be a finite number");
        }
        ttlMs = raw;
      }
      const quiescedUntil = await setLifecycleQuiesce(ttlMs);
      log.info({ quiescedUntil }, "Lifecycle quiesce lease armed");
      return { quiescedUntil };
    },
  },
  {
    operationId: "releaseLifecycleQuiesce",
    endpoint: "lifecycle/quiesce",
    method: "DELETE",
    policy: {
      requiredScopes: ["settings.write"],
      allowedPrincipalTypes: ACTOR_PRINCIPALS,
    },
    summary: "Release the drain quiesce lease",
    description:
      "Resumes background work immediately instead of waiting for the lease TTL to expire (e.g. when a drain is cancelled).",
    tags: ["system"],
    responseBody: z.object({ released: z.boolean() }),
    handler: async () => {
      await clearLifecycleQuiesce();
      log.info("Lifecycle quiesce lease released");
      return { released: true };
    },
  },
  {
    operationId: "stopAllLifecycleWork",
    endpoint: "lifecycle/stop-all",
    method: "POST",
    policy: {
      requiredScopes: ["settings.write"],
      allowedPrincipalTypes: ACTOR_PRINCIPALS,
    },
    summary: "Stop all in-flight work",
    description:
      "Stops every category of in-flight work the drain snapshot enumerates: processing conversations (plus their subagents and ACP sessions), background tools, running schedule/heartbeat runs, and in-flight workflow runs. Memory jobs are reported in `unsupported` and left untouched. The optional mode defaults to hard. `main-only` acts only on processing conversations: background tools and scheduled work stay alive.",
    tags: ["system"],
    requestBody: z.object({
      mode: z
        .enum(["hard", "graceful", "main-only"])
        .optional()
        .describe("Stop mode applied to conversations. Defaults to hard."),
    }),
    responseBody: stopAllResponseSchema,
    handler: async ({ body }: RouteHandlerArgs) => {
      const mode = parseStopMode(body);
      return stopAllWork(mode);
    },
  },
  {
    operationId: "getLifecycleDrainStatus",
    endpoint: "lifecycle/drain-status",
    method: "GET",
    policy: {
      requiredScopes: ["settings.read"],
      allowedPrincipalTypes: ACTOR_PRINCIPALS,
    },
    summary: "In-flight background work",
    description:
      "Reports conversation turns, memory jobs, schedule runs, workflow runs, and heartbeat runs currently in flight, plus the active quiesce lease. `idle: true` means it is safe to stop the assistant without interrupting work.",
    tags: ["system"],
    responseBody: drainStatusResponseSchema,
    handler: async () => {
      // Every read THROWS on failure (surfacing as a 5xx the client retries):
      // for a drain decision, a failed read must not pass for proof of
      // absence, or the client stops the assistant over unobservable
      // in-flight work. Only the quiesce GATES are fail-open — this snapshot
      // fails closed.
      const activeConversations = await listProcessingConversations();
      const memoryJobs = await listRunningMemoryJobs();
      const scheduleRuns = (await listRunningScheduleRuns()).map(
        ({ runId, scheduleName, startedAt }) => ({
          runId,
          scheduleName,
          startedAt,
        }),
      );
      // Workflows launched by a schedule outlive their schedule run — the
      // scheduler fires them and completes its own run row immediately — so
      // a running workflow must hold the drain open in its own right.
      const workflowRuns = (
        await listWorkflowRuns({
          limit: 20,
          status: "running",
        })
      ).map((run) => ({
        runId: run.id,
        name: run.name,
        startedAt: run.createdAt,
      }));
      // A beat between startHeartbeatRun() and its background conversation
      // existing (e.g. mid credential-health check) has a running row but no
      // processing conversation yet.
      const heartbeatRuns = (
        await listRunningHeartbeatRuns(RUNNING_HEARTBEAT_MAX_AGE_MS)
      ).map(({ runId, startedAt }) => ({ runId, startedAt }));
      return {
        quiescedUntil: await getLifecycleQuiesceUntil(),
        idle:
          activeConversations.length === 0 &&
          memoryJobs.length === 0 &&
          scheduleRuns.length === 0 &&
          workflowRuns.length === 0 &&
          heartbeatRuns.length === 0,
        activeConversations,
        memoryJobs,
        scheduleRuns,
        workflowRuns,
        heartbeatRuns,
      };
    },
  },
];
