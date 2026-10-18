# Postgres baseline and migrations

How the Postgres schema is created and evolved for the DB port. Complements
`pg-port-translation.md` (the SQLite -> Postgres construct map).

## Pieces

| Piece         | Path                                                  | Role                                                                                                                                 |
| ------------- | ----------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------ |
| Schema mirror | `src/persistence/pg-schema/`                          | `pgTable` definitions, structurally identical to `src/persistence/schema/`; the ORM source of truth (`AsyncDb.schema`)               |
| Introspection | `src/persistence/pg-migrations/sqlite-model.ts`       | reads the _effective_ schema of the live SQLite files (`sqlite_master` + `PRAGMA table_info/index_list/index_info/foreign_key_list`) |
| Translator    | `src/persistence/pg-migrations/baseline.ts`           | neutral model -> idempotent Postgres DDL                                                                                             |
| Baseline      | `src/persistence/pg-migrations/baseline.generated.ts` | generated, committed                                                                                                                 |
| Generator     | `scripts/generate-pg-baseline.ts`                     | regenerates the baseline                                                                                                             |
| Runner        | `src/persistence/pg-migrations/run-pg-migrations.ts`  | ledger + ordered apply + rollback                                                                                                    |
| Steps         | `src/persistence/pg-migrations/pg-steps.ts`           | `0000_baseline` + data backfills                                                                                                     |

## Baseline generation

The baseline is generated from the **live SQLite schema**, not from the
`schema/*.ts` files, because those are a subset of the real tables. The
generator migrates a throwaway workspace, introspects all four SQLite databases
(main, logs, memory, telemetry), merges them into one model (the port lands them
in a single Postgres database) and emits the DDL.

Type mapping: `INTEGER` -> `bigint` (epoch-ms), `BLOB` -> `bytea`,
`REAL` -> `double precision`, `TEXT` -> `text`; the Drizzle schema supplies type
_intent_ where it is knowable (`{ mode: "boolean" }` -> `boolean`). Defaults are
translated for their resolved type: `0`/`1` -> `false`/`true` on a boolean
column, and a SQLite time function on a `bigint` column becomes epoch-ms
`(floor(extract(epoch from now()) * 1000))::bigint`.

Excluded: none. The consolidated Postgres database also carries
`llm_request_logs`, which the conversation store reads directly. Compaction logs
have no SQLite table (they are ClickHouse-only), so there is nothing to exclude
for them.

Partial indexes keep their predicate: `sqlite-model.ts` reads the stored index
DDL and the translator appends its `WHERE` clause, so a unique index that only
covers one slice of a table stays partial on Postgres.

Every statement is idempotent: `CREATE TABLE/INDEX IF NOT EXISTS`, and foreign
keys are added as `DO $$ ... EXCEPTION WHEN duplicate_object THEN NULL $$`
blocks (which also removes any table-ordering or reference-cycle concern).

```
cd assistant && bun run scripts/generate-pg-baseline.ts            # migrate a temp workspace
cd assistant && bun run scripts/generate-pg-baseline.ts --db <path> # introspect a given file
```

## Migrations

`PG_STEPS` is applied with `runPgMigrations(db, PG_STEPS)` against an `AsyncDb`.
The ledger (`pg_schema_migrations`) records each applied step by name; a
re-run skips them. `rollbackPgMigrations(db, PG_STEPS, { to })` runs each step's
`down` in reverse. A step without `down` blocks rollback past it, because
silently skipping it would leave the ledger disagreeing with the schema.

**Upstream schema changes** are handled by regenerating the baseline while the
port is in its baseline phase, and by `drizzle-kit generate` afterwards (see
`drizzle.config.ts`: `dialect: postgresql`, `schema: ./src/persistence/pg-schema/index.ts`).
**Data backfills** get their own named, idempotent step in `pg-steps.ts`.

`drizzle-kit generate` currently emits the _full_ schema (there is no committed
snapshot yet), so its output is not committed: it would duplicate the baseline.
Its snapshot (`drizzle-pg/`) should be seeded from the baseline when the
baseline phase ends, after which generate emits deltas only.

## Tests

- `src/persistence/pg-migrations/__tests__/baseline.test.ts` — unit: type and
  default mapping, FK/index emission, committed-baseline invariants (log tables
  absent, every statement idempotent). No database.
- `src/persistence/pg-migrations/__tests__/pg-integration.test.ts` — Postgres,
  gated on `VELLUM_PG_TEST_URL`: the baseline applies to an empty database,
  is idempotent, excludes the log tables, round-trips a synthetic SQLite schema,
  and the runner applies + rolls back.
- `src/__tests__/pg-test-db.ts` — the shared test bootstrap. When
  `VELLUM_PG_TEST_URL` is set, every test process gets its own schema, the
  generated baseline is applied there, and `VELLUM_DATABASE_URL` points at it.
  The conformance suites (`*-postgres.test.ts`) gate their `describe` on
  `describePg` from this module; with the variable unset they skip.
- `src/persistence/__tests__/pg-schema-mirror.test.ts` — the `pg-schema` mirror
  stays structurally identical to `schema/`.
