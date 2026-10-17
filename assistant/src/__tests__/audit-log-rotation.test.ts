import { randomBytes } from "node:crypto";
import { beforeEach, expect, test } from "bun:test";

import { requireMainDb } from "../persistence/db-facade.js";
import {
  getRecentInvocations,
  rotateToolInvocations,
} from "../telemetry/tool-usage-store.js";
import { describePg } from "./pg-test-db.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

async function addInvocation(ageMs: number): Promise<void> {
  const db = requireMainDb();
  await db.orm.insert(db.schema.toolInvocations).values({
    id: randomBytes(8).toString("hex"),
    conversationId: "conv-1",
    toolName: "bash",
    input: '{"command":"echo hi"}',
    result: "hi",
    decision: "allow",
    riskLevel: "Low",
    durationMs: 100,
    createdAt: Date.now() - ageMs,
  });
}

async function clearTable(): Promise<void> {
  await requireMainDb().run("DELETE FROM tool_invocations");
}

const ONE_DAY_MS = 24 * 60 * 60 * 1000;

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describePg("audit log rotation", () => {
  beforeEach(async () => {
    await clearTable();
    // Insert a conversations row so FK-enforced ORM inserts succeed.
    await requireMainDb()
      .orm.insert(requireMainDb().schema.conversations)
      .values({
        id: "conv-1",
        title: "test",
        createdAt: Date.now(),
        updatedAt: Date.now(),
      })
      .onConflictDoNothing();
  });

  test("returns 0 when retentionDays is 0 (retain forever)", async () => {
    await addInvocation(100 * ONE_DAY_MS); // 100 days old
    const deleted = await rotateToolInvocations(0);
    expect(deleted).toBe(0);
    expect((await getRecentInvocations(100)).length).toBe(1);
  });

  test("returns 0 when retentionDays is negative", async () => {
    await addInvocation(100 * ONE_DAY_MS);
    const deleted = await rotateToolInvocations(-5);
    expect(deleted).toBe(0);
    expect((await getRecentInvocations(100)).length).toBe(1);
  });

  test("deletes records older than retentionDays", async () => {
    await addInvocation(10 * ONE_DAY_MS); // 10 days old, deleted with 7-day retention
    await addInvocation(3 * ONE_DAY_MS); // 3 days old, kept
    await addInvocation(1 * ONE_DAY_MS); // 1 day old, kept

    const deleted = await rotateToolInvocations(7);
    expect(deleted).toBe(1);
    expect((await getRecentInvocations(100)).length).toBe(2);
  });

  test("keeps all records when none exceed retention", async () => {
    await addInvocation(1 * ONE_DAY_MS);
    await addInvocation(2 * ONE_DAY_MS);
    await addInvocation(3 * ONE_DAY_MS);

    const deleted = await rotateToolInvocations(30);
    expect(deleted).toBe(0);
    expect((await getRecentInvocations(100)).length).toBe(3);
  });

  test("deletes all records when all exceed retention", async () => {
    await addInvocation(60 * ONE_DAY_MS);
    await addInvocation(90 * ONE_DAY_MS);
    await addInvocation(120 * ONE_DAY_MS);

    const deleted = await rotateToolInvocations(30);
    expect(deleted).toBe(3);
    expect((await getRecentInvocations(100)).length).toBe(0);
  });

  test("returns 0 when table is empty", async () => {
    const deleted = await rotateToolInvocations(7);
    expect(deleted).toBe(0);
  });

  test("handles 1-day retention (deletes everything older than 24h)", async () => {
    await addInvocation(2 * ONE_DAY_MS); // 2 days old, delete
    await addInvocation(12 * 60 * 60 * 1000); // 12 hours old, keep

    const deleted = await rotateToolInvocations(1);
    expect(deleted).toBe(1);
    expect((await getRecentInvocations(100)).length).toBe(1);
  });

  test("works with recordToolInvocation (via ORM)", async () => {
    await addInvocation(0); // just-created record

    // This record was just created, so it should not be rotated
    const deleted = await rotateToolInvocations(1);
    expect(deleted).toBe(0);
    expect((await getRecentInvocations(100)).length).toBe(1);
  });

  test("yields to the event loop while the purge is in flight (anti-block)", async () => {
    // Seed a few thousand rows so the DELETE has measurable work behind it.
    const ROW_COUNT = 2000;
    const past = 100 * ONE_DAY_MS;
    const db = requireMainDb();
    const now = Date.now();
    const rows = Array.from({ length: ROW_COUNT }, () => ({
      id: randomBytes(8).toString("hex"),
      conversationId: "conv-1",
      toolName: "bash",
      input: '{"command":"echo hi"}',
      result: "hi",
      decision: "allow",
      riskLevel: "Low",
      durationMs: 100,
      createdAt: now - past,
    }));
    await db.orm.insert(db.schema.toolInvocations).values(rows);

    // Race the purge against a `setImmediate` ping. The ping resolves on the
    // very next event-loop iteration after it is scheduled.
    //
    // If the purge is async, `rotateToolInvocations` returns a pending Promise
    // immediately; the ping wins the race while the statement is still running.
    //
    // If the purge is ever regressed back to a synchronous DELETE,
    // `rotateToolInvocations` blocks the main thread for the full DELETE
    // duration. `setImmediate` cannot fire until the main thread releases, so
    // the purge's already-resolved Promise beats the ping through the
    // microtask queue and "purge" wins.
    const ping = new Promise<"ping">((resolve) =>
      setImmediate(() => resolve("ping")),
    );
    const purgePromise = rotateToolInvocations(7);
    const winner = await Promise.race([
      ping,
      purgePromise.then(() => "purge" as const),
    ]);

    expect(winner).toBe("ping");

    // Drain the purge so the log and connection cleanup complete before the
    // test exits.
    const deleted = await purgePromise;
    expect(deleted).toBe(ROW_COUNT);
  }, 60_000);
});
