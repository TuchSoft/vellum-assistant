/**
 * The `AsyncDb.orm` binding on Postgres.
 *
 * `orm` + `schema` are the pair the ported slices query through: the same
 * Drizzle code runs against `pg-schema`. This suite exercises a real `schedule`
 * table (`cron_jobs`) end-to-end through the ORM, against the process's
 * Postgres test schema bootstrapped by `src/__tests__/pg-test-db.ts`.
 *
 * Gated on `VELLUM_PG_TEST_URL` (throwaway instance); with it unset the suite
 * skips.
 */

import { expect, test } from "bun:test";

import { eq } from "drizzle-orm";

import { describePg } from "../../__tests__/pg-test-db.js";
import { type AsyncDb, requireMainDb } from "../db-facade.js";
import { initializeDb } from "../db-init.js";

await initializeDb();

const PROBE_ID = "orm-probe";

/**
 * The query path the ported slices use: `db.orm` (the Drizzle instance) and
 * `db.schema` (its table barrel).
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

describePg("AsyncDb.orm (postgres)", () => {
  test("exposes an orm and a matching schema barrel", () => {
    const db = requireMainDb();
    expect(db.orm).toBeDefined();
    expect(db.schema.scheduleJobs).toBeDefined();
  });

  test("a drizzle query runs against a schedule table", async () => {
    const row = await scheduleRoundTrip(requireMainDb());
    expect(row).toMatchObject({ id: PROBE_ID, name: "probe" });
    // bigint epoch-ms round-trips as a JS number (int8 parser).
    expect(row.nextRunAt).toBe(1_700_000_000_000);
    // boolean column round-trips as a JS boolean.
    expect(row.enabled).toBe(true);
  });
});
