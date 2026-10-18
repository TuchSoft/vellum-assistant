/**
 * Postgres database initialization for the daemon boot path.
 *
 * Applies the ordered `PG_STEPS` through the async facade, which owns the
 * schema for every runtime store. The ledger (`pg_schema_migrations`) makes a
 * re-run a no-op, so a restart only applies steps added since the last boot.
 *
 * A missing `VELLUM_DATABASE_URL` is reported as a migration failure rather
 * than thrown: the daemon continues in degraded mode (HTTP server up,
 * `/readyz` unready) so an operator can reach diagnostics.
 */

import { getLogger } from "../../util/logger.js";
import { getAsyncDb } from "../db-facade.js";
import type { InitializeDbResult } from "../initialize-result.js";
import { PG_STEPS } from "./pg-steps.js";
import { runPgMigrations } from "./run-pg-migrations.js";

export async function initializePostgresDb(): Promise<InitializeDbResult> {
  const log = getLogger("pg-db-init");
  const db = getAsyncDb();
  if (!db) {
    const error = "VELLUM_DATABASE_URL is not configured";
    log.error(error);
    return {
      migrationsOk: false,
      failedMigrations: [{ name: "postgres-migrations", error }],
      deferredMigrations: [],
      validationError: error,
    };
  }

  try {
    const { applied, skipped } = await runPgMigrations(db, PG_STEPS);
    log.info(
      {
        applied: applied.length,
        skipped: skipped.length,
        total: PG_STEPS.length,
      },
      "Postgres migration steps complete",
    );
    return { migrationsOk: true, failedMigrations: [], deferredMigrations: [] };
  } catch (err) {
    const error = err instanceof Error ? err.message : String(err);
    log.error({ err }, "Postgres migration steps failed");
    return {
      migrationsOk: false,
      failedMigrations: [{ name: "postgres-migrations", error }],
      deferredMigrations: [],
      validationError: error,
    };
  }
}
