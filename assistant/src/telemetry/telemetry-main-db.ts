import type { AsyncDb } from "../persistence/db-facade.js";
import { requireMainDb } from "../persistence/db-facade.js";

/**
 * Main-DB resolution for the telemetry stores' unreported-event queries.
 *
 * Every telemetry store reads the shared Postgres database through the async
 * facade. The legacy `useReadOnlyMainDbForTelemetry` posture had no Postgres
 * equivalent: a single facade serves every slot, so the read-only distinction
 * is documented here as a no-op and the caller keeps its call shape stable.
 */

/**
 * Retained for the resource monitor's startup call. The Postgres facade has no
 * separate read-only posture, so this records intent without changing the
 * connection.
 */
export function useReadOnlyMainDbForTelemetry(): void {
  // No-op: the Postgres facade serves one connection per slot.
}

/**
 * The main-DB facade for telemetry queries. Throws when the database is
 * unavailable so the reporter's flush treats the cycle as non-fatal and
 * retries next time.
 */
export function getTelemetryMainDb(): AsyncDb {
  return requireMainDb();
}
