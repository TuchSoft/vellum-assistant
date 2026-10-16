/**
 * Type-safe wrappers for raw SQL queries against bun:sqlite.
 *
 * ## When to use raw SQL vs Drizzle ORM
 *
 * **Default to Drizzle** for all standard CRUD operations. Use raw SQL only when
 * Drizzle cannot express the query or when a raw API is required:
 *
 * - **FTS5 operations**: MATCH operator, bm25() ranking, virtual table
 *   INSERT/DELETE. Drizzle has no FTS5 support.
 *
 * - **Schema migrations**: DDL statements (CREATE TABLE, ALTER TABLE, DROP TABLE),
 *   PRAGMA control, and transaction-wrapped table rebuilds. These are structural
 *   operations outside Drizzle's query-building scope.
 *
 * - **Affected-row checks after Drizzle .run()**: Drizzle's bun:sqlite adapter
 *   returns void from .run(), so checking changes() requires the raw client.
 *   Use `rawChanges()` for this.
 *
 * - **INSERT OR IGNORE / ON CONFLICT**: SQLite-specific upsert syntax that
 *   Drizzle's bun:sqlite adapter doesn't fully support.
 *
 * - **Atomic in-place updates**: Expressions like `SET count = count + 1` can
 *   use Drizzle's `sql` template, but raw SQL is acceptable when simpler.
 *
 * For everything else — selects, inserts, updates, deletes, joins, aggregations,
 * filtering, ordering, pagination — use Drizzle.
 */

import type { Database, SQLQueryBindings } from "bun:sqlite";

import {
  getLogsSqlite,
  getMemorySqlite,
  getSqlite,
  getTelemetrySqlite,
} from "./db-connection.js";
import {
  type AsyncDb,
  type AsyncDbSlot,
  getAsyncDb,
  getLogsAsyncDb,
  getMemoryAsyncDb,
  getTelemetryAsyncDb,
} from "./db-facade.js";

type SqlParam = SQLQueryBindings;

// ---------------------------------------------------------------------------
// Typed query helpers (global Drizzle instance)
// ---------------------------------------------------------------------------
//
// Every connection returned by the db-connection accessor is wrapped by
// `wrapSqliteForSlowQueryLogging`, which times each `.get()/.all()/.run()`
// execution and logs the slow ones. Each helper takes a required `label` first
// argument — a short `domain:operation` attribution tag (e.g.
// `"schedule:claimDue"`) — routed through `.label()` so a slow raw query names
// its call site in the log, not just its SQL. The wrapper caches the timed proxy
// per (statement, label), so repeated calls stay allocation-light.

/** Execute a raw SQL query and return a single typed row, or null if no match. */
export function rawGet<T>(
  label: string,
  sql: string,
  ...params: SqlParam[]
): T | null {
  return (
    (getSqlite()
      .label(label)
      .query(sql)
      .get(...params) as T) ?? null
  );
}

/** Execute a raw SQL query and return all matching rows with type safety. */
export function rawAll<T>(
  label: string,
  sql: string,
  ...params: SqlParam[]
): T[] {
  return getSqlite()
    .label(label)
    .query(sql)
    .all(...params) as T[];
}

/**
 * Execute a raw SQL statement (INSERT/UPDATE/DELETE) and return the number
 * of affected rows.
 */
export function rawRun(
  label: string,
  sql: string,
  ...params: SqlParam[]
): number {
  getSqlite()
    .label(label)
    .query(sql)
    .run(...params);
  return rawChanges();
}

/** Execute batch SQL (multiple statements, no bindings). */
export function rawExec(sql: string): void {
  getSqlite().exec(sql);
}

/**
 * Return the number of rows affected by the most recent INSERT/UPDATE/DELETE.
 *
 * Useful after a Drizzle `.run()` call, since Drizzle's bun:sqlite adapter
 * returns void and discards the changes count.
 */
export function rawChanges(): number {
  return (getSqlite().query("SELECT changes() AS c").get() as { c: number }).c;
}

// ---------------------------------------------------------------------------
// Typed query helpers for the dedicated memory connection (assistant-memory.db)
// ---------------------------------------------------------------------------

/** The memory connection, or a thrown error when it cannot be opened. */
function memorySqlite(): Database {
  const sqlite = getMemorySqlite();
  if (!sqlite) {
    throw new Error("memory database unavailable");
  }
  return sqlite;
}

/** The logs connection, or a thrown error when it cannot be opened. */
function logsSqlite(): Database {
  const sqlite = getLogsSqlite();
  if (!sqlite) {
    throw new Error("logs database unavailable");
  }
  return sqlite;
}

/** The telemetry connection, or a thrown error when it cannot be opened. */
function telemetrySqlite(): Database {
  const sqlite = getTelemetrySqlite();
  if (!sqlite) {
    throw new Error("telemetry database unavailable");
  }
  return sqlite;
}

/** {@link rawGet} against the memory connection. */
export function rawMemoryGet<T>(
  label: string,
  sql: string,
  ...params: SqlParam[]
): T | null {
  return (
    (memorySqlite()
      .label(label)
      .query(sql)
      .get(...params) as T) ?? null
  );
}

/** {@link rawAll} against the memory connection. */
export function rawMemoryAll<T>(
  label: string,
  sql: string,
  ...params: SqlParam[]
): T[] {
  return memorySqlite()
    .label(label)
    .query(sql)
    .all(...params) as T[];
}

/** {@link rawRun} against the memory connection. */
export function rawMemoryRun(
  label: string,
  sql: string,
  ...params: SqlParam[]
): number {
  const sqlite = memorySqlite();
  sqlite
    .label(label)
    .query(sql)
    .run(...params);
  return (sqlite.query("SELECT changes() AS c").get() as { c: number }).c;
}

/** {@link rawChanges} against the memory connection. */
export function rawMemoryChanges(): number {
  return (memorySqlite().query("SELECT changes() AS c").get() as { c: number })
    .c;
}

/** {@link rawRun} against the logs connection. */
export function rawLogsRun(
  label: string,
  sql: string,
  ...params: SqlParam[]
): number {
  const sqlite = logsSqlite();
  sqlite
    .label(label)
    .query(sql)
    .run(...params);
  return (sqlite.query("SELECT changes() AS c").get() as { c: number }).c;
}

/** {@link rawRun} against the telemetry connection. */
export function rawTelemetryRun(
  label: string,
  sql: string,
  ...params: SqlParam[]
): number {
  const sqlite = telemetrySqlite();
  sqlite
    .label(label)
    .query(sql)
    .run(...params);
  return (sqlite.query("SELECT changes() AS c").get() as { c: number }).c;
}

/**
 * Delete all rows from the given tables in a single transaction.
 *
 * Without an explicit transaction, each DELETE is auto-committed with its own
 * fsync. Batching them saves ~10-20ms per DELETE statement — significant in
 * test files that clear 10-15 tables in every `beforeEach`.
 */
export function resetTestTables(...tables: string[]): void {
  const sqlite = getSqlite();
  const deletes = tables.map((t) => `DELETE FROM "${t}"`).join(";\n");
  sqlite.exec("BEGIN");
  try {
    sqlite.exec(deletes);
    sqlite.exec("COMMIT");
  } catch (e) {
    sqlite.exec("ROLLBACK");
    throw e;
  }
}

// ---------------------------------------------------------------------------
// Async counterparts
// ---------------------------------------------------------------------------
//
// The helpers above are synchronous because they wrap `bun:sqlite`. The async
// helpers below are the migration target: same semantics, same label-first
// signature, but returning Promises and routing through the driver-agnostic
// `AsyncDb` facade. New code should prefer these; the synchronous helpers stay
// until their call sites are colored (see `db-facade.ts`).

/** {@link rawGet} on the async facade. */
export async function rawGetAsync<T>(
  label: string,
  sql: string,
  ...params: SqlParam[]
): Promise<T | null> {
  return requireFacade(getAsyncDb(), "main").label(label).get<T>(sql, params);
}

/** {@link rawAll} on the async facade. */
export async function rawAllAsync<T>(
  label: string,
  sql: string,
  ...params: SqlParam[]
): Promise<T[]> {
  return requireFacade(getAsyncDb(), "main").label(label).all<T>(sql, params);
}

/** {@link rawRun} on the async facade. */
export async function rawRunAsync(
  label: string,
  sql: string,
  ...params: SqlParam[]
): Promise<number> {
  return requireFacade(getAsyncDb(), "main").label(label).run(sql, params);
}

/** {@link rawExec} on the async facade. */
export async function rawExecAsync(sql: string): Promise<void> {
  return requireFacade(getAsyncDb(), "main").exec(sql);
}

/** {@link rawMemoryGet} on the async facade. */
export async function rawMemoryGetAsync<T>(
  label: string,
  sql: string,
  ...params: SqlParam[]
): Promise<T | null> {
  return requireFacade(getMemoryAsyncDb(), "memory")
    .label(label)
    .get<T>(sql, params);
}

/** {@link rawMemoryAll} on the async facade. */
export async function rawMemoryAllAsync<T>(
  label: string,
  sql: string,
  ...params: SqlParam[]
): Promise<T[]> {
  return requireFacade(getMemoryAsyncDb(), "memory")
    .label(label)
    .all<T>(sql, params);
}

/** {@link rawMemoryRun} on the async facade. */
export async function rawMemoryRunAsync(
  label: string,
  sql: string,
  ...params: SqlParam[]
): Promise<number> {
  return requireFacade(getMemoryAsyncDb(), "memory")
    .label(label)
    .run(sql, params);
}

/** {@link rawLogsRun} on the async facade. */
export async function rawLogsRunAsync(
  label: string,
  sql: string,
  ...params: SqlParam[]
): Promise<number> {
  return requireFacade(getLogsAsyncDb(), "logs").label(label).run(sql, params);
}

/** {@link rawTelemetryRun} on the async facade. */
export async function rawTelemetryRunAsync(
  label: string,
  sql: string,
  ...params: SqlParam[]
): Promise<number> {
  return requireFacade(getTelemetryAsyncDb(), "telemetry")
    .label(label)
    .run(sql, params);
}

/** Unwrap a facade accessor, throwing the dedicated-database error when null. */
function requireFacade(facade: AsyncDb | null, name: AsyncDbSlot): AsyncDb {
  if (!facade) {
    throw new Error(`${name} database unavailable`);
  }
  return facade;
}
