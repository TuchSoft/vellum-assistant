import { beforeAll, expect, test } from "bun:test";

import { describePg } from "./__tests__/pg-test-db.js";
import { ensureGroupMigrationAsync } from "./conversation-group-migration.js";
import { requireMainDb } from "./db-facade.js";

// Simulate a legacy install that has the `system:reflections` system group
// plus a conversation pointing at it. The migration must:
//   1. Seed the current system groups (without `system:reflections`).
//   2. Move the legacy conversation to `system:background` (step 6).
//   3. Delete the orphaned `system:reflections` row (step 7).
//
// The baseline already carries `conversation_groups` and the `group_id`
// column, so the legacy rows can be seeded directly before the migration runs.
describePg("ensureGroupMigration — reflections cleanup", () => {
  beforeAll(async () => {
    const db = requireMainDb();
    await db.run("DELETE FROM conversations");
    await db.run("DELETE FROM conversation_groups");
    await db.run(
      "INSERT INTO conversation_groups (id, name, sort_position, is_system_group) VALUES (?, ?, ?, ?)",
      ["system:reflections", "Reflections", 100, true],
    );
    const now = Date.now();
    await db.run(
      "INSERT INTO conversations (id, created_at, updated_at, group_id) VALUES (?, ?, ?, ?)",
      ["legacy-refl-1", now, now, "system:reflections"],
    );

    await ensureGroupMigrationAsync();
  });

  test("moves legacy system:reflections conversations to system:background", async () => {
    const legacy = await requireMainDb().get<{ group_id: string | null }>(
      "SELECT group_id FROM conversations WHERE id = 'legacy-refl-1'",
    );
    expect(legacy?.group_id).toBe("system:background");
  });

  test("deletes the orphaned system:reflections group row", async () => {
    const refl = await requireMainDb().get<{ id: string }>(
      "SELECT id FROM conversation_groups WHERE id = 'system:reflections'",
    );
    expect(refl).toBeNull();
  });

  test("seeds the current system groups without system:reflections", async () => {
    const systemIds = (
      await requireMainDb().all<{ id: string }>(
        "SELECT id FROM conversation_groups WHERE id LIKE 'system:%' ORDER BY id",
      )
    ).map((r) => r.id);
    expect(systemIds).toEqual([
      "system:all",
      "system:background",
      "system:pinned",
      "system:scheduled",
    ]);
  });

  test("records the cleanup sentinel so the step is idempotent", async () => {
    const sentinel = await requireMainDb().get<{ id: string }>(
      "SELECT id FROM conversation_groups WHERE id = '_reflections_group_deleted_complete'",
    );
    expect(sentinel?.id).toBe("_reflections_group_deleted_complete");
  });

  test("re-running ensureGroupMigration does not recreate the stale group", async () => {
    await expect(ensureGroupMigrationAsync()).resolves.toBeUndefined();
    const refl = await requireMainDb().get<{ id: string }>(
      "SELECT id FROM conversation_groups WHERE id = 'system:reflections'",
    );
    expect(refl).toBeNull();
  });
});
