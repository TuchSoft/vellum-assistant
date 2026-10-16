/**
 * Baseline DDL for the telemetry slice on Postgres.
 *
 * Pilot-scoped: the Postgres backend applies these idempotent statements on
 * first use so the telemetry store runs unchanged on both backends. The real
 * port replaces this with the P11 baseline generated from the live SQLite
 * schema plus the Postgres migration runner; this file exists only to prove the
 * slice end-to-end on Postgres and to name the type mapping (epoch-ms -> bigint,
 * TEXT payload -> TEXT, TEXT id/name -> TEXT).
 */

export const TELEMETRY_PG_BASELINE: readonly string[] = [
  `CREATE TABLE IF NOT EXISTS telemetry_events (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    created_at BIGINT NOT NULL,
    conversation_id TEXT,
    payload TEXT NOT NULL
  )`,
  `CREATE INDEX IF NOT EXISTS idx_telemetry_events_name_created_at_id
    ON telemetry_events (name, created_at, id)`,
  `CREATE INDEX IF NOT EXISTS idx_telemetry_events_conversation_id
    ON telemetry_events (conversation_id)`,
  `CREATE TABLE IF NOT EXISTS flush_checkpoints (
    key TEXT PRIMARY KEY,
    value TEXT NOT NULL,
    updated_at BIGINT NOT NULL
  )`,
];
