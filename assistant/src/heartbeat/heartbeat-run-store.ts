import {
  and,
  desc,
  eq,
  gt,
  inArray,
  isNotNull,
  lt,
  notInArray,
  sql,
} from "drizzle-orm";
import { v4 as uuid } from "uuid";

import type { SchemaTables } from "../persistence/db-facade.js";
import { requireMainDb } from "../persistence/db-facade.js";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type HeartbeatRunStatus =
  | "pending"
  | "running"
  | "ok"
  | "error"
  | "timeout"
  | "skipped"
  | "missed"
  | "superseded";

export type HeartbeatSkipReason =
  | "disabled"
  | "outside_active_hours"
  | "overlap"
  | "pre_first_user_message"
  | "max_consecutive_runs"
  | "max_daily_runs"
  | "quiesced";

export interface HeartbeatRunRecord {
  id: string;
  scheduledFor: number;
  startedAt: number | null;
  finishedAt: number | null;
  durationMs: number | null;
  status: HeartbeatRunStatus;
  skipReason: string | null;
  error: string | null;
  conversationId: string | null;
  createdAt: number;
}

type HeartbeatRunRow = SchemaTables["heartbeatRuns"]["$inferSelect"];

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/** Threshold for marking stale running rows as error (45 minutes). */
const STALE_RUNNING_THRESHOLD_MS = 45 * 60 * 1000;

// ---------------------------------------------------------------------------
// Store functions
// ---------------------------------------------------------------------------

/**
 * Insert a new heartbeat run in `pending` status.
 * Returns the generated run id.
 */
export async function insertPendingHeartbeatRun(
  scheduledFor: number,
): Promise<string> {
  const db = requireMainDb();
  const runs = db.schema.heartbeatRuns;
  const id = uuid();
  const now = Date.now();
  await db.orm.insert(runs).values({
    id,
    scheduledFor,
    startedAt: null,
    finishedAt: null,
    durationMs: null,
    status: "pending",
    skipReason: null,
    error: null,
    conversationId: null,
    createdAt: now,
  });
  return id;
}

/**
 * CAS transition from `pending` to `running`. Sets `startedAt` to now.
 * Returns `true` if the transition succeeded.
 */
export async function startHeartbeatRun(runId: string): Promise<boolean> {
  const db = requireMainDb();
  const runs = db.schema.heartbeatRuns;
  const now = Date.now();
  const updated = await db.orm
    .update(runs)
    .set({ status: "running", startedAt: now })
    .where(sql`${runs.id} = ${runId} AND ${runs.status} = 'pending'`)
    .returning({ id: runs.id });
  return updated.length > 0;
}

/**
 * CAS transition from `running` to a terminal status (`ok`, `error`, or `timeout`).
 * Computes `durationMs` from the row's `startedAt`. Error text is capped at 2 KB.
 * Returns `true` if the transition succeeded.
 */
export async function completeHeartbeatRun(
  runId: string,
  result: {
    status: "ok" | "error" | "timeout";
    conversationId?: string;
    error?: string;
  },
): Promise<boolean> {
  const db = requireMainDb();
  const runs = db.schema.heartbeatRuns;
  const now = Date.now();

  // Read the row to get startedAt for durationMs computation.
  const [row] = await db.orm
    .select({ startedAt: runs.startedAt })
    .from(runs)
    .where(eq(runs.id, runId));
  if (!row) {
    return false;
  }

  const durationMs = row.startedAt != null ? now - row.startedAt : null;

  const updated = await db.orm
    .update(runs)
    .set({
      status: result.status,
      finishedAt: now,
      durationMs,
      error: result.error?.slice(0, 2000) ?? null,
      conversationId: result.conversationId ?? null,
    })
    .where(sql`${runs.id} = ${runId} AND ${runs.status} = 'running'`)
    .returning({ id: runs.id });
  return updated.length > 0;
}

/**
 * CAS transition from `pending` to `skipped` with the given reason.
 * Returns `true` if the transition succeeded.
 */
export async function skipHeartbeatRun(
  runId: string,
  skipReason: HeartbeatSkipReason,
): Promise<boolean> {
  const db = requireMainDb();
  const runs = db.schema.heartbeatRuns;
  const updated = await db.orm
    .update(runs)
    .set({ status: "skipped", skipReason })
    .where(sql`${runs.id} = ${runId} AND ${runs.status} = 'pending'`)
    .returning({ id: runs.id });
  return updated.length > 0;
}

/**
 * CAS transition from `pending` to `superseded`.
 * Returns `true` if the transition succeeded.
 */
export async function supersedePendingRun(runId: string): Promise<boolean> {
  const db = requireMainDb();
  const runs = db.schema.heartbeatRuns;
  const updated = await db.orm
    .update(runs)
    .set({ status: "superseded" })
    .where(sql`${runs.id} = ${runId} AND ${runs.status} = 'pending'`)
    .returning({ id: runs.id });
  return updated.length > 0;
}

/**
 * Mark all `pending` rows older than the threshold as `missed`.
 * Handles the crash-before-run scenario. Returns the number of rows affected.
 */
export async function markStaleRunsAsMissed(
  thresholdMs: number = 5 * 60 * 1000,
): Promise<number> {
  const db = requireMainDb();
  const runs = db.schema.heartbeatRuns;
  const cutoff = Date.now() - thresholdMs;
  const updated = await db.orm
    .update(runs)
    .set({ status: "missed" })
    .where(sql`${runs.status} = 'pending' AND ${runs.scheduledFor} < ${cutoff}`)
    .returning({ id: runs.id });
  return updated.length;
}

/**
 * Mark all `running` rows older than the threshold as `error`.
 * Handles the crash-during-run scenario. Returns the number of rows affected.
 */
export async function markStaleRunningAsError(
  thresholdMs: number = STALE_RUNNING_THRESHOLD_MS,
): Promise<number> {
  const db = requireMainDb();
  const runs = db.schema.heartbeatRuns;
  const cutoff = Date.now() - thresholdMs;
  const updated = await db.orm
    .update(runs)
    .set({
      status: "error",
      error: "Process crashed or restarted during execution",
    })
    .where(sql`${runs.status} = 'running' AND ${runs.startedAt} < ${cutoff}`)
    .returning({ id: runs.id });
  return updated.length;
}

/**
 * Count the number of heartbeat runs that completed with status `ok`.
 */
export async function countCompletedHeartbeatRuns(): Promise<number> {
  const db = requireMainDb();
  const runs = db.schema.heartbeatRuns;
  const [row] = await db.orm
    .select({ count: sql<number>`count(*)` })
    .from(runs)
    .where(eq(runs.status, "ok"));
  return Number(row?.count ?? 0);
}

/**
 * Count heartbeat runs that completed with status `ok` today (local midnight).
 */
export async function countCompletedRunsToday(): Promise<number> {
  const db = requireMainDb();
  const runs = db.schema.heartbeatRuns;
  const now = new Date();
  const startOfDay = new Date(
    now.getFullYear(),
    now.getMonth(),
    now.getDate(),
  ).getTime();
  const [row] = await db.orm
    .select({ count: sql<number>`count(*)` })
    .from(runs)
    .where(
      sql`${runs.status} = 'ok' AND ${runs.scheduledFor} >= ${startOfDay}`,
    );
  return Number(row?.count ?? 0);
}

/**
 * Count the most recent consecutive heartbeat runs with status `ok`,
 * walking backwards from newest. Stops at the first non-`ok` status
 * (skipped, superseded, missed, error, timeout), which acts as a
 * natural boundary for the consecutive-run counter. In-flight rows
 * (`pending`, `running`) are skipped so they don't break the chain.
 *
 * Used to restore the in-memory consecutive-run counter on startup.
 */
export async function countRecentConsecutiveRuns(
  maxToCheck: number,
): Promise<number> {
  const db = requireMainDb();
  const runs = db.schema.heartbeatRuns;
  const rows = await db.orm
    .select({ status: runs.status })
    .from(runs)
    .orderBy(desc(runs.scheduledFor))
    .limit(maxToCheck + 5);

  let count = 0;
  for (const row of rows) {
    if (row.status === "ok") {
      count++;
    } else if (row.status === "pending" || row.status === "running") {
      continue;
    } else {
      break;
    }
  }
  return count;
}

/**
 * Statuses excluded from run history: scheduler bookkeeping rows, not runs.
 * `pending` is the not-yet-fired next scheduled run (surfaced separately as
 * "next run"), and `superseded` rows are pending rows replaced by a timer
 * reset, a guardian message resets the heartbeat timer, so an active chat
 * day leaves dozens of them behind without a single heartbeat firing.
 */
const BOOKKEEPING_STATUSES: HeartbeatRunStatus[] = ["pending", "superseded"];

/**
 * List heartbeat run history ordered by `scheduledFor` descending.
 * Bookkeeping rows ({@link BOOKKEEPING_STATUSES}) are excluded. Every
 * returned row is a run that executed, was skipped by a guard (with its
 * `skipReason`), or was missed while the daemon was down.
 * When `before` is set, only runs with `scheduledFor` strictly older than it
 * are returned (cursor for paginating into history).
 */
export async function listHeartbeatRuns(
  limit = 20,
  before?: number,
): Promise<HeartbeatRunRecord[]> {
  const db = requireMainDb();
  const runs = db.schema.heartbeatRuns;
  const historyOnly = notInArray(runs.status, BOOKKEEPING_STATUSES);
  const rows = await db.orm
    .select()
    .from(runs)
    .where(
      before != null
        ? and(lt(runs.scheduledFor, before), historyOnly)
        : historyOnly,
    )
    .orderBy(desc(runs.scheduledFor))
    .limit(limit);
  return rows.map(parseRow);
}

/** Terminal statuses of runs that actually executed. */
const EXECUTED_STATUSES: HeartbeatRunStatus[] = ["ok", "error", "timeout"];

/**
 * Epoch-ms timestamp of the most recent heartbeat run that actually executed
 * (reached `ok`, `error`, or `timeout`), or null when none exists. Uses
 * `finishedAt`, falling back to `startedAt` for rows finalized by a crash
 * sweep without one.
 */
export async function getLastHeartbeatRunAt(): Promise<number | null> {
  const db = requireMainDb();
  const runs = db.schema.heartbeatRuns;
  const [row] = await db.orm
    .select({
      lastRunAt: sql<
        number | null
      >`max(coalesce(${runs.finishedAt}, ${runs.startedAt}))`,
    })
    .from(runs)
    .where(inArray(runs.status, EXECUTED_STATUSES));
  return row?.lastRunAt != null ? Number(row.lastRunAt) : null;
}

/**
 * Heartbeat runs currently `running`, capped to those started within
 * `maxAgeMs`. The age bound matters: a run orphaned by a crash keeps its
 * `running` status until a later boot's stale sweep relabels it, and an
 * unbounded read would let that phantom row hold a drain open indefinitely.
 */
export async function listRunningHeartbeatRuns(
  maxAgeMs: number,
): Promise<Array<{ runId: string; startedAt: number }>> {
  const db = requireMainDb();
  const runs = db.schema.heartbeatRuns;
  const cutoff = Date.now() - maxAgeMs;
  return (await db.orm
    .select({ runId: runs.id, startedAt: runs.startedAt })
    .from(runs)
    .where(
      and(
        eq(runs.status, "running"),
        isNotNull(runs.startedAt),
        gt(runs.startedAt, cutoff),
      ),
    )
    .orderBy(desc(runs.startedAt))
    .limit(20)) as Array<{ runId: string; startedAt: number }>;
}

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

function parseRow(row: HeartbeatRunRow): HeartbeatRunRecord {
  return {
    id: row.id,
    scheduledFor: row.scheduledFor,
    startedAt: row.startedAt,
    finishedAt: row.finishedAt,
    durationMs: row.durationMs,
    status: row.status as HeartbeatRunStatus,
    skipReason: row.skipReason,
    error: row.error,
    conversationId: row.conversationId,
    createdAt: row.createdAt,
  };
}
