import { and, asc, desc, eq, gte, lte } from "drizzle-orm";
import { v4 as uuid } from "uuid";

import type { SchemaTables } from "../persistence/db-facade.js";
import { requireMainDb } from "../persistence/db-facade.js";
import { isLifecycleQuiesced } from "../persistence/lifecycle-quiesce.js";
import { truncate } from "../util/truncate.js";
import { DEFAULT_POLL_INTERVAL_MS } from "./constants.js";

// ── Interfaces ──────────────────────────────────────────────────────

export interface Watcher {
  id: string;
  name: string;
  providerId: string;
  enabled: boolean;
  pollIntervalMs: number;
  actionPrompt: string;
  watermark: string | null;
  conversationId: string | null;
  status: string;
  consecutiveErrors: number;
  lastError: string | null;
  lastPollAt: number | null;
  nextPollAt: number;
  configJson: string | null;
  credentialService: string;
  createdAt: number;
  updatedAt: number;
}

export interface WatcherEvent {
  id: string;
  watcherId: string;
  externalId: string;
  eventType: string;
  summary: string;
  payloadJson: string;
  disposition: string;
  llmAction: string | null;
  processedAt: number | null;
  createdAt: number;
}

type WatcherRow = SchemaTables["watchers"]["$inferSelect"];
type WatcherEventRow = SchemaTables["watcherEvents"]["$inferSelect"];

// ── Watcher CRUD ────────────────────────────────────────────────────

export async function createWatcher(params: {
  name: string;
  providerId: string;
  actionPrompt: string;
  credentialService: string;
  pollIntervalMs?: number;
  enabled?: boolean;
  configJson?: string | null;
}): Promise<Watcher> {
  const db = requireMainDb();
  const watchers = db.schema.watchers;
  const id = uuid();
  const now = Date.now();
  const pollIntervalMs = params.pollIntervalMs ?? DEFAULT_POLL_INTERVAL_MS;
  const enabled = params.enabled ?? true;

  const row = {
    id,
    name: params.name,
    providerId: params.providerId,
    enabled,
    pollIntervalMs,
    actionPrompt: params.actionPrompt,
    watermark: null as string | null,
    conversationId: null as string | null,
    status: "idle",
    consecutiveErrors: 0,
    lastError: null as string | null,
    lastPollAt: null as number | null,
    nextPollAt: enabled ? now : 0,
    configJson: params.configJson ?? null,
    credentialService: params.credentialService,
    createdAt: now,
    updatedAt: now,
  };

  await db.orm.insert(watchers).values(row);
  return row;
}

export async function getWatcher(id: string): Promise<Watcher | null> {
  const db = requireMainDb();
  const watchers = db.schema.watchers;
  const rows = await db.orm.select().from(watchers).where(eq(watchers.id, id));
  const row = rows[0];
  if (!row) {
    return null;
  }
  return parseWatcherRow(row);
}

export async function listWatchers(options?: {
  enabledOnly?: boolean;
}): Promise<Watcher[]> {
  const db = requireMainDb();
  const watchers = db.schema.watchers;
  const conditions = options?.enabledOnly
    ? eq(watchers.enabled, true)
    : undefined;
  const rows = await db.orm
    .select()
    .from(watchers)
    .where(conditions)
    .orderBy(asc(watchers.createdAt));
  return rows.map(parseWatcherRow);
}

export async function updateWatcher(
  id: string,
  updates: {
    name?: string;
    actionPrompt?: string;
    pollIntervalMs?: number;
    enabled?: boolean;
    configJson?: string | null;
  },
): Promise<Watcher | null> {
  const db = requireMainDb();
  const watchers = db.schema.watchers;
  const rows = await db.orm.select().from(watchers).where(eq(watchers.id, id));
  const existing = rows[0];
  if (!existing) {
    return null;
  }

  const now = Date.now();
  const set: Partial<typeof watchers.$inferInsert> = { updatedAt: now };

  if (updates.name !== undefined) {
    set.name = updates.name;
  }
  if (updates.actionPrompt !== undefined) {
    set.actionPrompt = updates.actionPrompt;
  }
  if (updates.pollIntervalMs !== undefined) {
    set.pollIntervalMs = updates.pollIntervalMs;
  }
  if (updates.configJson !== undefined) {
    set.configJson = updates.configJson;
  }

  if (updates.enabled !== undefined) {
    set.enabled = updates.enabled;
    if (updates.enabled && !existing.enabled) {
      // Re-enabling: schedule next poll now, reset errors
      set.status = "idle";
      set.nextPollAt = now;
      set.consecutiveErrors = 0;
      set.lastError = null;
    } else if (!updates.enabled) {
      set.status = "disabled";
    }
  }

  await db.orm.update(watchers).set(set).where(eq(watchers.id, id));
  return await getWatcher(id);
}

export async function deleteWatcher(id: string): Promise<boolean> {
  const db = requireMainDb();
  const watchers = db.schema.watchers;
  const deleted = await db.orm
    .delete(watchers)
    .where(eq(watchers.id, id))
    .returning({ id: watchers.id });
  return deleted.length > 0;
}

// ── Claim / Complete ────────────────────────────────────────────────

/**
 * Atomically claim watchers that are due for polling. Sets their status
 * to 'polling' using optimistic locking on the current nextPollAt.
 */
export async function claimDueWatchers(now: number): Promise<Watcher[]> {
  // Drain gate: while a quiesce lease is active, claim nothing. A watcher
  // poll runs provider requests that create no row the drain snapshot can
  // see, so it must not start at all. Fail-open via the lease read.
  if (await isLifecycleQuiesced()) {
    return [];
  }

  const db = requireMainDb();
  const watchers = db.schema.watchers;
  const candidates = await db.orm
    .select()
    .from(watchers)
    .where(
      and(
        eq(watchers.enabled, true),
        eq(watchers.status, "idle"),
        lte(watchers.nextPollAt, now),
      ),
    )
    .orderBy(asc(watchers.nextPollAt));

  const claimed: Watcher[] = [];
  for (const row of candidates) {
    const locked = await db.orm
      .update(watchers)
      .set({ status: "polling", updatedAt: now })
      .where(
        and(
          eq(watchers.id, row.id),
          eq(watchers.nextPollAt, row.nextPollAt),
          eq(watchers.status, "idle"),
        ),
      )
      .returning({ id: watchers.id });

    if (locked.length === 0) {
      continue;
    }
    claimed.push(
      parseWatcherRow({ ...row, status: "polling", updatedAt: now }),
    );
  }
  return claimed;
}

/**
 * Complete a watcher poll: update watermark, advance nextPollAt, reset errors.
 */
export async function completeWatcherPoll(
  id: string,
  result: { watermark: string; conversationId?: string },
): Promise<void> {
  const db = requireMainDb();
  const watchers = db.schema.watchers;
  const rows = await db.orm.select().from(watchers).where(eq(watchers.id, id));
  const watcher = rows[0];
  if (!watcher) {
    return;
  }

  const now = Date.now();
  const set: Partial<typeof watchers.$inferInsert> = {
    status: "idle",
    watermark: result.watermark,
    lastPollAt: now,
    nextPollAt: now + watcher.pollIntervalMs,
    consecutiveErrors: 0,
    lastError: null,
    updatedAt: now,
  };

  if (result.conversationId) {
    set.conversationId = result.conversationId;
  }

  await db.orm.update(watchers).set(set).where(eq(watchers.id, id));
}

/**
 * Skip a watcher poll: apply backoff to nextPollAt without incrementing
 * consecutiveErrors. Used when a poll is skipped for a recoverable reason
 * (e.g. credential health gate) that should NOT count toward the circuit
 * breaker threshold.
 */
export async function skipWatcherPoll(
  id: string,
  reason: string,
): Promise<void> {
  const db = requireMainDb();
  const watchers = db.schema.watchers;
  const rows = await db.orm.select().from(watchers).where(eq(watchers.id, id));
  const watcher = rows[0];
  if (!watcher) {
    return;
  }

  const now = Date.now();
  // Use the same backoff formula but based on existing consecutiveErrors
  // (which stays unchanged). Minimum backoff of 30s.
  const backoff = Math.min(
    30_000 * Math.pow(2, watcher.consecutiveErrors),
    60 * 60 * 1000,
  );

  await db.orm
    .update(watchers)
    .set({
      status: "idle",
      lastError: truncate(reason, 2000, ""),
      lastPollAt: now,
      nextPollAt: now + backoff,
      updatedAt: now,
    })
    .where(eq(watchers.id, id));
}

/**
 * Record a poll error: increment consecutive errors, apply backoff.
 */
export async function failWatcherPoll(
  id: string,
  error: string,
): Promise<void> {
  const db = requireMainDb();
  const watchers = db.schema.watchers;
  const rows = await db.orm.select().from(watchers).where(eq(watchers.id, id));
  const watcher = rows[0];
  if (!watcher) {
    return;
  }

  const now = Date.now();
  const errors = watcher.consecutiveErrors + 1;
  // Exponential backoff: base * 2^(errors-1), capped at 1 hour
  const backoff = Math.min(30_000 * Math.pow(2, errors - 1), 60 * 60 * 1000);

  await db.orm
    .update(watchers)
    .set({
      status: "idle",
      consecutiveErrors: errors,
      lastError: truncate(error, 2000, ""),
      lastPollAt: now,
      nextPollAt: now + backoff,
      updatedAt: now,
    })
    .where(eq(watchers.id, id));
}

/**
 * Disable a watcher (circuit breaker tripped).
 */
export async function disableWatcher(
  id: string,
  reason: string,
): Promise<void> {
  const db = requireMainDb();
  const watchers = db.schema.watchers;
  await db.orm
    .update(watchers)
    .set({
      status: "disabled",
      enabled: false,
      lastError: truncate(reason, 2000, ""),
      updatedAt: Date.now(),
    })
    .where(eq(watchers.id, id));
}

/**
 * Persist a background conversation ID for a watcher.
 * Called after creating the conversation in Phase 2 of the engine tick.
 */
export async function setWatcherConversationId(
  id: string,
  conversationId: string,
): Promise<void> {
  const db = requireMainDb();
  const watchers = db.schema.watchers;
  await db.orm
    .update(watchers)
    .set({ conversationId, updatedAt: Date.now() })
    .where(eq(watchers.id, id));
}

/**
 * Reset watchers stuck in 'polling' back to 'idle' (daemon restart recovery).
 */
export async function resetStuckWatchers(): Promise<number> {
  const db = requireMainDb();
  const watchers = db.schema.watchers;
  const updated = await db.orm
    .update(watchers)
    .set({ status: "idle", updatedAt: Date.now() })
    .where(eq(watchers.status, "polling"))
    .returning({ id: watchers.id });
  return updated.length;
}

// ── Watcher Events ──────────────────────────────────────────────────

/**
 * Insert a watcher event with dedup on (watcher_id, external_id).
 * Returns true if the event was inserted (new), false if it already existed.
 */
export async function insertWatcherEvent(params: {
  watcherId: string;
  externalId: string;
  eventType: string;
  summary: string;
  payloadJson: string;
}): Promise<boolean> {
  const db = requireMainDb();
  const watcherEvents = db.schema.watcherEvents;
  const id = uuid();
  const now = Date.now();

  const inserted = await db.orm
    .insert(watcherEvents)
    .values({
      id,
      watcherId: params.watcherId,
      externalId: params.externalId,
      eventType: params.eventType,
      summary: params.summary,
      payloadJson: params.payloadJson,
      disposition: "pending",
      llmAction: null,
      processedAt: null,
      createdAt: now,
    })
    .onConflictDoNothing()
    .returning({ id: watcherEvents.id });
  return inserted.length > 0;
}

/**
 * Update the disposition and LLM action for a watcher event.
 */
export async function updateEventDisposition(
  eventId: string,
  disposition: string,
  llmAction?: string,
): Promise<void> {
  const db = requireMainDb();
  const watcherEvents = db.schema.watcherEvents;
  await db.orm
    .update(watcherEvents)
    .set({
      disposition,
      llmAction: llmAction?.slice(0, 5000) ?? null,
      processedAt: Date.now(),
    })
    .where(eq(watcherEvents.id, eventId));
}

/**
 * Get pending events for a watcher.
 */
export async function getPendingEvents(
  watcherId: string,
): Promise<WatcherEvent[]> {
  const db = requireMainDb();
  const watcherEvents = db.schema.watcherEvents;
  const rows = await db.orm
    .select()
    .from(watcherEvents)
    .where(
      and(
        eq(watcherEvents.watcherId, watcherId),
        eq(watcherEvents.disposition, "pending"),
      ),
    )
    .orderBy(asc(watcherEvents.createdAt));
  return rows.map(parseEventRow);
}

/**
 * List watcher events for digest queries.
 */
export async function listWatcherEvents(options?: {
  watcherId?: string;
  limit?: number;
  since?: number;
}): Promise<WatcherEvent[]> {
  const db = requireMainDb();
  const watcherEvents = db.schema.watcherEvents;
  const conditions = [];
  if (options?.watcherId) {
    conditions.push(eq(watcherEvents.watcherId, options.watcherId));
  }
  if (options?.since) {
    conditions.push(gte(watcherEvents.createdAt, options.since));
  }

  const where = conditions.length > 0 ? and(...conditions) : undefined;

  const rows = await db.orm
    .select()
    .from(watcherEvents)
    .where(where)
    .orderBy(desc(watcherEvents.createdAt))
    .limit(options?.limit ?? 50);
  return rows.map(parseEventRow);
}

// ── Row parsers ─────────────────────────────────────────────────────

function parseWatcherRow(row: WatcherRow): Watcher {
  return {
    id: row.id,
    name: row.name,
    providerId: row.providerId,
    enabled: row.enabled,
    pollIntervalMs: row.pollIntervalMs,
    actionPrompt: row.actionPrompt,
    watermark: row.watermark,
    conversationId: row.conversationId,
    status: row.status,
    consecutiveErrors: row.consecutiveErrors,
    lastError: row.lastError,
    lastPollAt: row.lastPollAt,
    nextPollAt: row.nextPollAt,
    configJson: row.configJson,
    credentialService: row.credentialService,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}

function parseEventRow(row: WatcherEventRow): WatcherEvent {
  return {
    id: row.id,
    watcherId: row.watcherId,
    externalId: row.externalId,
    eventType: row.eventType,
    summary: row.summary,
    payloadJson: row.payloadJson,
    disposition: row.disposition,
    llmAction: row.llmAction,
    processedAt: row.processedAt,
    createdAt: row.createdAt,
  };
}
