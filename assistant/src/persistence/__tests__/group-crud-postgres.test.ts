/**
 * The `group-crud` slice on Postgres.
 *
 * `group-crud.ts` and its lazy schema migration now go through the async
 * `AsyncDb` facade, so the same code runs on SQLite and Postgres. This suite
 * runs one scenario body against both backends, including the dialect
 * translations (`substr(...)` instead of `GLOB`, boolean `is_system_group`) and
 * the runtime columns the generated baseline does not carry.
 *
 * The Postgres leg is gated on `VELLUM_PG_TEST_URL` (throwaway instance); with
 * it unset only the SQLite leg runs.
 */

import {
  afterAll,
  beforeAll,
  beforeEach,
  describe,
  expect,
  test,
} from "bun:test";

import { ensureGroupMigrationAsync } from "../conversation-group-migration.js";
import { requireMainDb } from "../db-facade.js";
import { initializeDb } from "../db-init.js";
import { getPostgresAsyncDb } from "../db-postgres-facade.js";
import {
  createGroup,
  deleteGroup,
  getGroup,
  listGroups,
  reorderGroups,
  updateGroup,
} from "../group-crud.js";
import { PG_STEPS } from "../pg-migrations/pg-steps.js";
import { runPgMigrations } from "../pg-migrations/run-pg-migrations.js";

await initializeDb();

const PG_URL = process.env.VELLUM_PG_TEST_URL;

/** Remove custom groups; system groups and migration markers stay. */
async function clearCustomGroups(): Promise<void> {
  await ensureGroupMigrationAsync();
  await requireMainDb().run(
    "DELETE FROM conversation_groups WHERE substr(id, 1, 1) <> '_' AND is_system_group = FALSE",
  );
}

/** One scenario body, run verbatim against each backend. */
function defineStoreScenarios(): void {
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
}

describe("group-crud (sqlite)", () => {
  beforeAll(() => {
    delete process.env.VELLUM_MAIN_DB_BACKEND;
    delete process.env.VELLUM_MAIN_DATABASE_URL;
  });

  defineStoreScenarios();
});

const pgDescribe = PG_URL ? describe : describe.skip;

pgDescribe("group-crud (postgres)", () => {
  let savedBackend: string | undefined;
  let savedUrl: string | undefined;

  beforeAll(async () => {
    savedBackend = process.env.VELLUM_MAIN_DB_BACKEND;
    savedUrl = process.env.VELLUM_MAIN_DATABASE_URL;
    process.env.VELLUM_MAIN_DB_BACKEND = "postgres";
    process.env.VELLUM_MAIN_DATABASE_URL = PG_URL!;

    const pg = getPostgresAsyncDb("main", PG_URL!);
    await pg.exec("DROP SCHEMA IF EXISTS public CASCADE");
    await pg.exec("CREATE SCHEMA public");
    await runPgMigrations(pg, PG_STEPS);
  });

  afterAll(async () => {
    if (savedBackend === undefined) {
      delete process.env.VELLUM_MAIN_DB_BACKEND;
    } else {
      process.env.VELLUM_MAIN_DB_BACKEND = savedBackend;
    }
    if (savedUrl === undefined) {
      delete process.env.VELLUM_MAIN_DATABASE_URL;
    } else {
      process.env.VELLUM_MAIN_DATABASE_URL = savedUrl;
    }
    if (PG_URL) {
      await getPostgresAsyncDb("main", PG_URL)
        .exec("DROP SCHEMA IF EXISTS public CASCADE")
        .catch(() => {
          /* best-effort */
        });
    }
  });

  defineStoreScenarios();
});
