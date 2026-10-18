/**
 * Postgres integration tests for the baseline and the migration runner.
 *
 * Gated on `VELLUM_PG_TEST_URL`: with it unset these skip, so the rest of the
 * suite is unaffected. Point it at a throwaway Postgres, e.g.:
 *
 *   docker run -d --rm --name vellum-pg-test -e POSTGRES_PASSWORD=pw \
 *     -e POSTGRES_DB=vellum -p 127.0.0.1:55432:5432 pgvector/pgvector:pg17
 *   VELLUM_PG_TEST_URL="postgresql://postgres:pw@127.0.0.1:55432/vellum" \
 *     bun test src/persistence/pg-migrations/__tests__/pg-integration.test.ts
 *
 * Each test starts from an empty `public` schema, so runs are order-independent
 * and repeatable against a persistent database.
 */

import { Database } from "bun:sqlite";
import { afterAll, beforeEach, describe, expect, test } from "bun:test";

import { getPostgresAsyncDb } from "../../db-postgres-facade.js";
import { BASELINE_STATEMENTS, BASELINE_TABLES } from "../baseline.generated.js";
import { buildBaselineStatements } from "../baseline.js";
import { PG_STEPS } from "../pg-steps.js";
import {
  appliedPgSteps,
  PG_MIGRATION_LEDGER,
  rollbackPgMigrations,
  runPgMigrations,
} from "../run-pg-migrations.js";
import { introspectSqlite } from "../sqlite-model.js";

const PG_URL = process.env.VELLUM_PG_TEST_URL;
const pgDescribe = PG_URL ? describe : describe.skip;

function db() {
  if (!PG_URL) {
    throw new Error("VELLUM_PG_TEST_URL not set");
  }
  return getPostgresAsyncDb("telemetry", PG_URL);
}

async function resetPublicSchema(): Promise<void> {
  const handle = db();
  await handle.exec("DROP SCHEMA IF EXISTS public CASCADE");
  await handle.exec("CREATE SCHEMA public");
}

async function pgTableNames(): Promise<string[]> {
  const rows = await db().all<{ table_name: string }>(
    `SELECT table_name FROM information_schema.tables
     WHERE table_schema = 'public' AND table_type = 'BASE TABLE'
     ORDER BY table_name`,
  );
  return rows.map((row) => row.table_name);
}

async function applyBaseline(): Promise<void> {
  for (const statement of BASELINE_STATEMENTS) {
    await db().exec(statement);
  }
}

pgDescribe("pg baseline + runner (postgres)", () => {
  beforeEach(async () => {
    await resetPublicSchema();
  });

  test("the baseline applies to an empty database without error", async () => {
    await applyBaseline();
    const tables = await pgTableNames();
    expect(tables).toEqual([...BASELINE_TABLES]);
  });

  test("applying the baseline twice is a no-op (idempotent)", async () => {
    await applyBaseline();
    await applyBaseline();
    expect(await pgTableNames()).toEqual([...BASELINE_TABLES]);
  });

  test("the baseline excludes the log tables", async () => {
    await applyBaseline();
    const tables = await pgTableNames();
    expect(tables).not.toContain("llm_request_logs");
    expect(tables.some((t) => /compaction_log/.test(t))).toBe(false);
  });

  test("foreign keys and indexes are created", async () => {
    await applyBaseline();
    const fks = await db().get<{ count: number }>(
      `SELECT count(*)::int AS count FROM information_schema.table_constraints
       WHERE constraint_type = 'FOREIGN KEY' AND table_schema = 'public'`,
    );
    expect(fks!.count).toBeGreaterThan(50);
    const indexes = await db().get<{ count: number }>(
      `SELECT count(*)::int AS count FROM pg_indexes WHERE schemaname = 'public'`,
    );
    expect(indexes!.count).toBeGreaterThan(50);
  });

  test("round-trip: a synthetic SQLite schema becomes the expected PG shape", async () => {
    const sqlite = new Database(":memory:");
    sqlite.exec(
      `CREATE TABLE parent (id TEXT PRIMARY KEY, name TEXT NOT NULL, created_at INTEGER NOT NULL)`,
    );
    sqlite.exec(
      `CREATE TABLE child (
         id TEXT PRIMARY KEY,
         parent_id TEXT NOT NULL REFERENCES parent(id) ON DELETE CASCADE,
         payload BLOB,
         amount REAL,
         created_at INTEGER NOT NULL
       )`,
    );
    sqlite.exec(`CREATE INDEX idx_child_parent ON child (parent_id)`);
    const model = introspectSqlite(sqlite);
    sqlite.close();

    const statements = buildBaselineStatements(model);
    for (const statement of statements) {
      await db().exec(statement);
    }

    expect(await pgTableNames()).toEqual(["child", "parent"]);

    const columns = await db().all<{ column_name: string; data_type: string }>(
      `SELECT column_name, data_type FROM information_schema.columns
       WHERE table_schema = 'public' AND table_name = 'child'
       ORDER BY ordinal_position`,
    );
    expect(columns).toEqual([
      { column_name: "id", data_type: "text" },
      { column_name: "parent_id", data_type: "text" },
      { column_name: "payload", data_type: "bytea" },
      { column_name: "amount", data_type: "double precision" },
      { column_name: "created_at", data_type: "bigint" },
    ]);

    const fk = await db().get<{ count: number }>(
      `SELECT count(*)::int AS count FROM information_schema.table_constraints
       WHERE constraint_type = 'FOREIGN KEY' AND table_name = 'child'`,
    );
    expect(fk!.count).toBe(1);
    const index = await db().get<{ count: number }>(
      `SELECT count(*)::int AS count FROM pg_indexes
       WHERE schemaname = 'public' AND indexname = 'idx_child_parent'`,
    );
    expect(index!.count).toBe(1);
  });

  test("the runner applies steps, records them, and rolls back", async () => {
    // Baseline + a marker step: the runner mechanics under test, without the
    // unrelated data/schema steps PG_STEPS carries.
    const steps = [
      PG_STEPS[0]!,
      {
        name: "0009_test_marker",
        up: async () => {
          // no-op schema-wise; just exercises the ledger
        },
        down: async () => {
          // no-op; the ledger row is what the runner removes
        },
      },
    ];

    const applied = await runPgMigrations(db(), steps);
    expect(applied.applied).toEqual(["0000_baseline", "0009_test_marker"]);
    expect(await appliedPgSteps(db())).toEqual([
      "0000_baseline",
      "0009_test_marker",
    ]);
    expect(await pgTableNames()).toContain("messages");

    // Re-running applies nothing.
    const rerun = await runPgMigrations(db(), steps);
    expect(rerun.applied).toEqual([]);
    expect(rerun.skipped).toEqual(["0000_baseline", "0009_test_marker"]);

    // Roll back to the baseline: only the marker step is reverted.
    const rolledBack = await rollbackPgMigrations(db(), steps, {
      to: "0000_baseline",
    });
    expect(rolledBack.rolledBack).toEqual(["0009_test_marker"]);
    expect(await appliedPgSteps(db())).toEqual(["0000_baseline"]);

    // Roll back everything: the baseline drops its tables. The ledger table
    // itself is not part of the baseline and remains.
    const full = await rollbackPgMigrations(db(), steps, { to: null });
    expect(full.rolledBack).toEqual(["0000_baseline"]);
    expect(await pgTableNames()).toEqual([PG_MIGRATION_LEDGER]);
  });

  test("the v2 removal step drops and recovers the retired tables", async () => {
    const dropStep = PG_STEPS.find(
      (step) => step.name === "0001_drop_memory_v2_tables",
    );
    expect(dropStep).toBeDefined();

    await db().exec(`CREATE TABLE "activation_state" (id text)`);
    await db().exec(`CREATE TABLE "memory_v2_activation_logs" (id text)`);
    await db().exec(`CREATE TABLE "memory_v2_injection_events" (id text)`);

    await dropStep!.up(db());
    expect(await pgTableNames()).not.toContain("activation_state");
    expect(await pgTableNames()).not.toContain("memory_v2_activation_logs");
    expect(await pgTableNames()).not.toContain("memory_v2_injection_events");

    await dropStep!.down!(db());
    expect(await pgTableNames()).toContain("activation_state");
    expect(await pgTableNames()).toContain("memory_v2_activation_logs");
    expect(await pgTableNames()).toContain("memory_v2_injection_events");
  });

  test("the ledger table is present after a run", async () => {
    await runPgMigrations(db(), PG_STEPS);
    expect(await pgTableNames()).toContain(PG_MIGRATION_LEDGER);
  });
});

afterAll(async () => {
  // Leave the throwaway database clean for the next run.
  if (PG_URL) {
    await resetPublicSchema().catch(() => {
      /* best-effort */
    });
  }
});
