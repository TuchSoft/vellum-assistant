/**
 * Translate the introspected SQLite model into an idempotent Postgres baseline.
 *
 * Design choices:
 * - The baseline is generated from the *live* SQLite schema (see
 *   `sqlite-model.ts`), not from the Drizzle schema files, which are a subset of
 *   the real tables. The schema files supply *type intent* where they know it
 *   (booleans, binary), via {@link deriveTypeOverrides}; structure always comes
 *   from introspection.
 * - Foreign keys are emitted as separate idempotent `ALTER TABLE ... ADD
 *   CONSTRAINT` statements (guarded by a `DO` block) rather than inline. That
 *   removes any table-ordering / reference-cycle constraint from generation and
 *   keeps re-application safe.
 * - Every statement is `IF NOT EXISTS` (or duplicate-guarded), so applying the
 *   baseline twice is a no-op.
 *
 * Type mapping (decisions from the port brief): epoch-ms INTEGER -> `bigint`,
 * BLOB -> `bytea`, JSON kept as `text` unless a schema override says otherwise.
 */

import { getTableColumns, getTableName, is, Table } from "drizzle-orm";

import * as sqliteSchema from "../schema/index.js";
import type {
  SqliteColumn,
  SqliteSchema,
  SqliteTable,
} from "./sqlite-model.js";

/**
 * Tables excluded from the Postgres baseline. Nothing is excluded: the
 * consolidated database carries the request-log tables the conversation store
 * reads directly. Compaction logs are ClickHouse-only and have no SQLite table,
 * so there is nothing to exclude for them.
 */
export const EXCLUDED_TABLES: readonly RegExp[] = [];

export interface BaselineOptions {
  excludeTables?: readonly RegExp[];
  /** `table.column` -> explicit Postgres type, from schema-file intent. */
  pgTypeOverrides?: ReadonlyMap<string, string>;
}

const IDENTIFIER = /^[A-Za-z_][A-Za-z0-9_]*$/;

function ident(name: string): string {
  if (!IDENTIFIER.test(name)) {
    throw new Error(`refusing to emit unsafe identifier: ${name}`);
  }
  return `"${name}"`;
}

/** Map a SQLite declared column type to a Postgres type. */
export function pgTypeFor(declaredType: string): string {
  const type = declaredType.toUpperCase();
  if (type === "") {
    return "text";
  }
  if (type.includes("BOOL")) {
    return "boolean";
  }
  if (type.includes("INT")) {
    return "bigint";
  }
  if (type.includes("CHAR") || type.includes("CLOB") || type.includes("TEXT")) {
    return "text";
  }
  if (type.includes("BLOB")) {
    return "bytea";
  }
  if (type.includes("REAL") || type.includes("FLOA") || type.includes("DOUB")) {
    return "double precision";
  }
  if (type.includes("DEC") || type.includes("NUMERIC")) {
    return "numeric";
  }
  return "text";
}

/**
 * Translate a SQLite default expression to Postgres. Most literals pass through
 * unchanged; the SQLite time functions have no direct equivalent.
 */
export function pgDefaultFor(rawDefault: string): string {
  const value = rawDefault.trim();
  if (/^(strftime|datetime)\s*\(/i.test(value) || /unixepoch/i.test(value)) {
    return "now()";
  }
  return value;
}

/**
 * The DEFAULT clause for a column, translated for its resolved Postgres type.
 * Two SQLite-isms need fixing: booleans stored as 0/1 (`boolean` rejects an
 * integer default), and a time function default on an epoch-ms `bigint` column
 * (`now()` is a timestamptz).
 */
function defaultClause(rawDefault: string, pgType: string): string {
  const value = pgDefaultFor(rawDefault);
  if (value === "now()") {
    if (pgType === "bigint") {
      return "(floor(extract(epoch from now()) * 1000))::bigint";
    }
    if (pgType === "double precision" || pgType === "numeric") {
      return "extract(epoch from now())";
    }
    return "now()";
  }
  if (pgType === "boolean") {
    if (value === "0" || value === "'0'" || value === "false") {
      return "false";
    }
    if (value === "1" || value === "'1'" || value === "true") {
      return "true";
    }
  }
  return value;
}

/**
 * Derive `table.column` -> Postgres type overrides from the Drizzle SQLite
 * schema (the code's stated intent). Only types whose Postgres mapping is
 * unambiguous are returned: boolean -> boolean, buffer -> bytea.
 */
export function deriveTypeOverrides(): Map<string, string> {
  const overrides = new Map<string, string>();
  for (const value of Object.values(sqliteSchema)) {
    if (!is(value, Table)) {
      continue;
    }
    const table = getTableName(value);
    for (const column of Object.values(getTableColumns(value))) {
      const dataType = (column as { dataType?: string }).dataType;
      if (dataType === "boolean") {
        overrides.set(`${table}.${column.name}`, "boolean");
      } else if (dataType === "buffer") {
        overrides.set(`${table}.${column.name}`, "bytea");
      }
    }
  }
  return overrides;
}

function isExcluded(name: string, patterns: readonly RegExp[]): boolean {
  return patterns.some((pattern) => pattern.test(name));
}

function columnType(
  column: SqliteColumn,
  table: SqliteTable,
  opts: BaselineOptions,
): string {
  return (
    opts.pgTypeOverrides?.get(`${table.name}.${column.name}`) ??
    pgTypeFor(column.declaredType)
  );
}

function primaryKeyColumns(table: SqliteTable): string[] {
  return table.columns
    .filter((column) => column.pkOrdinal > 0)
    .sort((a, b) => a.pkOrdinal - b.pkOrdinal)
    .map((column) => column.name);
}

function createTableStatement(
  table: SqliteTable,
  opts: BaselineOptions,
): string {
  const pk = primaryKeyColumns(table);
  const singlePk = pk.length === 1 ? pk[0] : null;
  const lines: string[] = [];
  for (const column of table.columns) {
    const pgType = columnType(column, table, opts);
    const parts = [ident(column.name), pgType];
    if (column.notNull) {
      parts.push("NOT NULL");
    }
    if (column.defaultValue !== null) {
      parts.push(`DEFAULT ${defaultClause(column.defaultValue, pgType)}`);
    }
    if (singlePk === column.name) {
      parts.push("PRIMARY KEY");
    }
    lines.push("  " + parts.join(" "));
  }
  if (pk.length > 1) {
    lines.push(`  PRIMARY KEY (${pk.map(ident).join(", ")})`);
  }
  return `CREATE TABLE IF NOT EXISTS ${ident(table.name)} (\n${lines.join(",\n")}\n)`;
}

function foreignKeyStatements(table: SqliteTable): string[] {
  return table.foreignKeys.map((fk) => {
    const constraint = `fk_${table.name}_${fk.columns.join("_")}`;
    const onDelete =
      fk.onDelete && fk.onDelete !== "NO ACTION"
        ? ` ON DELETE ${fk.onDelete}`
        : "";
    const refColumns = fk.refColumns.map(ident).join(", ");
    const alter =
      `ALTER TABLE ${ident(table.name)} ADD CONSTRAINT ${ident(constraint)} ` +
      `FOREIGN KEY (${fk.columns.map(ident).join(", ")}) ` +
      `REFERENCES ${ident(fk.refTable)} (${refColumns})${onDelete}`;
    // Idempotent: re-adding an existing constraint is swallowed.
    return `DO $$ BEGIN\n  ${alter};\nEXCEPTION WHEN duplicate_object THEN NULL; END $$`;
  });
}

function indexStatements(table: SqliteTable): string[] {
  return table.indexes.map((index) => {
    const unique = index.unique ? "UNIQUE " : "";
    const where = index.where ? ` WHERE ${index.where}` : "";
    return (
      `CREATE ${unique}INDEX IF NOT EXISTS ${ident(index.name)} ` +
      `ON ${ident(table.name)} (${index.columns.map(ident).join(", ")})${where}`
    );
  });
}

/**
 * Build the ordered Postgres baseline statement list for a SQLite schema.
 * Tables are created in name order (FKs are added afterwards, so order does not
 * matter for correctness), then foreign keys, then indexes.
 */
export function buildBaselineStatements(
  schema: SqliteSchema,
  options: BaselineOptions = {},
): string[] {
  const excluded = options.excludeTables ?? EXCLUDED_TABLES;
  const tables = schema.tables
    .filter((table) => !isExcluded(table.name, excluded))
    .sort((a, b) => a.name.localeCompare(b.name));

  const statements: string[] = [];
  for (const table of tables) {
    statements.push(createTableStatement(table, options));
  }
  for (const table of tables) {
    statements.push(...foreignKeyStatements(table));
  }
  for (const table of tables) {
    statements.push(...indexStatements(table));
  }
  return statements;
}
