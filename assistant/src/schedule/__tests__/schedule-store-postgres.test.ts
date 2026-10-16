/**
 * The `schedule` slice on Postgres.
 *
 * `schedule-store.ts` reads and writes only `cron_jobs` / `cron_runs`, which
 * live on the `main` slot, so wrapping it in the async `AsyncDb` facade is what
 * lets the same store code run on SQLite and Postgres. This suite runs one
 * scenario body against both backends and asserts identical behavior, mirroring
 * `pg-integration.test.ts` for the store's own data boundary.
 *
 * The Postgres leg is gated on `VELLUM_PG_TEST_URL` (throwaway instance); with
 * it unset only the SQLite leg runs. Cross-slice reads the store makes (e.g.
 * `getConversation` for wake rows) stay on SQLite: the main slot is flipped
 * whole for this test, but those other slices are not ported yet.
 *
 *   docker run -d --rm --name vellum-pg-test -e POSTGRES_PASSWORD=pw \
 *     -e POSTGRES_DB=vellum -p 127.0.0.1:55432:5432 pgvector/pgvector:pg17
 *   VELLUM_PG_TEST_URL="postgresql://postgres@127.0.0.1:55432/vellum" \
 *     bun test src/schedule/__tests__/schedule-store-postgres.test.ts
 */

import {
  afterAll,
  beforeAll,
  beforeEach,
  describe,
  expect,
  mock,
  test,
} from "bun:test";

// Keep the suite hermetic: `notifySchedulesChanged()` fires a debounced
// background-wake refresh on every mutation. Mocking it here is what
// `schedule-store.test.ts` does for the same reason.
mock.module("../../background-wake/publisher.js", () => ({
  refreshBackgroundWakeIntent: () => {},
}));

import type { AsyncDb } from "../../persistence/db-facade.js";
import { getAsyncDb } from "../../persistence/db-facade.js";
import { initializeDb } from "../../persistence/db-init.js";
import { getPostgresAsyncDb } from "../../persistence/db-postgres-facade.js";
import { PG_STEPS } from "../../persistence/pg-migrations/pg-steps.js";
import { runPgMigrations } from "../../persistence/pg-migrations/run-pg-migrations.js";
import {
  claimDueSchedules,
  completeScheduleRun,
  countSchedules,
  createSchedule,
  createScheduleRun,
  deleteSchedule,
  disarmDeclaredSchedule,
  findStaleInFlightJobs,
  getSchedule,
  getScheduleRuns,
  listDeclaredSchedules,
  listSchedules,
  updateSchedule,
  upsertDeclaredSchedule,
} from "../schedule-store.js";

await initializeDb();

const PG_URL = process.env.VELLUM_PG_TEST_URL;

/** Delete the slice's rows through the active backend's facade. */
async function clearCronTables(): Promise<void> {
  const db = getAsyncDb();
  if (!db) {
    throw new Error("main DB unavailable in test");
  }
  await db.run("DELETE FROM cron_runs");
  await db.run("DELETE FROM cron_jobs");
}

/**
 * One scenario body, run verbatim against each backend. The store resolves its
 * connection from env, so the same calls exercise SQLite in the first describe
 * and Postgres in the second.
 */
function defineStoreScenarios(): void {
  beforeEach(async () => {
    await clearCronTables();
  });

  test("creates a schedule and reads it back with portable types", async () => {
    const created = await createSchedule({
      name: "portable types",
      cronExpression: "0 9 * * *",
      message: "hello",
      syntax: "cron",
    });
    expect(created.enabled).toBe(true);
    expect(typeof created.nextRunAt).toBe("number");
    expect(created.nextRunAt).toBeGreaterThan(0);

    const read = await getSchedule(created.id);
    expect(read?.name).toBe("portable types");
    expect(read?.enabled).toBe(true);
    // epoch-ms round-trips as a JS number (the int8 parser on Postgres).
    expect(typeof read?.nextRunAt).toBe("number");
  });

  test("lists and counts schedules", async () => {
    await createSchedule({
      name: "a",
      cronExpression: "0 9 * * *",
      message: "a",
      syntax: "cron",
    });
    await createSchedule({
      name: "b",
      cronExpression: "0 10 * * *",
      message: "b",
      syntax: "cron",
    });

    const all = await listSchedules();
    expect(all).toHaveLength(2);
    const counts = await countSchedules();
    expect(counts).toEqual({ total: 2, enabled: 2 });
  });

  test("updates a schedule", async () => {
    const created = await createSchedule({
      name: "before",
      cronExpression: "0 9 * * *",
      message: "x",
      syntax: "cron",
    });

    const updated = await updateSchedule(created.id, {
      name: "after",
      enabled: false,
    });
    expect(updated?.name).toBe("after");
    expect((await getSchedule(created.id))?.enabled).toBe(false);
  });

  test("claims a due one-shot, records its run, and completes it", async () => {
    const created = await createSchedule({
      name: "one-shot",
      expression: null,
      nextRunAt: Date.now() - 1_000,
      message: "run me",
      syntax: "cron",
    });

    const claimed = await claimDueSchedules(Date.now());
    expect(claimed.map((job) => job.id)).toContain(created.id);
    expect((await getSchedule(created.id))?.status).toBe("firing");

    const runId = await createScheduleRun(created.id, "conv-run");
    await completeScheduleRun(runId, { status: "ok", output: "done" });

    const runs = await getScheduleRuns(created.id);
    expect(runs).toHaveLength(1);
    expect(runs[0]?.status).toBe("ok");
    expect(runs[0]?.conversationId).toBe("conv-run");
    expect((await getSchedule(created.id))?.lastStatus).toBe("ok");
  });

  test("reports stale in-flight one-shots", async () => {
    const created = await createSchedule({
      name: "stale",
      expression: null,
      nextRunAt: Date.now() - 1_000,
      message: "stuck",
      syntax: "cron",
    });
    await claimDueSchedules(Date.now());

    const stale = await findStaleInFlightJobs(0);
    expect(stale.some((row) => row.jobId === created.id)).toBe(true);
  });

  test("deletes a schedule", async () => {
    const created = await createSchedule({
      name: "doomed",
      cronExpression: "0 9 * * *",
      message: "x",
      syntax: "cron",
    });

    expect(await deleteSchedule(created.id)).toBe(true);
    expect(await getSchedule(created.id)).toBeNull();
  });

  test("upserts, lists, and disarms a plugin-declared schedule", async () => {
    const created = await upsertDeclaredSchedule("plugin:demo/morning", {
      name: "Morning",
      syntax: "cron",
      expression: "0 9 * * *",
      message: "summary",
      mode: "execute",
      enabled: true,
      definitionHash: "h1",
    });
    expect(created.sourceKey).toBe("plugin:demo/morning");

    const declared = await listDeclaredSchedules();
    expect(declared.map((row) => row.id)).toContain(created.id);

    expect(await disarmDeclaredSchedule(created.id)).toBe(true);
    expect((await getSchedule(created.id))?.enabled).toBe(false);
  });
}

describe("schedule store (sqlite)", () => {
  beforeAll(() => {
    delete process.env.VELLUM_MAIN_DB_BACKEND;
    delete process.env.VELLUM_MAIN_DATABASE_URL;
  });

  defineStoreScenarios();
});

const pgDescribe = PG_URL ? describe : describe.skip;

pgDescribe("schedule store (postgres)", () => {
  let savedBackend: string | undefined;
  let savedUrl: string | undefined;

  beforeAll(async () => {
    savedBackend = process.env.VELLUM_MAIN_DB_BACKEND;
    savedUrl = process.env.VELLUM_MAIN_DATABASE_URL;
    // Flip the main slot to Postgres for this suite. The store resolves its
    // backend from env on every call, so the scenario bodies now run on PG.
    process.env.VELLUM_MAIN_DB_BACKEND = "postgres";
    process.env.VELLUM_MAIN_DATABASE_URL = PG_URL!;

    const pg: AsyncDb = getPostgresAsyncDb("main", PG_URL!);
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
