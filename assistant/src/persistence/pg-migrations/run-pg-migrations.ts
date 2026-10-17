/**
 * Postgres migration runner.
 *
 * Mirrors the shape of the SQLite runner (`persistence/migrations/run-migrations.ts`):
 * an ordered step list, a durable ledger so an already-applied step is skipped,
 * and per-step `down` for rollback. It runs on the `AsyncDb` facade, so the
 * same runner works against the Postgres backend the facade exposes.
 *
 * The ledger lives in its own table (`pg_schema_migrations`) on the target
 * database, independent of the SQLite `memory_checkpoints` bookkeeping.
 */

import type { AsyncDb } from "../db-facade.js";

export interface PgMigrationStep {
  /** Stable, unique name recorded in the ledger. */
  name: string;
  /** Apply the step. */
  up: (db: AsyncDb) => Promise<void> | void;
  /** Reverse the step. Optional: a data-only step may be irreversible. */
  down?: (db: AsyncDb) => Promise<void> | void;
}

export const PG_MIGRATION_LEDGER = "pg_schema_migrations";

export interface PgMigrationRunResult {
  applied: string[];
  skipped: string[];
}

export interface PgMigrationRollbackResult {
  rolledBack: string[];
}

/** Create the ledger table if it does not exist. */
export async function ensurePgLedger(db: AsyncDb): Promise<void> {
  await db.exec(
    `CREATE TABLE IF NOT EXISTS "${PG_MIGRATION_LEDGER}" (
      name TEXT PRIMARY KEY,
      applied_at BIGINT NOT NULL
    )`,
  );
}

/** Names of applied steps, in application order. */
export async function appliedPgSteps(db: AsyncDb): Promise<string[]> {
  await ensurePgLedger(db);
  const rows = await db.all<{ name: string }>(
    `SELECT name FROM "${PG_MIGRATION_LEDGER}" ORDER BY applied_at ASC, name ASC`,
  );
  return rows.map((row) => row.name);
}

/**
 * Apply every not-yet-applied step, in order. A step that throws aborts the run
 * (the ledger keeps the earlier steps recorded, so a retry resumes where it
 * stopped).
 */
export async function runPgMigrations(
  db: AsyncDb,
  steps: readonly PgMigrationStep[],
): Promise<PgMigrationRunResult> {
  await ensurePgLedger(db);
  const applied = new Set(await appliedPgSteps(db));
  const appliedNow: string[] = [];
  const skipped: string[] = [];

  for (const step of steps) {
    if (applied.has(step.name)) {
      skipped.push(step.name);
      continue;
    }
    await step.up(db);
    await db.run(
      `INSERT INTO "${PG_MIGRATION_LEDGER}" (name, applied_at) VALUES (?, ?)`,
      [step.name, Date.now()],
    );
    applied.add(step.name);
    appliedNow.push(step.name);
  }

  return { applied: appliedNow, skipped };
}

/**
 * Roll back applied steps in reverse order. With `to`, every step applied after
 * `to` is rolled back and `to` itself is kept; without it, every applied step is
 * rolled back. A step with no `down` is left applied and stops the rollback
 * (skipping it would leave the ledger claiming a state the schema is not in).
 */
export async function rollbackPgMigrations(
  db: AsyncDb,
  steps: readonly PgMigrationStep[],
  options: { to?: string | null } = {},
): Promise<PgMigrationRollbackResult> {
  await ensurePgLedger(db);
  const applied = new Set(await appliedPgSteps(db));
  const targetIndex =
    options.to == null
      ? -1
      : steps.findIndex((step) => step.name === options.to);
  if (options.to != null && targetIndex === -1) {
    throw new Error(`rollback target step not found: ${options.to}`);
  }

  const rolledBack: string[] = [];
  for (let index = steps.length - 1; index > targetIndex; index--) {
    const step = steps[index]!;
    if (!applied.has(step.name)) {
      continue;
    }
    if (!step.down) {
      throw new Error(
        `step "${step.name}" has no down migration; cannot roll back past it`,
      );
    }
    await step.down(db);
    await db.run(`DELETE FROM "${PG_MIGRATION_LEDGER}" WHERE name = ?`, [
      step.name,
    ]);
    applied.delete(step.name);
    rolledBack.push(step.name);
  }

  return { rolledBack };
}
