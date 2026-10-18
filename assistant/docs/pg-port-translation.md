# SQLite to Postgres construct translation

The mechanical guide for porting a data-layer slice from the legacy SQLite
accessors to the Postgres-only `AsyncDb` facade
(`assistant/src/persistence/db-facade.ts`). The port is complete: every runtime
store and route resolves the facade, and the synchronous SQLite helpers remain
only in the legacy migration chain and the out-of-process database tooling.

## Calling convention

1. Replace the synchronous accessor with the facade and add `await`:
   - `getSqlite()` / `getSqliteFrom(db)` -> `getAsyncDb()`, or `requireMainDb()`
     when every operation needs the connection (it throws instead of returning
     `null`).
   - `getMemorySqlite` -> `getMemoryAsyncDb`; `getTelemetrySqlite` ->
     `getTelemetryAsyncDb`. Both resolve the shared Postgres database. The
     `logs` slot is ClickHouse and is not served by the facade.
   - `rawGet/rawAll/rawRun/rawExec` -> `rawGetAsync/rawAllAsync/rawRunAsync/rawExecAsync`
     (same label-first signature). `rawMemory*Async` / `rawTelemetry*Async`
     cover the dedicated rows.
   - `getTelemetryDb()` returning a Drizzle instance -> `getTelemetryAsyncDb()`
     returning a facade; the Drizzle root is `facade.orm` and its terminal calls
     must be awaited.
2. Facade accessors return `null` when `VELLUM_DATABASE_URL` is unset or blank
   (same degraded-mode posture as the dedicated `get*Db()` accessors). Keep the
   existing `if (!db) return ...` branches.
3. Drizzle query builders are thenable, so `await db.orm.select()...` is the
   query path. The old `.all()` / `.get()` / `.run()` terminals belong to the
   `bun:sqlite` driver and are not part of the builder API; use `await` on the
   builder, or the facade's `all`/`get`/`run` for raw SQL.
4. `AsyncDb.orm` is the Postgres Drizzle instance and `AsyncDb.schema` is the
   `pg-schema/` barrel, so the table objects a query uses come from the same
   dialect as the connection.
5. `db.transaction(cb)` opens one connection and hands `cb` a transaction-scoped
   `AsyncDb`. Its raw methods (`run`/`all`/`get`/`exec`) and its `orm` root both
   use that connection. Any helper that must join the transaction takes an
   optional `db: AsyncDb` parameter and is called with the callback's `tx`;
   helpers that call `requireMainDb()` internally run on a different pooled
   connection and cannot see uncommitted rows.

## SQL constructs

| SQLite                                                                                                             | Postgres                                                              | Notes                                                                    |
| ------------------------------------------------------------------------------------------------------------------ | --------------------------------------------------------------------- | ------------------------------------------------------------------------ |
| `PRAGMA table_info(t)`                                                                                             | `information_schema.columns` / `pg_catalog.pg_attribute`              | schema introspection                                                     |
| `PRAGMA index_list/index_info`                                                                                     | `pg_indexes` / `pg_index`                                             | schema introspection                                                     |
| `PRAGMA foreign_keys = OFF/ON`                                                                                     | drop the statement                                                    | PG checks FKs at statement end; no toggle                                |
| `PRAGMA journal_mode / synchronous / busy_timeout / cache_size / temp_store / journal_size_limit / wal_checkpoint` | drop                                                                  | connection/durability settings with no PG equivalent                     |
| `SELECT sql FROM sqlite_master WHERE ...`                                                                          | `pg_catalog.pg_class` + `pg_get_viewdef`/`pg_get_indexdef`            | table/DDL introspection                                                  |
| `INSERT OR IGNORE INTO t (...) VALUES (...)`                                                                       | `INSERT INTO t (...) VALUES (...) ON CONFLICT DO NOTHING`             |                                                                          |
| `INSERT OR REPLACE INTO t (...) VALUES (...)`                                                                      | `INSERT INTO t (...) VALUES (...) ON CONFLICT (pk) DO UPDATE SET ...` | requires the conflict target                                             |
| `.onConflictDoUpdate({ target, set })` (Drizzle)                                                                   | unchanged                                                             | Drizzle already emits `ON CONFLICT ... DO UPDATE SET ... = excluded....` |
| `json_extract(col, '$.k')`                                                                                         | `col::jsonb ->> 'k'`                                                  | returns text; `->` keeps jsonb                                           |
| `json_set(col, '$.k', v)`                                                                                          | `jsonb_set(col::jsonb, '{k}', to_jsonb(v))`                           |                                                                          |
| `json_each(col)`                                                                                                   | `jsonb_array_elements(col::jsonb)` / `jsonb_each`                     | set-returning                                                            |
| `json_group_array(...)` / `json_object(...)`                                                                       | `jsonb_agg(...)` / `jsonb_build_object(...)`                          |                                                                          |
| `strftime('%Y-%m', ts, 'unixepoch')`                                                                               | `to_char(to_timestamp(ts/1000.0), 'YYYY-MM')`                         | epoch-ms columns                                                         |
| `strftime('%s', col)`                                                                                              | `extract(epoch from col)::bigint`                                     |                                                                          |
| `date(col, 'unixepoch')`                                                                                           | `to_timestamp(col/1000.0)::date`                                      |                                                                          |
| `datetime('now')`                                                                                                  | `now()`                                                               |                                                                          |
| `col GLOB 'pat*'`                                                                                                  | `col SIMILAR TO 'pat%'` / `col ~ 'regex'`                             |                                                                          |
| `SELECT changes()` / `.run().changes`                                                                              | `RETURNING` clause, or the driver's row count                         | the facade's `run` returns the affected-row count                        |
| `AUTOINCREMENT`                                                                                                    | `GENERATED ... AS IDENTITY` / `serial`                                | none in the ported schema today                                          |
| `INTEGER` epoch-ms column                                                                                          | `BIGINT`                                                              | decision: keep epoch-ms as `bigint`, no app-code change                  |
| `BLOB` column                                                                                                      | `BYTEA`                                                               | `bun:sqlite` returns `Uint8Array`; `postgres.js` returns `Buffer`        |
| `TEXT` column holding JSON                                                                                         | `JSONB` (where the code reads fields) or keep `TEXT`                  | decide per column                                                        |
| table rebuild (create/copy/drop/rename)                                                                            | `ALTER TABLE` (add/drop/alter column, add constraint)                 | SQLite needs the rebuild; PG usually does not                            |
| `WITHOUT ROWID` / `VIRTUAL TABLE` (FTS5)                                                                           | n/a (FTS5 already removed)                                            | PG would use `tsvector`/`pg_trgm`                                        |

## Notes for the Postgres backend

1. Positional placeholders: the facade accepts `?` and the backend rewrites
   them to `$1..$n`.
2. `bigint` values: `postgres.js` returns `int8` as a string by default; the
   backend registers an `int8` parser that returns a JS number so epoch-ms
   columns behave like the legacy `INTEGER` columns.
3. Multi-row `INSERT ... VALUES (...), (...)` is atomic in one statement; wraps
   that combine several statements use `db.transaction`.
