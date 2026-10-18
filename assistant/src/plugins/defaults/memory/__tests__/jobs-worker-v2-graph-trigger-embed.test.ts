/**
 * Regression: `graph_trigger_embed` must NOT be short-circuited when
 * `memory.v2.enabled` is true. The handler `embedGraphTriggerJob` writes
 * `conditionEmbedding` to SQLite and never touches the v1 Qdrant client, so
 * including it in `V1_QDRANT_JOB_TYPES` would leave semantic triggers
 * permanently unembedded under v2 and break `evaluateSemanticTriggers`
 * recall.
 */
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  afterAll,
  beforeAll,
  beforeEach,
  expect,
  mock,
  setDefaultTimeout,
  test,
} from "bun:test";

setDefaultTimeout(30_000);

import { eq } from "drizzle-orm";

// `memory.enabled` and `memory.v2.enabled` both default true, so the real
// loader reading this file's (empty) workspace config already yields the
// v2-enabled state this regression needs — no seeding required.

let triggerHandlerCalls = 0;

mock.module("../graph/graph-search.js", () => ({
  embedGraphNodeDirect: async () => {},
  embedGraphNodeJob: async (): Promise<void> => {},
  enqueueGraphNodeEmbed: () => {},
  embedGraphTriggerJob: async (): Promise<void> => {
    triggerHandlerCalls += 1;
  },
  enqueueGraphTriggerEmbed: () => {},
}));

// `searchGraphNodes` lives in the v1 tier, and the handler-registration import
// graph still reaches it (`job-handlers.js` → `v1/graph/extraction-job.js` →
// `v1/graph/extraction.js`). Stubbing it keeps the real Qdrant search module —
// and its client graph — out of this test, which is what makes the file
// hermetic and fast.
mock.module("../v1/graph/graph-search.js", () => ({
  searchGraphNodes: async () => [],
}));

mock.module("../../../../persistence/db-maintenance.js", () => ({
  maybeRunDbMaintenance: () => {},
}));

const tmpWorkspace = mkdtempSync(
  join(tmpdir(), "jobs-worker-v2-graph-trigger-embed-"),
);
const previousWorkspaceEnv = process.env.VELLUM_WORKSPACE_DIR;
process.env.VELLUM_WORKSPACE_DIR = tmpWorkspace;

import { describePg } from "../../../../__tests__/pg-test-db.js";
import { requireMainDb } from "../../../../persistence/db-facade.js";
import { _resetQdrantBreaker } from "../../../../persistence/embeddings/qdrant-circuit-breaker.js";
import { enqueueMemoryJob } from "../../../../persistence/jobs-store.js";
import { memoryJobs } from "../../../../persistence/schema/index.js";
import { registerMemoryPluginJobHandlers } from "../job-handler-registration.js";
import { runMemoryJobsOnce } from "../jobs-worker.js";

describePg("graph_trigger_embed under memory v2", () => {
  beforeAll(async () => {
    registerMemoryPluginJobHandlers();
  });

  afterAll(() => {
    if (previousWorkspaceEnv === undefined) {
      delete process.env.VELLUM_WORKSPACE_DIR;
    } else {
      process.env.VELLUM_WORKSPACE_DIR = previousWorkspaceEnv;
    }
    rmSync(tmpWorkspace, { recursive: true, force: true });
  });

  beforeEach(async () => {
    await requireMainDb().run("DELETE FROM memory_jobs");
    triggerHandlerCalls = 0;
    _resetQdrantBreaker();
  });

  test("handler runs (is not short-circuited) when v2 is enabled", async () => {
    const jobId = await enqueueMemoryJob("graph_trigger_embed", {
      triggerId: "trigger-123",
    });

    await runMemoryJobsOnce();

    expect(triggerHandlerCalls).toBe(1);

    const rows = await requireMainDb()
      .orm.select()
      .from(memoryJobs)
      .where(eq(memoryJobs.id, jobId));
    expect(rows[0]?.status).toBe("completed");
  });
});
