/**
 * Generic `telemetry_events` outbox on the `telemetry` slot (the shared
 * Postgres database). Rows carry the full wire `TelemetryEvent` built at record
 * time and are deleted after a successful flush. `recordTelemetryOutboxEvent`
 * is the consent-owning record layer; the storage seam functions carry no
 * consent logic - their call sites own gating.
 *
 * All access goes through the async `AsyncDb` facade with positional `?`
 * placeholders (see `docs/pg-port-translation.md`).
 */
import { v4 as uuid } from "uuid";

import { getTelemetryAsyncDb } from "../persistence/db-facade.js";
import { getRawShareAnalytics } from "../platform/consent-cache.js";
import { APP_VERSION } from "../version.js";
import type {
  OutboxTelemetryEventName,
  OutboxTelemetryEventOf,
  TelemetryEvent,
  TelemetryEventBase,
} from "./types.js";

/** Ids per DELETE chunk — stays under the bound-variable limit. */
const DELETE_CHUNK_SIZE = 500;

/**
 * Max age of a pending outbox row. The reporter prunes older rows at the
 * start of every flush cycle, in every consent state — this is what bounds
 * the unknown-consent buffering (a permanently-unknown state never resolves,
 * and a row this stale is worthless telemetry anyway).
 */
export const OUTBOX_MAX_ROW_AGE_MS = 30 * 24 * 60 * 60 * 1000;

/** One pending outbox row; `payload` is the wire `TelemetryEvent` JSON. */
export interface TelemetryOutboxRow {
  id: string;
  createdAt: number;
  payload: string;
}

/** One pending telemetry event to insert; `event` is the wire payload. */
export interface TelemetryOutboxInsert {
  id: string;
  name: string;
  createdAt: number;
  conversationId?: string | null;
  event: TelemetryEvent;
}

/**
 * Insert a batch of pending telemetry events as one multi-row INSERT —
 * all-or-nothing, so a mid-batch failure never leaves a partial batch
 * committed. Returns false when the telemetry DB is unavailable (degraded
 * mode), true once every row is inserted (or the batch is empty).
 */
export async function insertTelemetryOutboxEvents(
  rows: TelemetryOutboxInsert[],
): Promise<boolean> {
  const db = getTelemetryAsyncDb();
  if (!db) {
    return false;
  }
  if (rows.length === 0) {
    return true;
  }
  const placeholders = rows.map(() => "(?, ?, ?, ?, ?)").join(", ");
  const params = rows.flatMap((row) => [
    row.id,
    row.name,
    row.createdAt,
    row.conversationId ?? null,
    JSON.stringify(row.event),
  ]);
  await db
    .label("telemetry:outbox:insert")
    .run(
      `INSERT INTO telemetry_events (id, name, created_at, conversation_id, payload) VALUES ${placeholders}`,
      params,
    );
  return true;
}

/**
 * Insert one pending telemetry event. Returns false when the telemetry DB is
 * unavailable (degraded mode), true once the row is inserted.
 */
export async function insertTelemetryOutboxEvent(
  row: TelemetryOutboxInsert,
): Promise<boolean> {
  return insertTelemetryOutboxEvents([row]);
}

/**
 * Lower-level record escape hatch: for payloads that need the record-time
 * `(id, createdAt)` inside type-specific fields (onboarding's activation
 * `daemon_event_id` override and `completed_at`). Drops only on a confirmed
 * `share_analytics` opt-out — the record-time drop is a privacy courtesy for
 * known opt-outs. While consent is unknown (cold cache, no platform session)
 * the event is recorded: dropping on an unresolved state would permanently
 * destroy data, and consent is enforced again at flush time. Unknown-state
 * buffering is bounded — the reporter prunes rows older than
 * {@link OUTBOX_MAX_ROW_AGE_MS} each flush cycle. Generates the
 * outbox row identity, builds the wire payload via `buildEvent` (which owns
 * all stamping), and inserts. Returns the generated row identity, or null
 * when dropped for the opt-out or when the telemetry DB is unavailable
 * (degraded mode). Prefer `recordTelemetryEvent` when the payload doesn't
 * need them.
 */
export async function recordTelemetryOutboxEvent(
  name: string,
  buildEvent: (id: string, createdAt: number) => TelemetryEvent,
  opts?: { conversationId?: string | null },
): Promise<{ id: string; createdAt: number } | null> {
  if (getRawShareAnalytics() === false) {
    return null;
  }
  const id = uuid();
  const createdAt = Date.now();
  const inserted = await insertTelemetryOutboxEvent({
    id,
    name,
    createdAt,
    conversationId: opts?.conversationId ?? null,
    event: buildEvent(id, createdAt),
  });
  return inserted ? { id, createdAt } : null;
}

/**
 * Preferred record API for outbox events whose payload does not depend on
 * the record-time `(id, createdAt)`: stamps the `TelemetryEventBase` fields
 * (record-time `assistant_version` included) and inherits
 * `recordTelemetryOutboxEvent`'s consent gate and degraded-mode `null`.
 */
export function recordTelemetryEvent<N extends OutboxTelemetryEventName>(
  name: N,
  fields: Omit<OutboxTelemetryEventOf<N>, keyof TelemetryEventBase>,
  opts?: { conversationId?: string | null },
): Promise<{ id: string; createdAt: number } | null> {
  return recordTelemetryOutboxEvent(
    name,
    (id, createdAt) =>
      // Cast: TS cannot re-associate the `Omit<...>` spread with the stamped
      // base fields across a generic; `fields`' type guarantees the shape.
      // Base fields are stamped after the spread so a widened `fields` value
      // carrying base keys can never override them.
      ({
        ...fields,
        type: name,
        daemon_event_id: id,
        recorded_at: createdAt,
        assistant_version: APP_VERSION,
      }) as OutboxTelemetryEventOf<N>,
    opts,
  );
}

/**
 * Read the oldest pending rows for one event name in `(created_at, id)`
 * order. Empty when the telemetry DB is unavailable.
 */
export async function queryTelemetryOutboxBatch(
  name: string,
  limit: number,
): Promise<TelemetryOutboxRow[]> {
  const db = getTelemetryAsyncDb();
  if (!db) {
    return [];
  }
  return db
    .label("telemetry:outbox:query")
    .all<TelemetryOutboxRow>(
      'SELECT id, created_at AS "createdAt", payload FROM telemetry_events WHERE name = ? ORDER BY created_at ASC, id ASC LIMIT ?',
      [name, limit],
    );
}

/** Delete flushed rows by id, in chunks. No-op when db null or ids empty. */
export async function deleteTelemetryOutboxEvents(
  ids: string[],
): Promise<void> {
  const db = getTelemetryAsyncDb();
  if (!db || ids.length === 0) {
    return;
  }
  for (let i = 0; i < ids.length; i += DELETE_CHUNK_SIZE) {
    const chunk = ids.slice(i, i + DELETE_CHUNK_SIZE);
    const placeholders = chunk.map(() => "?").join(", ");
    await db
      .label("telemetry:outbox:delete")
      .run(`DELETE FROM telemetry_events WHERE id IN (${placeholders})`, chunk);
  }
}

/**
 * Delete rows recorded before `cutoffCreatedAt`, across every event name
 * (age-bound prune). Returns the deleted row count; 0 when the telemetry DB
 * is unavailable.
 */
export async function deleteTelemetryOutboxEventsBefore(
  cutoffCreatedAt: number,
): Promise<number> {
  const db = getTelemetryAsyncDb();
  if (!db) {
    return 0;
  }
  return db
    .label("telemetry:outbox:prune")
    .run("DELETE FROM telemetry_events WHERE created_at < ?", [
      cutoffCreatedAt,
    ]);
}

/** Drop all pending rows for one event name (telemetry opt-out). */
export async function discardPendingTelemetryOutboxEvents(
  name: string,
): Promise<void> {
  const db = getTelemetryAsyncDb();
  if (!db) {
    return;
  }
  await db
    .label("telemetry:outbox:discard")
    .run("DELETE FROM telemetry_events WHERE name = ?", [name]);
}

/**
 * Distinct event names with at least one pending row in the outbox. Used by the
 * orphan-drain source to find rows whose type is no longer in the wire contract
 * (e.g. recorded before the platform removed/renamed a type) so they can be
 * flushed instead of stranded. Empty when the telemetry DB is unavailable.
 */
export async function queryDistinctOutboxEventNames(): Promise<string[]> {
  const db = getTelemetryAsyncDb();
  if (!db) {
    return [];
  }
  const rows = await db
    .label("telemetry:outbox:distinct")
    .all<{ name: string }>("SELECT DISTINCT name FROM telemetry_events");
  return rows.map((row) => row.name);
}
