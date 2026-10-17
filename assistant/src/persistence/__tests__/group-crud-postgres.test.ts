/**
 * Conformance suite for the `group-crud` slice on Postgres.
 *
 * `group-crud.ts` and its lazy schema migration go through the async `AsyncDb`
 * facade. The suite covers the dialect translations the port required
 * (`substr(...)` instead of `GLOB`, boolean `is_system_group`) and the runtime
 * columns the generated baseline does not carry. It runs against the process's
 * Postgres test schema, bootstrapped by `src/__tests__/pg-test-db.ts`.
 *
 * Gated on `VELLUM_PG_TEST_URL` (throwaway instance); with it unset the suite
 * skips.
 */

import { beforeEach, expect, test } from "bun:test";

import { describePg } from "../../__tests__/pg-test-db.js";
import { ensureGroupMigrationAsync } from "../conversation-group-migration.js";
import { requireMainDb } from "../db-facade.js";
import { initializeDb } from "../db-init.js";
import {
  createGroup,
  deleteGroup,
  getGroup,
  listGroups,
  reorderGroups,
  updateGroup,
} from "../group-crud.js";

await initializeDb();

/** Remove custom groups; system groups and migration markers stay. */
async function clearCustomGroups(): Promise<void> {
  await ensureGroupMigrationAsync();
  await requireMainDb().run(
    "DELETE FROM conversation_groups WHERE substr(id, 1, 1) <> '_' AND is_system_group = FALSE",
  );
}

describePg("group-crud (postgres)", () => {
  beforeEach(async () => {
    await clearCustomGroups();
  });

  test("seeds the system groups and hides migration markers", async () => {
    const groups = await listGroups();
    const ids = groups.map((group) => group.id);
    expect(ids).toContain("system:pinned");
    expect(ids).toContain("system:scheduled");
    expect(ids).toContain("system:background");
    expect(ids).toContain("system:all");
    expect(groups.every((group) => group.isSystemGroup)).toBe(true);
    expect(ids.some((id) => id.startsWith("_"))).toBe(false);
  });

  test("creates, reads, updates, and deletes a custom group", async () => {
    const created = await createGroup("Briefs", "rocket");
    expect(created.isSystemGroup).toBe(false);
    expect(created.sortPosition).toBe(4);

    const read = await getGroup(created.id);
    expect(read?.name).toBe("Briefs");
    expect(read?.icon).toBe("rocket");
    expect(read?.isSystemGroup).toBe(false);

    const updated = await updateGroup(created.id, {
      name: "Renamed",
      icon: null,
    });
    expect(updated?.name).toBe("Renamed");
    expect(updated?.icon).toBeNull();

    expect(await deleteGroup(created.id)).toBe(true);
    expect(await getGroup(created.id)).toBeNull();
  });

  test("reorders custom groups and rejects positions below 4", async () => {
    const group = await createGroup("Movable");

    await reorderGroups([{ groupId: group.id, sortPosition: 10 }]);
    expect((await getGroup(group.id))?.sortPosition).toBe(10);

    await expect(
      reorderGroups([{ groupId: group.id, sortPosition: 2 }]),
    ).rejects.toThrow("must be >= 4");
    // The failed batch rolled back: the position is unchanged.
    expect((await getGroup(group.id))?.sortPosition).toBe(10);
  });
});
