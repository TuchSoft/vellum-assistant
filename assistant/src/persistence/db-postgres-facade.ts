/**
 * Postgres backend for the {@link AsyncDb} facade.
 *
 * Selected per slot by env (see `resolveBackend` in `db-facade.ts`):
 * `VELLUM_DB_BACKEND=postgres` + `VELLUM_DATABASE_URL` for every slot, or the
 * per-slot pair `VELLUM_<SLOT>_DB_BACKEND` / `VELLUM_<SLOT>_DATABASE_URL`.
 * Placeholders are positional `?` at the call site and rewritten to `$n` here.
 *
 * `postgres.js` returns `int8` as a string by default (to avoid precision loss);
 * the port keeps epoch-ms columns as `bigint` with no application-code change,
 * so the pool registers an `int8` parser that yields a JS number. Epoch-ms
 * values sit well under 2^53, so the conversion is lossless.
 *
 * ORM note: `AsyncDb.orm` is not exposed on this backend yet. The Drizzle
 * instance is dialect-specific and the Postgres `pgTable` schema lands with the
 * baseline work; until then the Postgres path uses the raw helpers, which the
 * facade translates.
 */

import { drizzle } from "drizzle-orm/postgres-js";
import type { Sql } from "postgres";
import postgres from "postgres";

import type { DrizzleDb } from "./db-connection.js";
import type {
  AsyncDb,
  AsyncDbSlot,
  SchemaTables,
  SqlParam,
} from "./db-facade.js";
import * as pgSchema from "./pg-schema/index.js";

type PgSql = Sql<Record<string, never>>;

const pools = new Map<string, PgSql>();
const orms = new Map<string, DrizzleDb>();
const baselines = new Map<string, Promise<void>>();

/** One pooled connection set per URL, shared by every facade on that URL. */
function pool(url: string): PgSql {
  let existing = pools.get(url);
  if (!existing) {
    existing = postgres(url, {
      max: 5,
      onnotice: () => {},
      types: {
        bigint: {
          to: 20,
          from: [20],
          serialize: (value: number) => String(value),
          parse: (value: string) => Number(value),
        },
      },
    }) as unknown as PgSql;
    pools.set(url, existing);
  }
  return existing;
}

/**
 * Apply the slot's baseline statements once per URL. The statements are
 * idempotent (`CREATE TABLE IF NOT EXISTS`), so a re-run is harmless; the
 * cached promise keeps concurrent opens from duplicating the work.
 */
async function applyBaseline(sql: PgSql, statements: string[]): Promise<void> {
  for (const statement of statements) {
    await sql.unsafe(statement);
  }
}

/** Rewrite positional `?` placeholders to Postgres `$n`. */
function toPgPlaceholders(sqlText: string): string {
  let index = 0;
  return sqlText.replace(/\?/g, () => `$${++index}`);
}

/**
 * The Drizzle query root for a URL, cached per URL.
 *
 * Built from the `postgres.js` pool over the Postgres mirror (`pg-schema`) and
 * cast to the SQLite `DrizzleDb` type on purpose: the facade exposes one
 * `orm`/`schema` pair so a dialect-agnostic query path typechecks (see the
 * `AsyncDb.orm` doc). The runtime object is genuinely a Postgres Drizzle
 * instance, and `schema` hands it the matching `pg-schema` tables.
 */
function ormFor(url: string): DrizzleDb {
  let existing = orms.get(url);
  if (!existing) {
    existing = drizzle(pool(url), { schema: pgSchema }) as unknown as DrizzleDb;
    orms.set(url, existing);
  }
  return existing;
}

class PostgresAsyncDb implements AsyncDb {
  readonly dialect = "postgres" as const;
  readonly schema = pgSchema as unknown as SchemaTables;

  constructor(
    readonly slot: AsyncDbSlot,
    private readonly sql: PgSql,
    private readonly url: string,
    private readonly baseline: Promise<void> | null,
  ) {}

  get orm(): DrizzleDb {
    return ormFor(this.url);
  }

  private async ready(): Promise<void> {
    if (this.baseline) {
      await this.baseline;
    }
  }

  async all<T = unknown>(
    sqlText: string,
    params: readonly SqlParam[] = [],
  ): Promise<T[]> {
    await this.ready();
    const rows = await this.sql.unsafe(
      toPgPlaceholders(sqlText),
      params as never[],
    );
    return rows as unknown as T[];
  }

  async get<T = unknown>(
    sqlText: string,
    params: readonly SqlParam[] = [],
  ): Promise<T | null> {
    const rows = await this.all<T>(sqlText, params);
    return rows[0] ?? null;
  }

  async run(
    sqlText: string,
    params: readonly SqlParam[] = [],
  ): Promise<number> {
    await this.ready();
    const result = await this.sql.unsafe(
      toPgPlaceholders(sqlText),
      params as never[],
    );
    return result.count;
  }

  async exec(sqlText: string): Promise<void> {
    await this.ready();
    await this.sql.unsafe(sqlText);
  }

  async transaction<T>(cb: (tx: AsyncDb) => Promise<T>): Promise<T> {
    await this.ready();
    const result = await this.sql.begin((tx) =>
      cb(
        new PostgresAsyncDb(this.slot, tx as unknown as PgSql, this.url, null),
      ),
    );
    return result as T;
  }

  label(): AsyncDb {
    // Attribution is a SQLite slow-query-log concern; the Postgres path has no
    // equivalent chokepoint yet, so the label is accepted and ignored.
    return this;
  }
}

/**
 * The Postgres facade for one slot. `baseline` statements are applied once per
 * URL before the first statement runs; a slot with its schema managed
 * elsewhere passes none.
 */
export function getPostgresAsyncDb(
  slot: AsyncDbSlot,
  url: string,
  baseline: readonly string[] = [],
): AsyncDb {
  const sql = pool(url);
  let applied: Promise<void> | null = null;
  if (baseline.length > 0) {
    let existing = baselines.get(url);
    if (!existing) {
      existing = applyBaseline(sql, [...baseline]);
      baselines.set(url, existing);
    }
    applied = existing;
  }
  return new PostgresAsyncDb(slot, sql, url, applied);
}

/** Test/shutdown hook: close every pooled connection. */
export async function closePostgresFacades(): Promise<void> {
  const open = [...pools.values()];
  pools.clear();
  orms.clear();
  baselines.clear();
  await Promise.all(open.map((sql) => sql.end({ timeout: 5 })));
}
