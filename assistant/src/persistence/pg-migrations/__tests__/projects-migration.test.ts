/**
 * Integration test for the `0003_projects` migration step.
 *
 * Seeds a database that looks like an install with the four group shapes the
 * migration has to route: a user group, the two system buckets, and
 * conversations that are pinned, in `system:all`, or ungrouped. Then it runs
 * the ordered Postgres steps and asserts the resulting projects and membership.
 *
 * Gated on `VELLUM_PG_TEST_URL` (throwaway instance); with it unset the suite
 * skips.
 */

import { beforeAll, expect, test } from "bun:test";

import { describePg } from "../../../__tests__/pg-test-db.js";
import { ensureGroupMigrationAsync } from "../../conversation-group-migration.js";
import { requireMainDb } from "../../db-facade.js";
import { PG_STEPS } from "../pg-steps.js";
import { runPgMigrations } from "../run-pg-migrations.js";

const PROJECT_STEP = PG_STEPS.find((step) => step.name === "0003_projects");
const CRON_PROJECTS_STEP = PG_STEPS.find(
  (step) => step.name === "0004_cron_job_projects",
);

const USER_GROUP_ID = "9f6b1c4e-1f0e-4a5f-9d21-2b7f0e3a6c11";
const NOW = 1_760_000_000_000;

async function seedGroupsAndConversations(): Promise<void> {
  const db = requireMainDb();
  await db.exec("DROP TABLE IF EXISTS cron_job_projects");
  await db.exec("DROP TABLE IF EXISTS conversation_projects");
  await db.exec("DROP TABLE IF EXISTS projects");
  await db.exec("DROP TABLE IF EXISTS pg_schema_migrations");

  // The runtime group migration creates `conversation_groups` (it is not in
  // the generated baseline), adds `group_id` and `is_pinned`, and seeds the
  // four system groups plus its markers.
  await ensureGroupMigrationAsync();
  await db.exec("DELETE FROM conversations");
  await db.exec(
    "DELETE FROM conversation_groups WHERE substr(id, 1, 1) <> '_' AND is_system_group = FALSE",
  );

  await db.run(
    `INSERT INTO conversation_groups (id, name, sort_position, is_system_group, created_at, updated_at)
     VALUES (?, ?, ?, FALSE, ?, ?)`,
    [USER_GROUP_ID, "Cliente X", 4, NOW, NOW],
  );

  const conversations: Array<{
    id: string;
    groupId: string | null;
    isPinned: number;
  }> = [
    { id: "conv-user", groupId: USER_GROUP_ID, isPinned: 0 },
    { id: "conv-background", groupId: "system:background", isPinned: 0 },
    { id: "conv-scheduled", groupId: "system:scheduled", isPinned: 0 },
    { id: "conv-pinned", groupId: "system:pinned", isPinned: 1 },
    { id: "conv-all", groupId: "system:all", isPinned: 0 },
    { id: "conv-ungrouped", groupId: null, isPinned: 0 },
  ];
  for (const conversation of conversations) {
    await db.run(
      `INSERT INTO conversations (id, created_at, updated_at, group_id, is_pinned)
       VALUES (?, ?, ?, ?, ?)`,
      [conversation.id, NOW, NOW, conversation.groupId, conversation.isPinned],
    );
  }
}

describePg("0003_projects migration", () => {
  beforeAll(async () => {
    if (!PROJECT_STEP) {
      throw new Error("0003_projects step not found");
    }
    await seedGroupsAndConversations();
    await runPgMigrations(requireMainDb(), PG_STEPS);
  });

  test("creates the projects and conversation_projects tables", async () => {
    const rows = await requireMainDb().all<{ table_name: string }>(
      `SELECT table_name FROM information_schema.tables
       WHERE table_schema = current_schema()
         AND table_name IN ('projects', 'conversation_projects')
       ORDER BY table_name`,
    );
    expect(rows.map((row) => row.table_name)).toEqual([
      "conversation_projects",
      "projects",
    ]);
  });

  test("seeds exactly one Inbox", async () => {
    const rows = await requireMainDb().all<{ id: string; kind: string }>(
      "SELECT id, kind FROM projects WHERE kind = 'inbox'",
    );
    expect(rows).toEqual([{ id: "inbox", kind: "inbox" }]);
  });

  test("maps user groups and the two system buckets to projects", async () => {
    const rows = await requireMainDb().all<{ id: string; kind: string }>(
      "SELECT id, kind FROM projects WHERE id <> 'inbox' ORDER BY id",
    );
    expect(rows).toEqual([
      { id: USER_GROUP_ID, kind: "user" },
      { id: "system:background", kind: "system" },
      { id: "system:scheduled", kind: "system" },
    ]);
  });

  test("does not turn system:all or system:pinned into projects", async () => {
    const rows = await requireMainDb().all<{ id: string }>(
      "SELECT id FROM projects WHERE id IN ('system:all', 'system:pinned')",
    );
    expect(rows).toEqual([]);
  });

  test("routes membership by group, with the Inbox as the catch-all", async () => {
    const rows = await requireMainDb().all<{
      conversation_id: string;
      project_id: string;
    }>(
      "SELECT conversation_id, project_id FROM conversation_projects ORDER BY conversation_id",
    );
    expect(rows).toEqual([
      { conversation_id: "conv-all", project_id: "inbox" },
      { conversation_id: "conv-background", project_id: "system:background" },
      { conversation_id: "conv-pinned", project_id: "inbox" },
      { conversation_id: "conv-scheduled", project_id: "system:scheduled" },
      { conversation_id: "conv-ungrouped", project_id: "inbox" },
      { conversation_id: "conv-user", project_id: USER_GROUP_ID },
    ]);
  });

  test("keeps the pin flag on a pinned conversation", async () => {
    const row = await requireMainDb().get<{ is_pinned: number }>(
      "SELECT is_pinned FROM conversations WHERE id = 'conv-pinned'",
    );
    expect(Number(row?.is_pinned)).toBe(1);
  });

  test("is idempotent: a second apply leaves the counts unchanged", async () => {
    const db = requireMainDb();
    const before = await db.get<{ projects: number; memberships: number }>(
      `SELECT
         (SELECT count(*)::int FROM projects) AS projects,
         (SELECT count(*)::int FROM conversation_projects) AS memberships`,
    );
    await PROJECT_STEP!.up(db);
    const after = await db.get<{ projects: number; memberships: number }>(
      `SELECT
         (SELECT count(*)::int FROM projects) AS projects,
         (SELECT count(*)::int FROM conversation_projects) AS memberships`,
    );
    expect(after).toEqual(before);
  });

  test("down drops both tables", async () => {
    const db = requireMainDb();
    // Steps roll back newest first: `0004` holds the foreign key to `projects`.
    await CRON_PROJECTS_STEP!.down?.(db);
    await PROJECT_STEP!.down?.(db);
    const rows = await db.all<{ table_name: string }>(
      `SELECT table_name FROM information_schema.tables
       WHERE table_schema = current_schema()
         AND table_name IN ('projects', 'conversation_projects')`,
    );
    expect(rows).toEqual([]);
  });
});

describePg("0004_cron_job_projects migration", () => {
  beforeAll(async () => {
    // The `0003` block ends with both tables dropped, so this block rebuilds the
    // schema it depends on instead of relying on the other block's order.
    const db = requireMainDb();
    await PROJECT_STEP!.up(db);
    await CRON_PROJECTS_STEP!.up(db);
  });

  test("creates the cron_job_projects table with its index", async () => {
    expect(CRON_PROJECTS_STEP).toBeDefined();
    const table = await requireMainDb().get<{ table_name: string }>(
      `SELECT table_name FROM information_schema.tables
       WHERE table_schema = current_schema()
         AND table_name = 'cron_job_projects'`,
    );
    expect(table?.table_name).toBe("cron_job_projects");

    const index = await requireMainDb().get<{ indexname: string }>(
      "SELECT indexname FROM pg_indexes WHERE schemaname = current_schema() AND indexname = 'idx_cron_job_projects_project'",
    );
    expect(index?.indexname).toBe("idx_cron_job_projects_project");
  });

  test("cascades membership when the schedule is deleted", async () => {
    const db = requireMainDb();
    const now = Date.now();
    await db.run(
      `INSERT INTO cron_jobs (id, name, message, next_run_at, created_by, created_at, updated_at)
       VALUES ('sched-1', 'S', 'm', ?, 'user', ?, ?)
       ON CONFLICT (id) DO NOTHING`,
      [now, now, now],
    );
    await db.run(
      `INSERT INTO cron_job_projects (cron_job_id, project_id)
       VALUES ('sched-1', 'inbox')
       ON CONFLICT DO NOTHING`,
    );
    expect(
      await db.all(
        "SELECT * FROM cron_job_projects WHERE cron_job_id = 'sched-1'",
      ),
    ).toHaveLength(1);

    await db.run("DELETE FROM cron_jobs WHERE id = 'sched-1'");
    expect(
      await db.all(
        "SELECT * FROM cron_job_projects WHERE cron_job_id = 'sched-1'",
      ),
    ).toEqual([]);
  });

  test("is idempotent: a second apply leaves the table in place", async () => {
    const db = requireMainDb();
    await CRON_PROJECTS_STEP!.up(db);
    const table = await db.get<{ table_name: string }>(
      `SELECT table_name FROM information_schema.tables
       WHERE table_schema = current_schema()
         AND table_name = 'cron_job_projects'`,
    );
    expect(table?.table_name).toBe("cron_job_projects");
  });

  test("down drops the table", async () => {
    const db = requireMainDb();
    await CRON_PROJECTS_STEP!.down?.(db);
    const rows = await db.all<{ table_name: string }>(
      `SELECT table_name FROM information_schema.tables
       WHERE table_schema = current_schema()
         AND table_name = 'cron_job_projects'`,
    );
    expect(rows).toEqual([]);
  });
});
