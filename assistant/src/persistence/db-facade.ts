/**
 * Async DB facade - the single seam between the assistant's data layer and the
 * Postgres driver.
 *
 * Every accessor returns an {@link AsyncDb} whose methods are `Promise`-based,
 * so callers are written once for an async backend. The facade has exactly one
 * backend: Postgres. A slot resolves its connection from `VELLUM_DATABASE_URL`;
 * `main`, `memory`, and `telemetry` all point at the same database (the
 * historical per-service SQLite files collapse into one Postgres database).
 *
 * Query building: {@link AsyncDb.orm} exposes the Drizzle instance over
 * `pg-schema`. The raw helpers ({@link AsyncDb.all}/{@link AsyncDb.get}/
 * {@link AsyncDb.run}) take positional `?` placeholders, which the backend
 * rewrites to `$n`. See `assistant/docs/pg-port-translation.md` for the SQLite
 * to Postgres construct map still applied by the legacy code.
 *
 * Schema ownership: the facade does not create tables. The migration runner
 * (`pg-migrations/`) owns the schema; tests bootstrap it through
 * `src/__tests__/pg-test-db.ts`.
 */

import type { PgDrizzleDb, PgSchemaTables } from "./db-postgres-facade.js";
import { getPostgresAsyncDb } from "./db-postgres-facade.js";

/** A value bindable as a positional query parameter. */
export type SqlParam =
  | string
  | number
  | bigint
  | boolean
  | null
  | ArrayBufferView
  | Record<string, string | number | bigint | boolean | null | ArrayBufferView>;

/**
 * The logical connections served by the facade. `main`, `memory`, and
 * `telemetry` all resolve to the same Postgres database; the slot only names
 * the caller's domain. The `logs` slot is not served here: log storage is
 * ClickHouse.
 */
export type AsyncDbSlot = "main" | "memory" | "telemetry";

/** The Postgres table barrel's shape. */
export type SchemaTables = PgSchemaTables;

/**
 * A connection whose operations all return Promises. Methods mirror the raw
 * helpers in `raw-query.ts` so a call site migrates by swapping the helper for
 * the method and adding `await`.
 */
export interface AsyncDb {
  readonly slot: AsyncDbSlot;

  /**
   * The Drizzle query root. Terminal calls must be awaited.
   *
   * Built over `pg-schema`, the same barrel {@link schema} exposes, so
   * `await db.orm.select().from(db.schema.scheduleJobs)` typechecks and runs.
   * Use `await` on the builder, never the legacy `.get()/.all()/.run()`
   * terminals. See `pg-port-translation.md`.
   */
  readonly orm: PgDrizzleDb;

  /**
   * The table barrel matching {@link orm}'s dialect: `pg-schema/`. The barrel
   * exports the table/column names the raw SQL call sites use, which is what
   * makes one query path work.
   */
  readonly schema: SchemaTables;

  /** Run a query and return every row. */
  all<T = unknown>(sql: string, params?: readonly SqlParam[]): Promise<T[]>;

  /** Run a query and return the first row, or `null`. */
  get<T = unknown>(
    sql: string,
    params?: readonly SqlParam[],
  ): Promise<T | null>;

  /** Run a statement and return the number of affected rows. */
  run(sql: string, params?: readonly SqlParam[]): Promise<number>;

  /** Run one or more statements with no bindings (DDL, batch). */
  exec(sql: string): Promise<void>;

  /**
   * Run `cb` inside a transaction, committing on resolve and rolling back on
   * throw. The callback receives a transaction-scoped {@link AsyncDb}; use it
   * for every statement inside the callback so the operations share the
   * connection and the open transaction.
   */
  transaction<T>(cb: (tx: AsyncDb) => Promise<T>): Promise<T>;

  /**
   * Return a facade whose statements are attributed to `label` in slow-query
   * logs. The Postgres path has no label chokepoint yet, so this is a no-op
   * that keeps the call sites' shape stable.
   */
  label(label: string): AsyncDb;
}

/** The single connection URL for every slot. */
function connectionUrl(): string | undefined {
  const url = process.env.VELLUM_DATABASE_URL?.trim();
  return url === "" ? undefined : url;
}

const warnedSlots = new Set<AsyncDbSlot>();

/**
 * Resolve the Postgres facade for `slot`, or `null` when no URL is configured.
 * Fail-soft on purpose: a blanked env in a degraded-mode test yields `null`
 * rather than throwing, so callers keep their existing `if (!db) return
 * <degraded>` branches.
 */
function facadeFor(slot: AsyncDbSlot): AsyncDb | null {
  const url = connectionUrl();
  if (!url) {
    if (!warnedSlots.has(slot)) {
      warnedSlots.add(slot);
      void import("../util/logger.js").then(({ getLogger }) =>
        getLogger("db-facade").warn(
          { slot },
          "Postgres connection URL is not configured; the slot is unavailable",
        ),
      );
    }
    return null;
  }
  return getPostgresAsyncDb(slot, url);
}

/** The async facade for the main database, or `null` when it is unavailable. */
export function getAsyncDb(): AsyncDb | null {
  return facadeFor("main");
}

/**
 * The main-slot facade, or a throw when it is unavailable. A slice whose every
 * operation needs the main connection calls this instead of repeating the null
 * check; throwing matches the synchronous `getDb()` it supersedes (which threw
 * on open failure) so a mutation never silently degrades to a no-op.
 */
export function requireMainDb(): AsyncDb {
  const db = getAsyncDb();
  if (!db) {
    throw new Error("main database unavailable");
  }
  return db;
}

/** Async facade for the memory domain (same Postgres database). */
export function getMemoryAsyncDb(): AsyncDb | null {
  return facadeFor("memory");
}

/** Async facade for the telemetry domain (same Postgres database). */
export function getTelemetryAsyncDb(): AsyncDb | null {
  return facadeFor("telemetry");
}
