/**
 * The `AsyncDb.orm` binding on both backends.
 *
 * `orm` + `schema` are the dialect-agnostic pair: the same Drizzle query code
 * runs on SQLite (`schema/`) and Postgres (`pg-schema/`). These tests exercise a
 * real `schedule` table (`cron_jobs`) end-to-end through the ORM on both.
 *
 * The Postgres leg is gated on `VELLUM_PG_TEST_URL` (throwaway instance); with it
 * unset those cases skip.
 */

import { afterAll, beforeAll, describe, expect, test } from "bun:test";

import { eq } from "drizzle-orm";

import { type AsyncDb, getAsyncDb } from "../db-facade.js";
import { initializeDb } from "../db-init.js";
import { getPostgresAsyncDb } from "../db-postgres-facade.js";
import { PG_STEPS } from "../pg-migrations/pg-steps.js";
import { runPgMigrations } from "../pg-migrations/run-pg-migrations.js";

await initializeDb();

const PG_URL = process.env.VELLUM_PG_TEST_URL;

const PROBE_ID = "orm-probe";

/**
 * The dialect-agnostic query path: identical code on both backends, using
 * `db.orm` (the backend's Drizzle instance) and `db.schema` (its table barrel).
 */
async function scheduleRoundTrip(
  db: AsyncDb,
): Promise<Record<string, unknown>> {
  const jobs = db.schema.scheduleJobs;
  await db.orm.delete(jobs).where(eq(jobs.id, PROBE_ID));
  await db.orm.insert(jobs).values({
    id: PROBE_ID,
    name: "probe",
    message: "hello",
    nextRunAt: 1_700_000_000_000,
    createdBy: "user",
    createdAt: 1_700_000_000_000,
    updatedAt: 1_700_000_000_000,
  });
  const rows = await db.orm.select().from(jobs).where(eq(jobs.id, PROBE_ID));
  await db.orm.delete(jobs).where(eq(jobs.id, PROBE_ID));
  return rows[0] as Record<string, unknown>;
}

describe("AsyncDb.orm (sqlite)", () => {
  test("exposes an orm and a matching schema barrel", async () => {
    const db = getAsyncDb()!;
    expect(db.orm).toBeDefined();
    expect(db.schema.scheduleJobs).toBeDefined();
  });

  test("a drizzle query runs against a schedule table", async () => {
    const row = await scheduleRoundTrip(getAsyncDb()!);
    expect(row).toMatchObject({ id: PROBE_ID, name: "probe" });
    expect(row.nextRunAt).toBe(1_700_000_000_000);
    expect(row.enabled).toBe(true);
  });
});

const pgDescribe = PG_URL ? describe : describe.skip;

pgDescribe("AsyncDb.orm (postgres)", () => {
  beforeAll(async () => {
    const db = getPostgresAsyncDb("main", PG_URL!);
    await db.exec("DROP SCHEMA IF EXISTS public CASCADE");
    await db.exec("CREATE SCHEMA public");
    await runPgMigrations(db, PG_STEPS);
  });

  afterAll(async () => {
    if (PG_URL) {
      await getPostgresAsyncDb("main", PG_URL)
        .exec("DROP SCHEMA IF EXISTS public CASCADE")
        .catch(() => {
          /* best-effort */
        });
    }
  });

  test("orm + schema are the Postgres pair", () => {
    const db = getPostgresAsyncDb("main", PG_URL!);
    expect(db.orm).toBeDefined();
    expect(db.schema.scheduleJobs).toBeDefined();
  });

  test("the SAME drizzle query path runs against a schedule table on Postgres", async () => {
    const row = await scheduleRoundTrip(getPostgresAsyncDb("main", PG_URL!));
    expect(row).toMatchObject({ id: PROBE_ID, name: "probe" });
    // bigint epoch-ms round-trips as a JS number (int8 parser).
    expect(row.nextRunAt).toBe(1_700_000_000_000);
    // boolean column round-trips as a JS boolean.
    expect(row.enabled).toBe(true);
  });
});
