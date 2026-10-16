import { getTelemetryAsyncDb } from "../persistence/db-facade.js";

/**
 * Telemetry flush state — the per-event-type watermark cursors the usage
 * telemetry reporter advances after each successful upload. Backed by the
 * `flush_checkpoints` table on the dedicated telemetry database
 * (`assistant-telemetry.db`); the main DB's `memory_checkpoints` ledger is
 * reserved for DB-migration checkpoints.
 *
 * All access goes through the async `AsyncDb` facade, so the store runs
 * unchanged on the SQLite and Postgres backends. Reads and writes are
 * no-op/null when the telemetry DB cannot be opened at all. Callers that must
 * not mistake an unreadable store for "no watermark" (which would re-ship
 * history from cursor 0) should gate on
 * {@link isFlushCheckpointStoreAvailable} first.
 */

/** True when the telemetry DB connection is open. */
export function isFlushCheckpointStoreAvailable(): Promise<boolean> {
  return Promise.resolve(getTelemetryAsyncDb() != null);
}

export async function getFlushCheckpoint(key: string): Promise<string | null> {
  const db = getTelemetryAsyncDb();
  if (!db) {
    return null;
  }
  const row = await db.label("telemetry:checkpoint:get").get<{
    value: string;
  }>("SELECT value FROM flush_checkpoints WHERE key = ?", [key]);
  return row?.value ?? null;
}

export async function setFlushCheckpoint(
  key: string,
  value: string,
): Promise<void> {
  const db = getTelemetryAsyncDb();
  if (!db) {
    return;
  }
  const now = Date.now();
  await db.label("telemetry:checkpoint:set").run(
    `INSERT INTO flush_checkpoints (key, value, updated_at) VALUES (?, ?, ?)
     ON CONFLICT (key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`,
    [key, value, now],
  );
}

/**
 * Watermark storage seam for the usage telemetry reporter. The reporter
 * takes this as a constructor dependency (defaulting to
 * {@link telemetryDbFlushCheckpointStore}) so tests can substitute an
 * in-memory fake without process-global module mocking.
 */
export interface FlushCheckpointStore {
  isAvailable(): Promise<boolean>;
  get(key: string): Promise<string | null>;
  set(key: string, value: string): Promise<void>;
}

/** The production store, backed by the telemetry DB's `flush_checkpoints`. */
export const telemetryDbFlushCheckpointStore: FlushCheckpointStore = {
  isAvailable: isFlushCheckpointStoreAvailable,
  get: getFlushCheckpoint,
  set: setFlushCheckpoint,
};
