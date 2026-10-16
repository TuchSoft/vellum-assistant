import { defineConfig } from "drizzle-kit";

/**
 * Drizzle Kit config for generating FUTURE Postgres migrations.
 *
 * `schema` points at the Postgres mirror (`pg-schema/`), which is the source of
 * truth for the ORM against Postgres. `drizzle-kit generate` emits dialect-PG
 * DDL into `out/`. The one-time baseline that materialises the schema captured
 * from the SQLite databases lives in `src/persistence/pg-migrations/` and is not
 * produced by drizzle-kit (it is generated from live SQLite introspection).
 *
 * The previous target (`./src/memory/schema.ts`, `dialect: "sqlite"`) was stale:
 * that path does not exist. The SQLite schema remains `src/persistence/schema/`
 * and is not a drizzle-kit generation target.
 */
export default defineConfig({
  schema: "./src/persistence/pg-schema/index.ts",
  out: "./drizzle-pg",
  dialect: "postgresql",
});
