import { beforeEach, expect, test } from "bun:test";

import { eq } from "drizzle-orm";

import { requireMainDb } from "../persistence/db-facade.js";
import {
  enqueueMemoryJob,
  hasPendingJobOfType,
} from "../persistence/jobs-store.js";
import { describePg } from "./pg-test-db.js";

async function setStatus(id: string, status: string): Promise<void> {
  const db = requireMainDb();
  await db.orm
    .update(db.schema.memoryJobs)
    .set({ status })
    .where(eq(db.schema.memoryJobs.id, id));
}

describePg("hasPendingJobOfType", () => {
  beforeEach(async () => {
    const db = requireMainDb();
    await db.run("DELETE FROM memory_jobs");
  });

  test("false on an empty queue", async () => {
    expect(await hasPendingJobOfType("memory_v2_reembed")).toBe(false);
  });

  test("true when a pending job of the type exists", async () => {
    await enqueueMemoryJob("memory_v2_reembed", {});
    expect(await hasPendingJobOfType("memory_v2_reembed")).toBe(true);
  });

  test("false when the only job of the type is running", async () => {
    // The pending/running distinction is the point of this helper: a running
    // job may have snapshotted state before the caller's writes, so it must
    // not suppress a fresh enqueue (contrast `hasActiveJobOfType`).
    const id = await enqueueMemoryJob("memory_v2_reembed", {});
    await setStatus(id, "running");
    expect(await hasPendingJobOfType("memory_v2_reembed")).toBe(false);
  });

  test("false for completed and failed rows", async () => {
    await setStatus(
      await enqueueMemoryJob("memory_v2_reembed", {}),
      "completed",
    );
    await setStatus(await enqueueMemoryJob("memory_v2_reembed", {}), "failed");
    expect(await hasPendingJobOfType("memory_v2_reembed")).toBe(false);
  });

  test("scoped to the queried type", async () => {
    await enqueueMemoryJob("memory_v3_maintain", {});
    expect(await hasPendingJobOfType("memory_v2_reembed")).toBe(false);
    expect(await hasPendingJobOfType("memory_v3_maintain")).toBe(true);
  });
});
