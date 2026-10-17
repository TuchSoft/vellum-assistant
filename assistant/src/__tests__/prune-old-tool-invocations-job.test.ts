import { beforeEach, expect, test } from "bun:test";

import type { AssistantConfig } from "../config/schema.js";
import { requireMainDb } from "../persistence/db-facade.js";
import { pruneOldToolInvocationsJob } from "../persistence/job-handlers/cleanup.js";
import type { MemoryJob } from "../persistence/jobs-store.js";
import { describePg } from "./pg-test-db.js";

const DAY_MS = 86_400_000;

async function seedInvocation(id: string, createdAt: number): Promise<void> {
  await requireMainDb().run(
    `INSERT INTO tool_invocations (
       id, conversation_id, tool_name, input, result, decision,
       risk_level, duration_ms, created_at
     ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [id, "conv-1", "bash", "{}", "{}", "allow", "low", 5, createdAt],
  );
}

async function remainingIds(): Promise<string[]> {
  const rows = await requireMainDb().all<{ id: string }>(
    "SELECT id FROM tool_invocations",
  );
  return rows.map((row) => row.id).sort();
}

function job(payload: Record<string, unknown> = {}): MemoryJob {
  return { payload } as unknown as MemoryJob;
}

function config(retentionDays: number): AssistantConfig {
  return { auditLog: { retentionDays } } as unknown as AssistantConfig;
}

describePg("pruneOldToolInvocationsJob", () => {
  beforeEach(async () => {
    const db = requireMainDb();
    await db.run("DELETE FROM tool_invocations");
    await db.run("DELETE FROM conversations");
    // tool_invocations.conversation_id is an FK into conversations.
    await db.run(
      `INSERT INTO conversations (id, title, created_at, updated_at)
       VALUES (?, ?, ?, ?)`,
      ["conv-1", "test", Date.now(), Date.now()],
    );
  });

  test("deletes audit rows older than auditLog.retentionDays, keeps recent ones", async () => {
    await seedInvocation("old", Date.now() - 60 * DAY_MS);
    await seedInvocation("fresh", Date.now());

    await pruneOldToolInvocationsJob(job(), config(30));

    expect(await remainingIds()).toEqual(["fresh"]);
  });

  test("payload retentionDays overrides the config window", async () => {
    await seedInvocation("ten-days", Date.now() - 10 * DAY_MS);

    // Config would keep it (30d), but the payload tightens to 7d.
    await pruneOldToolInvocationsJob(job({ retentionDays: 7 }), config(30));

    expect(await remainingIds()).toEqual([]);
  });

  test("retentionDays of 0 is a no-op (keep forever)", async () => {
    await seedInvocation("ancient", Date.now() - 999 * DAY_MS);

    await pruneOldToolInvocationsJob(job(), config(0));

    expect(await remainingIds()).toEqual(["ancient"]);
  });
});
