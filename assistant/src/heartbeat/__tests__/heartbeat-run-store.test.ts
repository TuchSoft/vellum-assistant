import { beforeEach, expect, test } from "bun:test";

import { sql } from "drizzle-orm";

import { describePg } from "../../__tests__/pg-test-db.js";
import { requireMainDb } from "../../persistence/db-facade.js";
import {
  completeHeartbeatRun,
  countCompletedHeartbeatRuns,
  getLastHeartbeatRunAt,
  insertPendingHeartbeatRun,
  listHeartbeatRuns,
  markStaleRunningAsError,
  markStaleRunsAsMissed,
  skipHeartbeatRun,
  startHeartbeatRun,
  supersedePendingRun,
} from "../heartbeat-run-store.js";

/**
 * Raw read-back of every row (any status). `listHeartbeatRuns` serves run
 * history and hides bookkeeping rows (pending/superseded), so tests that
 * assert on those statuses read the table directly.
 */
async function allRuns() {
  const db = requireMainDb();
  return db.orm
    .select()
    .from(db.schema.heartbeatRuns)
    .orderBy(sql`${db.schema.heartbeatRuns.scheduledFor} DESC`);
}

describePg("heartbeat-run-store", () => {
  beforeEach(async () => {
    const db = requireMainDb();
    await db.run("DELETE FROM heartbeat_runs");
  });

  test("insertPendingHeartbeatRun creates row with status pending and null timing", async () => {
    const scheduledFor = Date.now();
    const id = await insertPendingHeartbeatRun(scheduledFor);
    expect(id).toBeTruthy();

    const rows = await allRuns();
    expect(rows).toHaveLength(1);
    expect(rows[0].id).toBe(id);
    expect(rows[0].status).toBe("pending");
    expect(rows[0].scheduledFor).toBe(scheduledFor);
    expect(rows[0].startedAt).toBeNull();
    expect(rows[0].finishedAt).toBeNull();
    expect(rows[0].durationMs).toBeNull();
    expect(rows[0].error).toBeNull();
    expect(rows[0].conversationId).toBeNull();
    expect(rows[0].skipReason).toBeNull();
  });

  test("startHeartbeatRun transitions pending -> running and sets startedAt", async () => {
    const id = await insertPendingHeartbeatRun(Date.now());
    const ok = await startHeartbeatRun(id);
    expect(ok).toBe(true);

    const rows = await listHeartbeatRuns();
    expect(rows[0].status).toBe("running");
    expect(rows[0].startedAt).toBeGreaterThan(0);
  });

  test("startHeartbeatRun returns false for non-pending row", async () => {
    const id = await insertPendingHeartbeatRun(Date.now());

    // Start once — succeeds
    expect(await startHeartbeatRun(id)).toBe(true);
    // Start again — fails (already running)
    expect(await startHeartbeatRun(id)).toBe(false);

    // Also: superseded row cannot be started
    const id2 = await insertPendingHeartbeatRun(Date.now());
    await supersedePendingRun(id2);
    expect(await startHeartbeatRun(id2)).toBe(false);
  });

  test("completeHeartbeatRun transitions running -> ok with conversationId", async () => {
    const id = await insertPendingHeartbeatRun(Date.now());
    await startHeartbeatRun(id);
    const ok = await completeHeartbeatRun(id, {
      status: "ok",
      conversationId: "conv-123",
    });
    expect(ok).toBe(true);

    const rows = await listHeartbeatRuns();
    expect(rows[0].status).toBe("ok");
    expect(rows[0].conversationId).toBe("conv-123");
    expect(rows[0].finishedAt).toBeGreaterThan(0);
    expect(rows[0].durationMs).toBeGreaterThanOrEqual(0);
  });

  test("completeHeartbeatRun transitions running -> error with truncated error", async () => {
    const id = await insertPendingHeartbeatRun(Date.now());
    await startHeartbeatRun(id);

    // 3KB string — should be truncated to 2000 chars
    const longError = "x".repeat(3000);
    const ok = await completeHeartbeatRun(id, {
      status: "error",
      error: longError,
    });
    expect(ok).toBe(true);

    const rows = await listHeartbeatRuns();
    expect(rows[0].status).toBe("error");
    expect(rows[0].error).toHaveLength(2000);
  });

  test("completeHeartbeatRun returns false when status is not running (CAS)", async () => {
    const id = await insertPendingHeartbeatRun(Date.now());
    await startHeartbeatRun(id);
    // Complete with timeout
    await completeHeartbeatRun(id, { status: "timeout" });
    // Try to complete again with ok — should fail (already timeout)
    const ok = await completeHeartbeatRun(id, { status: "ok" });
    expect(ok).toBe(false);

    const rows = await listHeartbeatRuns();
    expect(rows[0].status).toBe("timeout");
  });

  test("skipHeartbeatRun transitions pending -> skipped with reason", async () => {
    const id = await insertPendingHeartbeatRun(Date.now());
    const ok = await skipHeartbeatRun(id, "outside_active_hours");
    expect(ok).toBe(true);

    const rows = await listHeartbeatRuns();
    expect(rows[0].status).toBe("skipped");
    expect(rows[0].skipReason).toBe("outside_active_hours");
  });

  test("skipHeartbeatRun returns false for non-pending row", async () => {
    const id = await insertPendingHeartbeatRun(Date.now());
    await startHeartbeatRun(id);
    const ok = await skipHeartbeatRun(id, "disabled");
    expect(ok).toBe(false);
  });

  test("supersedePendingRun transitions pending -> superseded", async () => {
    const id = await insertPendingHeartbeatRun(Date.now());
    const ok = await supersedePendingRun(id);
    expect(ok).toBe(true);

    const rows = await allRuns();
    expect(rows[0].status).toBe("superseded");
  });

  test("supersedePendingRun returns false for non-pending row", async () => {
    const id = await insertPendingHeartbeatRun(Date.now());
    await startHeartbeatRun(id);
    const ok = await supersedePendingRun(id);
    expect(ok).toBe(false);
  });

  test("markStaleRunsAsMissed transitions old pending rows to missed", async () => {
    const now = Date.now();
    // Two old pending rows
    const id1 = await insertPendingHeartbeatRun(now - 10 * 60 * 1000);
    const id2 = await insertPendingHeartbeatRun(now - 8 * 60 * 1000);
    // One recent pending row
    const id3 = await insertPendingHeartbeatRun(now);

    const count = await markStaleRunsAsMissed(5 * 60 * 1000);
    expect(count).toBe(2);

    const rows = await allRuns();
    const byId = Object.fromEntries(rows.map((r) => [r.id, r]));
    expect(byId[id1].status).toBe("missed");
    expect(byId[id2].status).toBe("missed");
    expect(byId[id3].status).toBe("pending");
  });

  test("markStaleRunningAsError transitions old running rows to error", async () => {
    const now = Date.now();
    const id = await insertPendingHeartbeatRun(now - 60 * 60 * 1000);
    await startHeartbeatRun(id);

    // Backdate started_at to simulate a long-running process
    const db = requireMainDb();
    const backdatedStartedAt = now - 60 * 60 * 1000;
    await db.run("UPDATE heartbeat_runs SET started_at = ? WHERE id = ?", [
      backdatedStartedAt,
      id,
    ]);

    const count = await markStaleRunningAsError(45 * 60 * 1000);
    expect(count).toBe(1);

    const rows = await listHeartbeatRuns();
    expect(rows[0].status).toBe("error");
    expect(rows[0].error).toBe("Process crashed or restarted during execution");
  });

  test("listHeartbeatRuns returns rows ordered by scheduledFor desc", async () => {
    const now = Date.now();
    await skipHeartbeatRun(
      await insertPendingHeartbeatRun(now - 2000),
      "overlap",
    );
    await skipHeartbeatRun(await insertPendingHeartbeatRun(now), "overlap");
    await skipHeartbeatRun(
      await insertPendingHeartbeatRun(now - 1000),
      "overlap",
    );

    const rows = await listHeartbeatRuns();
    expect(rows).toHaveLength(3);
    expect(rows[0].scheduledFor).toBe(now);
    expect(rows[1].scheduledFor).toBe(now - 1000);
    expect(rows[2].scheduledFor).toBe(now - 2000);
  });

  test("listHeartbeatRuns respects limit", async () => {
    const now = Date.now();
    for (let i = 0; i < 5; i++) {
      await skipHeartbeatRun(
        await insertPendingHeartbeatRun(now + i),
        "overlap",
      );
    }

    const rows = await listHeartbeatRuns(3);
    expect(rows).toHaveLength(3);
  });

  test("listHeartbeatRuns hides bookkeeping rows (pending, superseded)", async () => {
    const now = Date.now();

    // Superseded rows: pending runs replaced by timer resets, scheduled in
    // the future at insert time — never ran.
    for (let i = 0; i < 3; i++) {
      await supersedePendingRun(
        await insertPendingHeartbeatRun(now + 60 * 60 * 1000 + i),
      );
    }
    // The not-yet-fired next scheduled run.
    await insertPendingHeartbeatRun(now + 60 * 60 * 1000 + 10);

    // Real history: a completed run, a skipped run, a missed run, and one
    // in flight.
    const okId = await insertPendingHeartbeatRun(now - 3000);
    await startHeartbeatRun(okId);
    await completeHeartbeatRun(okId, {
      status: "ok",
      conversationId: "conv-1",
    });
    const skippedId = await insertPendingHeartbeatRun(now - 2000);
    await skipHeartbeatRun(skippedId, "outside_active_hours");
    const missedId = await insertPendingHeartbeatRun(now - 10 * 60 * 1000);
    await markStaleRunsAsMissed(5 * 60 * 1000);
    const runningId = await insertPendingHeartbeatRun(now - 1000);
    await startHeartbeatRun(runningId);

    const rows = await listHeartbeatRuns();
    expect(rows.map((r) => r.id).sort()).toEqual(
      [okId, skippedId, missedId, runningId].sort(),
    );

    // The pagination cursor path applies the same filter.
    const paged = await listHeartbeatRuns(10, now + 2 * 60 * 60 * 1000);
    expect(paged.map((r) => r.id).sort()).toEqual(
      [okId, skippedId, missedId, runningId].sort(),
    );
  });

  test("countCompletedHeartbeatRuns counts only ok rows", async () => {
    const now = Date.now();

    // Insert runs with various statuses
    const id1 = await insertPendingHeartbeatRun(now);
    await startHeartbeatRun(id1);
    await completeHeartbeatRun(id1, { status: "ok", conversationId: "conv-1" });

    const id2 = await insertPendingHeartbeatRun(now + 1);
    await startHeartbeatRun(id2);
    await completeHeartbeatRun(id2, {
      status: "error",
      error: "something broke",
    });

    const id3 = await insertPendingHeartbeatRun(now + 2);
    await skipHeartbeatRun(id3, "disabled");

    const id4 = await insertPendingHeartbeatRun(now + 3);
    await startHeartbeatRun(id4);
    await completeHeartbeatRun(id4, { status: "ok", conversationId: "conv-2" });

    expect(await countCompletedHeartbeatRuns()).toBe(2);
  });

  test("countCompletedHeartbeatRuns returns 0 when no ok rows exist", async () => {
    const now = Date.now();

    const id1 = await insertPendingHeartbeatRun(now);
    await startHeartbeatRun(id1);
    await completeHeartbeatRun(id1, { status: "error", error: "fail" });

    const id2 = await insertPendingHeartbeatRun(now + 1);
    await skipHeartbeatRun(id2, "outside_active_hours");

    expect(await countCompletedHeartbeatRuns()).toBe(0);
  });

  test("getLastHeartbeatRunAt returns the newest executed-run timestamp", async () => {
    const now = Date.now();

    const oldId = await insertPendingHeartbeatRun(now - 5000);
    await startHeartbeatRun(oldId);
    await completeHeartbeatRun(oldId, {
      status: "ok",
      conversationId: "conv-1",
    });

    const newId = await insertPendingHeartbeatRun(now - 1000);
    await startHeartbeatRun(newId);
    await completeHeartbeatRun(newId, { status: "error", error: "fail" });

    // Non-executed rows never contribute, even when newer.
    await skipHeartbeatRun(
      await insertPendingHeartbeatRun(now),
      "outside_active_hours",
    );
    await insertPendingHeartbeatRun(now + 60 * 60 * 1000);

    const newRow = (await allRuns()).find((r) => r.id === newId);
    expect(await getLastHeartbeatRunAt()).toBe(newRow!.finishedAt!);
  });

  test("getLastHeartbeatRunAt falls back to startedAt when finishedAt is null", async () => {
    const now = Date.now();
    const id = await insertPendingHeartbeatRun(now - 60 * 60 * 1000);
    await startHeartbeatRun(id);
    const db = requireMainDb();
    const backdatedStartedAt = now - 60 * 60 * 1000;
    await db.run("UPDATE heartbeat_runs SET started_at = ? WHERE id = ?", [
      backdatedStartedAt,
      id,
    ]);
    // Crash sweep finalizes the row as error without a finishedAt.
    await markStaleRunningAsError(45 * 60 * 1000);

    expect(await getLastHeartbeatRunAt()).toBe(backdatedStartedAt);
  });

  test("getLastHeartbeatRunAt returns null when no run ever executed", async () => {
    expect(await getLastHeartbeatRunAt()).toBeNull();

    await skipHeartbeatRun(
      await insertPendingHeartbeatRun(Date.now()),
      "disabled",
    );
    await supersedePendingRun(await insertPendingHeartbeatRun(Date.now() + 1));

    expect(await getLastHeartbeatRunAt()).toBeNull();
  });
});
