import { beforeEach, expect, test } from "bun:test";

import { eq } from "drizzle-orm";

import { requireMainDb } from "../persistence/db-facade.js";
import {
  enqueueMemoryJob,
  upsertDebouncedJob,
} from "../persistence/jobs-store.js";
import { describePg } from "./pg-test-db.js";

describePg("upsertDebouncedJob payload refresh", () => {
  beforeEach(async () => {
    const db = requireMainDb();
    await db.run("DELETE FROM memory_jobs");
  });

  test("merges new payload keys into existing pending row (upgrade scenario)", async () => {
    // Simulate a legacy pending row enqueued before `scopeId` was
    // added to the payload shape.
    const legacyId = await enqueueMemoryJob(
      "graph_extract",
      { conversationId: "conv-1" },
      Date.now() + 300_000,
    );

    // A batch trigger from the current build passes `scopeId`.
    await upsertDebouncedJob(
      "graph_extract",
      { conversationId: "conv-1", scopeId: "private-scope" },
      Date.now(),
    );

    const db = requireMainDb();
    const rows = await db.orm
      .select()
      .from(db.schema.memoryJobs)
      .where(eq(db.schema.memoryJobs.type, "graph_extract"));

    expect(rows).toHaveLength(1);
    expect(rows[0]!.id).toBe(legacyId);
    const payload = JSON.parse(rows[0]!.payload) as {
      conversationId: string;
      scopeId?: string;
    };
    expect(payload.conversationId).toBe("conv-1");
    expect(payload.scopeId).toBe("private-scope");
  });

  test("later call overrides existing payload keys", async () => {
    await enqueueMemoryJob(
      "graph_extract",
      { conversationId: "conv-2", scopeId: "default" },
      Date.now() + 300_000,
    );

    await upsertDebouncedJob(
      "graph_extract",
      { conversationId: "conv-2", scopeId: "newer-scope" },
      Date.now(),
    );

    const db = requireMainDb();
    const rows = await db.orm
      .select()
      .from(db.schema.memoryJobs)
      .where(eq(db.schema.memoryJobs.type, "graph_extract"));

    expect(rows).toHaveLength(1);
    const payload = JSON.parse(rows[0]!.payload) as { scopeId?: string };
    expect(payload.scopeId).toBe("newer-scope");
  });

  test("updates runAfter on match", async () => {
    const runAfterOriginal = Date.now() + 300_000;
    await enqueueMemoryJob(
      "graph_extract",
      { conversationId: "conv-3", scopeId: "default" },
      runAfterOriginal,
    );

    const runAfterNew = Date.now();
    await upsertDebouncedJob(
      "graph_extract",
      { conversationId: "conv-3", scopeId: "default" },
      runAfterNew,
    );

    const db = requireMainDb();
    const rows = await db.orm
      .select()
      .from(db.schema.memoryJobs)
      .where(eq(db.schema.memoryJobs.type, "graph_extract"));

    expect(rows).toHaveLength(1);
    expect(rows[0]!.runAfter).toBe(runAfterNew);
  });

  test("inserts a new row when no pending job matches", async () => {
    await upsertDebouncedJob(
      "graph_extract",
      { conversationId: "conv-4", scopeId: "default" },
      Date.now(),
    );

    const db = requireMainDb();
    const rows = await db.orm
      .select()
      .from(db.schema.memoryJobs)
      .where(eq(db.schema.memoryJobs.type, "graph_extract"));

    expect(rows).toHaveLength(1);
    const payload = JSON.parse(rows[0]!.payload) as {
      conversationId: string;
      scopeId?: string;
    };
    expect(payload.conversationId).toBe("conv-4");
    expect(payload.scopeId).toBe("default");
  });
});
