/**
 * Tests for the `memory_v2/backfill` IPC route.
 *
 * The route is mutating — it inserts one `memory_jobs` row per call. We mock
 * `enqueueMemoryJob` at the module level so the tests can assert the exact
 * `(type, payload)` tuple the route forwards without standing up a real DB.
 *
 * Coverage:
 *   1. method name is the public verb expected by the CLI.
 *   2. unknown params are rejected (defensive — the schema is `.strict()`).
 *   3. the surviving `reembed` op dispatches to `memory_v2_reembed`.
 *   4. retired ops (`migrate`, `activation-recompute`) are rejected.
 *   5. invalid `op` values are rejected by the enum schema.
 */

import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";

import * as realJobsStore from "../../../persistence/jobs-store.js";

// ---------------------------------------------------------------------------
// Module-level mock — capture every enqueue call so each test can assert the
// route forwarded the correct (type, payload) tuple. The route file is
// imported below the mock so it picks up this stub instead of the real one.
// ---------------------------------------------------------------------------

const enqueueCalls: Array<{
  type: string;
  payload: Record<string, unknown>;
}> = [];
let nextJobId = 0;

// Spread the real module's exports so transitive importers (pulled in via
// the CLI program → memory indexer chain) get every named export they bind
// to at module-load time; only `enqueueMemoryJob` is overridden so the
// route under test forwards to the test stub. jobs-store.ts has no
// side-effecting top-level statements, so loading it for the spread is safe.
mock.module("../../../persistence/jobs-store.js", () => ({
  ...realJobsStore,
  enqueueMemoryJob: (type: string, payload: Record<string, unknown>) => {
    enqueueCalls.push({ type, payload });
    nextJobId += 1;
    return `test-job-${nextJobId}`;
  },
  upsertDebouncedJob: () => `test-debounced-${++nextJobId}`,
  hasActiveJobOfType: () => false,
  enqueuePruneOldLlmRequestLogsJob: () => `test-prune-${++nextJobId}`,
  enqueuePruneOldConversationsJob: () => `test-prune-conv-${++nextJobId}`,
  claimMemoryJobs: () => [],
  completeMemoryJob: () => {},
  deferMemoryJob: () => "deferred",
  failMemoryJob: () => {},
  resetRunningJobsToPending: () => 0,
  failStalledJobs: () => 0,
  getMemoryJobCounts: () => ({}),
}));

const { ROUTES: substrateRoutes } =
  await import("../../../plugins/defaults/memory/src/memory-substrate-routes.js");

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

type BackfillResult = { jobId: string };

const backfillRoute = substrateRoutes.find(
  (r) => r.operationId === "memory_v2_backfill",
)!;

async function runRoute(
  params: Record<string, unknown>,
): Promise<BackfillResult> {
  return (await backfillRoute.handler({ body: params })) as BackfillResult;
}

beforeEach(() => {
  enqueueCalls.length = 0;
  nextJobId = 0;
});

afterEach(() => {
  enqueueCalls.length = 0;
});

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("memory_v2_backfill route", () => {
  test("operationId is 'memory_v2_backfill'", () => {
    expect(backfillRoute.operationId).toBe("memory_v2_backfill");
  });

  test("rejects unknown op", async () => {
    await expect(runRoute({ op: "wat" })).rejects.toThrow();
    expect(enqueueCalls).toEqual([]);
  });

  test("rejects unknown params", async () => {
    await expect(runRoute({ op: "reembed", extra: 1 })).rejects.toThrow();
    expect(enqueueCalls).toEqual([]);
  });

  test("rejects missing op", async () => {
    await expect(runRoute({})).rejects.toThrow();
    expect(enqueueCalls).toEqual([]);
  });

  test("retired ops are rejected", async () => {
    for (const op of ["migrate", "activation-recompute", "rebuild-edges"]) {
      await expect(runRoute({ op })).rejects.toThrow();
    }
    expect(enqueueCalls).toEqual([]);
  });

  test("reembed enqueues memory_v2_reembed with empty payload", async () => {
    const result = await runRoute({ op: "reembed" });

    expect(enqueueCalls).toEqual([{ type: "memory_v2_reembed", payload: {} }]);
    expect(result.jobId).toBe("test-job-1");
  });

  test("reembed ignores the force flag", async () => {
    // `force` is accepted for wire compatibility but never forwarded.
    await runRoute({ op: "reembed", force: true });

    expect(enqueueCalls).toEqual([{ type: "memory_v2_reembed", payload: {} }]);
  });
});
