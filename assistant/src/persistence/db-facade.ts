/**
 * Async DB facade — the single seam between the assistant's data layer and the
 * underlying driver.
 *
 * Every accessor returns an {@link AsyncDb} whose methods are `Promise`-based,
 * so callers are written once for an async backend and never have to change
 * when the backend does. The current implementation wraps `bun:sqlite` (a
 * synchronous driver) and resolves its Promises immediately; a Postgres
 * implementation slots in behind the same interface, selected per slot.
 *
 * Why this exists: `bun:sqlite` is synchronous, so today every DB-touching
 * function is synchronous and the call graph is colored `sync` transitively.
 * An async driver cannot be dropped in without coloring the whole graph. The
 * facade decouples the two changes: callers first migrate to the async API
 * without any behavior change (still SQLite underneath), then a slot is flipped
 * to Postgres without touching a single caller.
 *
 * Query building: {@link AsyncDb.orm} exposes the Drizzle instance. Drizzle's
 * query builders are thenable on both the SQLite and Postgres drivers, so
 * `await db.orm.select()...` is portable. The raw helpers
 * ({@link AsyncDb.all}/{@link AsyncDb.get}/{@link AsyncDb.run}) take positional
 * `?` placeholders; a Postgres backend rewrites them to `$n`. See
 * `assistant/docs/pg-port-translation.md` for the SQLite to Postgres construct
 * map.
 */

import type { Database } from "bun:sqlite";

import type { DrizzleDb } from "./db-connection.js";
// Namespace import (not named bindings) so tests can `spyOn` a connection
// accessor and have the facade observe the replacement at call time.
import * as dbConnection from "./db-connection.js";
import { getPostgresAsyncDb } from "./db-postgres-facade.js";
import { TELEMETRY_PG_BASELINE } from "./pg-baseline/telemetry.js";

/** Which driver backs an {@link AsyncDb}. */
export type DbDialect = "sqlite" | "postgres";

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
 * The four logical connections, mirroring the slots in `db-singleton.ts`.
 * `main-readonly` resolves to the same facade shape as `main` when requested
 * through {@link getAsyncDb} but is not exposed as its own accessor here.
 */
export type AsyncDbSlot = "main" | "logs" | "memory" | "telemetry";

/**
 * A connection whose operations all return Promises, regardless of the driver
 * underneath. Methods mirror the raw helpers in `raw-query.ts` so a call site
 * migrates by swapping the helper for the method and adding `await`.
 */
export interface AsyncDb {
  readonly dialect: DbDialect;
  readonly slot: AsyncDbSlot;

  /** The Drizzle query root, when the backend exposes one. Terminal calls
   * must be awaited. Absent on the Postgres backend until the `pgTable`
   * schema lands (see the module doc in `db-postgres-facade.ts`). */
  readonly orm?: DrizzleDb;

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
   * logs. Mirrors `bun:sqlite`'s `.label()` chokepoint (see `slow-query-log.ts`).
   */
  label(label: string): AsyncDb;
}

/**
 * The SQLite implementation. Every method delegates to the wrapped
 * `bun:sqlite` `Database` and resolves immediately, so runtime behavior is
 * identical to the synchronous helpers it replaces; only the calling
 * convention changes (async).
 */
class SqliteAsyncDb implements AsyncDb {
  readonly dialect = "sqlite" as const;

  constructor(
    readonly slot: AsyncDbSlot,
    private readonly raw: Database,
    private readonly resolveOrm: () => DrizzleDb,
    private readonly tag: string | undefined = undefined,
  ) {}

  get orm(): DrizzleDb {
    return this.resolveOrm();
  }

  private stmt(sql: string) {
    return this.tag === undefined
      ? this.raw.query(sql)
      : this.raw.label(this.tag).query(sql);
  }

  async all<T = unknown>(
    sql: string,
    params: readonly SqlParam[] = [],
  ): Promise<T[]> {
    return this.stmt(sql).all(...(params as never[])) as T[];
  }

  async get<T = unknown>(
    sql: string,
    params: readonly SqlParam[] = [],
  ): Promise<T | null> {
    return (this.stmt(sql).get(...(params as never[])) as T) ?? null;
  }

  async run(sql: string, params: readonly SqlParam[] = []): Promise<number> {
    return this.stmt(sql).run(...(params as never[])).changes;
  }

  async exec(sql: string): Promise<void> {
    this.raw.exec(sql);
  }

  async transaction<T>(cb: (tx: AsyncDb) => Promise<T>): Promise<T> {
    this.raw.exec("BEGIN");
    try {
      const result = await cb(this);
      this.raw.exec("COMMIT");
      return result;
    } catch (err) {
      this.raw.exec("ROLLBACK");
      throw err;
    }
  }

  label(label: string): AsyncDb {
    return new SqliteAsyncDb(this.slot, this.raw, this.resolveOrm, label);
  }
}

/** Wrap a raw SQLite connection, or `null` when it is unavailable. */
function sqliteFacade(
  slot: AsyncDbSlot,
  raw: Database | null,
  resolveOrm: () => DrizzleDb,
): AsyncDb | null {
  return raw === null ? null : new SqliteAsyncDb(slot, raw, resolveOrm);
}

/**
 * Per-slot backend selection from env. A slot-specific pair
 * (`VELLUM_<SLOT>_DB_BACKEND` / `VELLUM_<SLOT>_DATABASE_URL`) overrides the
 * generic pair (`VELLUM_DB_BACKEND` / `VELLUM_DATABASE_URL`); the default is
 * SQLite, so an unconfigured process behaves exactly as before.
 */
interface BackendResolution {
  dialect: DbDialect;
  url: string | undefined;
}

function resolveBackend(slot: AsyncDbSlot): BackendResolution {
  const upper = slot.toUpperCase();
  const backend =
    process.env[`VELLUM_${upper}_DB_BACKEND`] ?? process.env.VELLUM_DB_BACKEND;
  return {
    dialect: backend === "postgres" ? "postgres" : "sqlite",
    url:
      process.env[`VELLUM_${upper}_DATABASE_URL`] ??
      process.env.VELLUM_DATABASE_URL,
  };
}

/**
 * Resolve a Postgres facade for `slot`. Fail-soft like the dedicated SQLite
 * accessors: a missing connection URL (e.g. a blanked env in a degraded-mode
 * test) yields `null` rather than throwing, so callers keep their existing
 * `if (!db) return <degraded>` branches on both backends.
 */
function postgresFacade(
  slot: AsyncDbSlot,
  resolution: BackendResolution,
  baseline: readonly string[] = [],
): AsyncDb | null {
  if (!resolution.url) {
    void import("../util/logger.js").then(({ getLogger }) =>
      getLogger("db-facade").warn(
        { slot },
        "Postgres backend selected without a connection URL; the slot is unavailable",
      ),
    );
    return null;
  }
  return getPostgresAsyncDb(slot, resolution.url, baseline);
}

/**
 * The async facade for the main database. Unlike {@link getSqlite} (which
 * throws on open failure), this mirrors the dedicated accessors' fail-soft
 * posture and returns `null` when the connection cannot be opened, so callers
 * keep their existing degraded-mode branches.
 */
export function getAsyncDb(): AsyncDb | null {
  const resolution = resolveBackend("main");
  if (resolution.dialect === "postgres") {
    return postgresFacade("main", resolution);
  }
  try {
    return sqliteFacade("main", dbConnection.getSqlite(), dbConnection.getDb);
  } catch {
    return null;
  }
}

/** Async facade for the dedicated logs database (`assistant-logs.db`). */
export function getLogsAsyncDb(): AsyncDb | null {
  const resolution = resolveBackend("logs");
  if (resolution.dialect === "postgres") {
    return postgresFacade("logs", resolution);
  }
  return sqliteFacade("logs", dbConnection.getLogsSqlite(), () => {
    const db = dbConnection.getLogsDb();
    if (!db) {
      throw new Error("logs database unavailable");
    }
    return db;
  });
}

/** Async facade for the dedicated memory database (`assistant-memory.db`). */
export function getMemoryAsyncDb(): AsyncDb | null {
  const resolution = resolveBackend("memory");
  if (resolution.dialect === "postgres") {
    return postgresFacade("memory", resolution);
  }
  return sqliteFacade("memory", dbConnection.getMemorySqlite(), () => {
    const db = dbConnection.getMemoryDb();
    if (!db) {
      throw new Error("memory database unavailable");
    }
    return db;
  });
}

/** Async facade for the dedicated telemetry database (`assistant-telemetry.db`). */
export function getTelemetryAsyncDb(): AsyncDb | null {
  const resolution = resolveBackend("telemetry");
  if (resolution.dialect === "postgres") {
    return postgresFacade("telemetry", resolution, TELEMETRY_PG_BASELINE);
  }
  return sqliteFacade("telemetry", dbConnection.getTelemetrySqlite(), () => {
    const db = dbConnection.getTelemetryDb();
    if (!db) {
      throw new Error("telemetry database unavailable");
    }
    return db;
  });
}
