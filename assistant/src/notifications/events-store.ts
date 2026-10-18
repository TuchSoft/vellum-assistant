/**
 * Notification event persistence.
 *
 * Each row represents a single notification signal that was emitted by
 * the system. The event captures the source event name, attention hints,
 * and context payload. Decision/delivery records are tracked separately.
 */

import { and, desc, eq, gte, inArray, or } from "drizzle-orm";

import type { SchemaTables } from "../persistence/db-facade.js";
import { requireMainDb } from "../persistence/db-facade.js";
import type { AttentionHints } from "./signal.js";

export interface NotificationEventRow {
  id: string;
  sourceEventName: string;
  sourceChannel: string;
  sourceContextId: string;
  attentionHintsJson: string;
  payloadJson: string;
  dedupeKey: string | null;
  createdAt: number;
  updatedAt: number;
}

function rowToEvent(
  row: SchemaTables["notificationEvents"]["$inferSelect"],
): NotificationEventRow {
  return {
    id: row.id,
    sourceEventName: row.sourceEventName,
    sourceChannel: row.sourceChannel,
    sourceContextId: row.sourceContextId,
    attentionHintsJson: row.attentionHintsJson,
    payloadJson: row.payloadJson,
    dedupeKey: row.dedupeKey,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}

export interface CreateEventParams {
  id: string;
  sourceEventName: string;
  sourceChannel: string;
  sourceContextId: string;
  attentionHints: AttentionHints;
  payload: Record<string, unknown>;
  dedupeKey?: string;
}

/** Create a new notification event. Returns null if a duplicate dedupe_key exists. */
export async function createEvent(
  params: CreateEventParams,
): Promise<NotificationEventRow | null> {
  const db = requireMainDb();
  const events = db.schema.notificationEvents;
  const now = Date.now();

  // Normalize empty strings to null so the falsy check below and the DB
  // unique index stay in agreement.
  const normalizedDedupeKey = params.dedupeKey || null;

  const row = {
    id: params.id,
    sourceEventName: params.sourceEventName,
    sourceChannel: params.sourceChannel,
    sourceContextId: params.sourceContextId,
    attentionHintsJson: JSON.stringify(params.attentionHints),
    payloadJson: JSON.stringify(params.payload),
    dedupeKey: normalizedDedupeKey,
    createdAt: now,
    updatedAt: now,
  };

  // If there's a dedupe key, the unique index is the authority: a
  // check-then-insert races across pool connections, so let the insert
  // report whether this caller won.
  const inserted = await db.orm
    .insert(events)
    .values(row)
    .onConflictDoNothing()
    .returning({ id: events.id });

  return inserted.length > 0 ? row : null;
}

/**
 * Write an existing event's dedupe key. A string claims that key, which is
 * how a decision-engine-generated key lands on the row. `null` releases the
 * claim so a later event may take it while this row stays for the audit
 * trail.
 */
export async function setEventDedupeKey(
  eventId: string,
  dedupeKey: string | null,
): Promise<void> {
  const db = requireMainDb();
  const events = db.schema.notificationEvents;
  await db.orm
    .update(events)
    .set({ dedupeKey, updatedAt: Date.now() })
    .where(eq(events.id, eventId));
}

export interface ListEventsFilters {
  sourceEventName?: string;
  limit?: number;
}

/** List notification events with optional filters. */
export async function listEvents(
  filters?: ListEventsFilters,
): Promise<NotificationEventRow[]> {
  const db = requireMainDb();
  const events = db.schema.notificationEvents;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const conditions: any[] = [];

  if (filters?.sourceEventName) {
    conditions.push(eq(events.sourceEventName, filters.sourceEventName));
  }

  const limit = filters?.limit ?? 50;

  const query = db.orm.select().from(events);

  const rows = await (
    conditions.length > 0 ? query.where(and(...conditions)) : query
  )
    .orderBy(desc(events.createdAt))
    .limit(limit);

  return rows.map(rowToEvent);
}

/**
 * True when a notification emitted against `sourceContextId` at or after
 * `sinceMs` reached a verdict the user can be said to have received.
 *
 * The schedule-result producer's "did this run already speak for itself?"
 * probe. A run's conversation id is the `sourceContextId` every notification
 * the run emits carries — `assistant notifications send` resolves it from
 * `__CONVERSATION_ID` — so a hit means the agent notified on its own and the
 * fallback must stay quiet.
 *
 * An event row alone is not a hit. `emitNotificationSignal` persists the event
 * first and the pipeline can still fail after that, leaving an audit row for a
 * notification nobody received; counting it would suppress the fallback in
 * exactly the case it exists for. A hit therefore needs one of:
 *
 * - a decision **not** to notify. The engine ruled on the run's own signal
 *   (preferences, quiet hours, its own judgment), and the fallback exists to
 *   cover runs that never asked, not to appeal verdicts the user's settings
 *   produced; or
 * - a delivery row that is `sent` or still `pending` — something went out, or
 *   is about to. An event whose every delivery `failed`, or that never got a
 *   decision row at all, does not count.
 *
 * The `sinceMs` bound is load-bearing rather than an optimization: a recurring
 * schedule with `reuseConversation` runs every firing in the same conversation,
 * so an unbounded probe would see last week's notification and silence every
 * run after the first.
 */
export async function hasNotifiedSourceContextSince(
  sourceContextId: string,
  sinceMs: number,
  sourceEventNames?: readonly string[],
): Promise<boolean> {
  const db = requireMainDb();
  const events = db.schema.notificationEvents;
  const decisions = db.schema.notificationDecisions;
  const deliveries = db.schema.notificationDeliveries;
  const [row] = await db.orm
    .select({ id: events.id })
    .from(events)
    .innerJoin(decisions, eq(decisions.notificationEventId, events.id))
    .leftJoin(deliveries, eq(deliveries.notificationDecisionId, decisions.id))
    .where(
      and(
        eq(events.sourceContextId, sourceContextId),
        gte(events.createdAt, sinceMs),
        sourceEventNames
          ? inArray(events.sourceEventName, [...sourceEventNames])
          : undefined,
        or(
          eq(decisions.shouldNotify, 0),
          inArray(deliveries.status, ["pending", "sent"]),
        ),
      ),
    )
    .limit(1);
  return row !== undefined;
}
