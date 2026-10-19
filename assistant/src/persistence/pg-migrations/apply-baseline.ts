/**
 * Baseline application gate.
 *
 * The generated baseline is a snapshot of a *fresh* database. Once the
 * migration steps have evolved that schema (e.g. `0002_alias_model_columns`
 * dropped the retired `inference_profile*` columns), replaying the baseline
 * would fail on its `CREATE INDEX ... (dropped_column)` statements.
 *
 * The baseline therefore applies only when the application schema does not
 * exist yet. On an existing database the step ledger and the ordered steps own
 * every subsequent change.
 */

import type { AsyncDb } from "../db-facade.js";

/**
 * Probe for the application schema. Unqualified on purpose: it resolves
 * through the connection's `search_path`, which is `public` in production and
 * the isolated test schema in the Postgres test bootstrap.
 */
export const APPLICATION_SCHEMA_PROBE_SQL =
  "SELECT to_regclass('conversations') IS NOT NULL AS present";

export interface ApplicationSchemaProbeRow {
  present: boolean;
}

/** Whether the application schema (the `conversations` table) already exists. */
export async function applicationSchemaExists(db: AsyncDb): Promise<boolean> {
  const row = await db.get<ApplicationSchemaProbeRow>(
    APPLICATION_SCHEMA_PROBE_SQL,
  );
  return row?.present === true;
}

/**
 * Apply the baseline only on an empty database. Returns true when the
 * statements ran, false when an existing schema made them a no-op.
 */
export async function applyBaselineIfNeeded(
  db: AsyncDb,
  statements: readonly string[],
): Promise<boolean> {
  if (await applicationSchemaExists(db)) {
    return false;
  }
  for (const statement of statements) {
    await db.exec(statement);
  }
  return true;
}
