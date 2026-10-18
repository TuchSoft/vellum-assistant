/**
 * Postgres backend for the {@link AsyncDb} facade.
 *
 * The only backend: a slot resolves its connection from `VELLUM_DATABASE_URL`
 * (see `db-facade.ts`). Placeholders are positional `?` at the call site and
 * rewritten to `$n` here.
 *
 * `postgres.js` returns `int8` as a string by default (to avoid precision loss);
 * the port keeps epoch-ms columns as `bigint` with no application-code change,
 * so the pool registers an `int8` parser that yields a JS number. Epoch-ms
 * values sit well under 2^53, so the conversion is lossless.
 *
 * Schema ownership: the facade never creates tables. `baseline` is an optional
 * idempotent DDL set applied once per URL before the first statement; the test
 * bootstrap passes the generated baseline, production leaves it to the
 * migration runner.
 */

import { drizzle } from "drizzle-orm/postgres-js";
import type { Sql } from "postgres";
import postgres from "postgres";

import type { AsyncDb, AsyncDbSlot, SqlParam } from "./db-facade.js";
import * as pgSchema from "./pg-schema/index.js";

type PgSql = Sql<Record<string, never>>;

/** The Postgres table barrel's shape, re-exported for the facade's types. */
export type PgSchemaTables = typeof pgSchema;

/** The Drizzle query root type over the Postgres schema. */
export type PgDrizzleDb = ReturnType<typeof drizzle<typeof pgSchema>>;

const pools = new Map<string, PgSql>();
const orms = new Map<string, PgDrizzleDb>();
const baselines = new Map<string, Promise<void>>();
const facades = new Map<string, AsyncDb>();

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
  await sql.unsafe(statements.join(";\n"));
}

/** Rewrite positional `?` placeholders to Postgres `$n`. */
function toPgPlaceholders(sqlText: string): string {
  let index = 0;
  return sqlText.replace(/\?/g, () => `$${++index}`);
}

/**
 * The Drizzle query root for a URL, cached per URL.
 *
 * Built from the `postgres.js` pool over the Postgres mirror (`pg-schema`);
 * {@link AsyncDb.schema} hands callers the matching table barrel.
 */
function ormFor(url: string): PgDrizzleDb {
  let existing = orms.get(url);
  if (!existing) {
    existing = drizzle(pool(url), { schema: pgSchema });
    orms.set(url, existing);
  }
  return existing;
}

class PostgresAsyncDb implements AsyncDb {
  readonly schema = pgSchema;

  constructor(
    readonly slot: AsyncDbSlot,
    private readonly sql: PgSql,
    private readonly url: string,
    private readonly baseline: Promise<void> | null,
    private readonly ormOverride: PgDrizzleDb | null = null,
  ) {}

  get orm(): PgDrizzleDb {
    return this.ormOverride ?? ormFor(this.url);
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
    const result = await this.sql.begin((tx) => {
      // postgres.js transaction handles expose the same query methods as the
      // client but omit `options`, which Drizzle's driver reads while building
      // its session. Delegate to the transaction handle and borrow the base
      // client's options so Drizzle and the raw helpers share one connection.
      const baseOptions = (this.sql as unknown as { options: unknown }).options;
      const txSql = Object.assign(Object.create(tx) as object, {
        options: baseOptions,
      }) as PgSql;
      const txOrm = drizzle(txSql, { schema: pgSchema }) as PgDrizzleDb;
      return cb(new PostgresAsyncDb(this.slot, txSql, this.url, null, txOrm));
    });
    return result as T;
  }

  label(): AsyncDb {
    // Attribution exists for the legacy synchronous connection's slow-query
    // log; the Postgres path has no equivalent chokepoint yet, so the label is
    // accepted and ignored.
    return this;
  }
}

/**
 * The Postgres facade for one slot. `baseline` statements are applied once per
 * URL before the first statement runs; pass the generated baseline to
 * bootstrap an empty database.
 */
export function getPostgresAsyncDb(
  slot: AsyncDbSlot,
  url: string,
  baseline: readonly string[] = [],
): AsyncDb {
  const key = `${slot}:${url}:${baseline.length > 0 ? "baseline" : "plain"}`;
  const cached = facades.get(key);
  if (cached) {
    return cached;
  }
  const sql = pool(url);
  let applied: Promise<void> | null = null;
  if (baseline.length > 0) {
    let existing = baselines.get(url);
    if (!existing) {
      const run = applyBaseline(sql, [...baseline]);
      baselines.set(url, run);
      // A rejected apply must not poison the URL for the process lifetime: a
      // transient startup failure should retry on the next open.
      void run.catch(() => {
        if (baselines.get(url) === run) {
          baselines.delete(url);
        }
      });
      existing = run;
    }
    applied = existing;
  }
  const created = new PostgresAsyncDb(slot, sql, url, applied);
  facades.set(key, created);
  return created;
}

/** Test/shutdown hook: close every pooled connection. */
export async function closePostgresFacades(): Promise<void> {
  const open = [...pools.values()];
  pools.clear();
  orms.clear();
  baselines.clear();
  facades.clear();
  await Promise.all(open.map((sql) => sql.end({ timeout: 5 })));
}
