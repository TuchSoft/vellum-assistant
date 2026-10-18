/**
 * One-shot data loader: SQLite databases -> a Postgres database.
 *
 * The port keeps SQLite as the rollback target and moves the live data into the
 * consolidated Postgres database. This module owns the data movement and its
 * verification; the CLI (`scripts/load-sqlite-to-postgres.ts`) owns snapshots,
 * argument parsing and reporting.
 *
 * Invariants:
 * - Source databases are opened read-only. The CLI snapshots them with
 *   `sqlite3 .backup` first, so a loader run never reads a live WAL.
 * - The target schema comes from the runtime baseline and ledger: the caller
 *   runs `runPgMigrations(db, PG_STEPS)` before calling {@link loadSqliteToPostgres}.
 *   The loader only adds the tables and columns the baseline does not carry
 *   (runtime-created and plugin-owned schema), through the same
 *   `sqlite-model`/`baseline` translation, and reports every addition.
 * - One transaction per table. A failed table rolls back on its own and the
 *   run continues, so the report lists every failure instead of stopping at
 *   the first one.
 * - Every table is verified with an order-independent checksum computed in
 *   JavaScript on both sides, so the comparison does not depend on row order
 *   or on a database-specific hash function.
 */

import { spawnSync } from "node:child_process";
import { Database } from "bun:sqlite";

import type { AsyncDb, AsyncDbSlot, SqlParam } from "../db-facade.js";
import {
  buildBaselineStatements,
  buildForeignKeyStatements,
  deriveTypeOverrides,
  pgDefaultClause,
  pgTypeFor,
} from "./baseline.js";
import { introspectSqlite, type SqliteTable } from "./sqlite-model.js";

const IDENTIFIER = /^[A-Za-z_][A-Za-z0-9_]*$/;

/** Postgres' bind-parameter ceiling for one statement, with headroom. */
const MAX_PARAMS_PER_STATEMENT = 60_000;
const DEFAULT_BATCH_SIZE = 1_000;
const DEFAULT_CHECKSUM_PAGE_SIZE = 5_000;

/** Keep the 64-bit accumulators in range. */
const MASK_64 = (1n << 64n) - 1n;

export interface SqliteLoadSource {
  /** Logical slot the database belongs to; carried into the report. */
  slot: AsyncDbSlot;
  /** Path to a consistent SQLite file (see `snapshotSqliteDatabase`). */
  path: string;
}

export interface SqliteLoadOptions {
  /** Truncate non-empty target tables instead of refusing the run. */
  force?: boolean;
  /** Rows per INSERT statement. Clamped to the bind-parameter ceiling. */
  batchSize?: number;
  /** Rows per page when reading the target back for verification. */
  checksumPageSize?: number;
  /** Tables to leave out of the load entirely. */
  excludeTables?: readonly string[];
  /** Progress sink; the CLI prints, tests stay quiet. */
  onProgress?: (message: string) => void;
}

export interface TableLoadResult {
  table: string;
  slot: AsyncDbSlot;
  sourceRows: number;
  targetRows: number;
  /** Columns compared by the checksum. */
  columns: string[];
  sourceChecksum: string;
  targetChecksum: string;
  checksumOk: boolean;
  durationMs: number;
  /** True when the loader created the target table. */
  createdTable: boolean;
  /** Target columns the loader added before loading. */
  addedColumns: string[];
  /** Value normalizations the target types forced. */
  normalizations: NormalizationCounts;
  /** Set when the table failed; the transaction rolled back. */
  error?: string;
}

export interface SqliteLoadReport {
  ok: boolean;
  tables: TableLoadResult[];
  createdTables: string[];
  addedColumns: string[];
  /** Source tables left out, with the reason. */
  skippedTables: Array<{ table: string; reason: string }>;
  /** Target tables that received no rows because no source table exists. */
  targetOnlyTables: string[];
  totals: {
    tables: number;
    failedTables: number;
    sourceRows: number;
    targetRows: number;
    durationMs: number;
    normalizations: NormalizationCounts;
  };
}

interface TargetColumn {
  name: string;
  dataType: string;
  notNull: boolean;
  hasDefault: boolean;
}

interface SourceTableEntry {
  table: SqliteTable;
  slot: AsyncDbSlot;
  path: string;
}

interface RowChecksum {
  rows: number;
  sum: bigint;
  xor: bigint;
}

/**
 * Snapshot a SQLite database with `sqlite3 .backup`, then verify the copy.
 * A live database must never be read directly: its WAL is only folded into a
 * `.backup`, not into the file the runtime is writing.
 */
export function snapshotSqliteDatabase(
  sourcePath: string,
  snapshotPath: string,
): void {
  if (snapshotPath.includes("'")) {
    throw new Error(`refusing a snapshot path with a quote: ${snapshotPath}`);
  }
  const backup = spawnSync(
    "sqlite3",
    [sourcePath, `.backup '${snapshotPath}'`],
    { windowsHide: true, encoding: "utf8" },
  );
  if (backup.error) {
    throw new Error(
      `sqlite3 is required for a consistent snapshot: ${backup.error.message}`,
    );
  }
  if (backup.status !== 0) {
    throw new Error(
      `sqlite3 .backup failed for ${sourcePath}: ${backup.stderr.trim()}`,
    );
  }
  const check = spawnSync(
    "sqlite3",
    [snapshotPath, "PRAGMA integrity_check;"],
    {
      windowsHide: true,
      encoding: "utf8",
    },
  );
  if (check.status !== 0) {
    throw new Error(
      `sqlite3 integrity_check failed for ${snapshotPath}: ${check.stderr.trim()}`,
    );
  }
  if (check.stdout.trim() !== "ok") {
    throw new Error(
      `snapshot integrity_check for ${snapshotPath} returned: ${check.stdout.trim()}`,
    );
  }
}

function quote(identifier: string): string {
  if (!IDENTIFIER.test(identifier)) {
    throw new Error(`refusing to use unsafe identifier: ${identifier}`);
  }
  return `"${identifier}"`;
}

/**
 * Read every source database into one table map. A table name in two
 * databases is a shape conflict: the consolidated database cannot hold two
 * definitions under one name, so the run refuses before writing anything.
 */
function readSources(
  sources: readonly SqliteLoadSource[],
): Map<string, SourceTableEntry> {
  const tables = new Map<string, SourceTableEntry>();
  for (const source of sources) {
    const db = new Database(source.path, { readonly: true });
    try {
      for (const table of introspectSqlite(db).tables) {
        const prior = tables.get(table.name);
        if (prior) {
          throw new Error(
            `table "${table.name}" appears in both ${prior.slot} (${prior.path}) and ${source.slot} (${source.path}); refusing to merge two shapes`,
          );
        }
        tables.set(table.name, {
          table,
          slot: source.slot,
          path: source.path,
        });
      }
    } finally {
      db.close();
    }
  }
  return tables;
}

async function readTargetColumns(
  db: AsyncDb,
): Promise<Map<string, TargetColumn[]>> {
  const rows = await db.all<{
    table_name: string;
    column_name: string;
    data_type: string;
    is_nullable: string;
    column_default: string | null;
  }>(
    `SELECT table_name, column_name, data_type, is_nullable, column_default
       FROM information_schema.columns
      WHERE table_schema = current_schema()
      ORDER BY table_name, ordinal_position`,
  );
  const map = new Map<string, TargetColumn[]>();
  for (const row of rows) {
    const columns = map.get(row.table_name) ?? [];
    columns.push({
      name: row.column_name,
      dataType: row.data_type,
      notNull: row.is_nullable === "NO",
      hasDefault: row.column_default !== null,
    });
    map.set(row.table_name, columns);
  }
  return map;
}

function typeOverrides(): ReadonlyMap<string, string> {
  return deriveTypeOverrides();
}

/**
 * Create the source tables the baseline does not carry, then add the source
 * columns it does not carry to existing tables. Runtime-created and
 * plugin-owned schema (conversation groups, memory-v3 pool tables) is created
 * by the runtime on first use, after the baseline, so it is not in
 * `BASELINE_STATEMENTS`; loading it without this step would drop real data.
 */
async function reconcileSchema(
  db: AsyncDb,
  entries: readonly SourceTableEntry[],
  target: Map<string, TargetColumn[]>,
  overrides: ReadonlyMap<string, string>,
  onProgress: (message: string) => void,
): Promise<{ createdTables: string[]; addedColumns: string[] }> {
  const createdTables: string[] = [];
  const addedColumns: string[] = [];

  const missingTables = entries
    .filter((entry) => !target.has(entry.table.name))
    .map((entry) => entry.table);
  if (missingTables.length > 0) {
    // One call so `buildBaselineStatements` emits every CREATE before the
    // foreign keys, which removes the inter-table ordering constraint.
    const statements = buildBaselineStatements(
      { tables: missingTables },
      { pgTypeOverrides: overrides },
    );
    for (const statement of statements) {
      await db.exec(statement);
    }
    for (const table of missingTables) {
      createdTables.push(table.name);
      target.set(table.name, await columnsForTable(db, table.name));
      onProgress(`created target table ${table.name}`);
    }
  }

  for (const entry of entries) {
    const targetColumns = target.get(entry.table.name);
    if (!targetColumns) {
      continue;
    }
    const present = new Set(targetColumns.map((column) => column.name));
    const missing = entry.table.columns.filter(
      (column) => !present.has(column.name),
    );
    for (const column of missing) {
      const pgType =
        overrides.get(`${entry.table.name}.${column.name}`) ??
        pgTypeFor(column.declaredType);
      const defaultSql =
        column.defaultValue !== null
          ? ` DEFAULT ${pgDefaultClause(column.defaultValue, pgType)}`
          : "";
      await db.exec(
        `ALTER TABLE ${quote(entry.table.name)} ADD COLUMN ${quote(column.name)} ${pgType}${defaultSql}`,
      );
      addedColumns.push(`${entry.table.name}.${column.name}`);
      onProgress(
        `added target column ${entry.table.name}.${column.name} (${pgType})`,
      );
    }
    if (missing.length === 0) {
      continue;
    }
    // A foreign key on an added column was never declared in the target, and
    // the runtime's own ALTER skips it once the column exists. Re-add it from
    // the source model so ON DELETE behavior survives the port.
    const added = new Set(missing.map((column) => column.name));
    const foreignKeys = entry.table.foreignKeys.filter(
      (fk) =>
        fk.columns.every((column) => added.has(column)) &&
        target.has(fk.refTable),
    );
    if (foreignKeys.length > 0) {
      for (const statement of buildForeignKeyStatements({
        ...entry.table,
        foreignKeys,
      })) {
        await db.exec(statement);
      }
    }
    target.set(entry.table.name, await columnsForTable(db, entry.table.name));
  }

  return { createdTables, addedColumns };
}

async function columnsForTable(
  db: AsyncDb,
  table: string,
): Promise<TargetColumn[]> {
  const rows = await db.all<{
    column_name: string;
    data_type: string;
    is_nullable: string;
    column_default: string | null;
  }>(
    `SELECT column_name, data_type, is_nullable, column_default
       FROM information_schema.columns
      WHERE table_schema = current_schema() AND table_name = ?
      ORDER BY ordinal_position`,
    [table],
  );
  return rows.map((row) => ({
    name: row.column_name,
    dataType: row.data_type,
    notNull: row.is_nullable === "NO",
    hasDefault: row.column_default !== null,
  }));
}

/** Target tables that already hold rows, in name order. */
async function nonEmptyTargetTables(
  db: AsyncDb,
  names: readonly string[],
): Promise<string[]> {
  const nonEmpty: string[] = [];
  for (const name of names) {
    const row = await db.get<{ count: string | number }>(
      `SELECT COUNT(*) AS count FROM ${quote(name)}`,
    );
    if (row !== null && Number(row.count) > 0) {
      nonEmpty.push(name);
    }
  }
  return nonEmpty;
}

/**
 * A load order in which every table follows the tables it references.
 * Self-references are ignored here (they are handled by dropping that one
 * constraint around the load); a cycle across tables falls back to name order
 * and the caller drops the participating constraints.
 */
function loadOrder(entries: readonly SourceTableEntry[]): {
  order: string[];
  hasCycle: boolean;
} {
  const names = new Set(entries.map((entry) => entry.table.name));
  const parents = new Map<string, Set<string>>();
  for (const entry of entries) {
    const set = new Set<string>();
    for (const fk of entry.table.foreignKeys) {
      if (fk.refTable !== entry.table.name && names.has(fk.refTable)) {
        set.add(fk.refTable);
      }
    }
    parents.set(entry.table.name, set);
  }

  const order: string[] = [];
  const remaining = new Set(names);
  while (remaining.size > 0) {
    const ready = [...remaining]
      .filter((name) =>
        [...(parents.get(name) ?? [])].every(
          (parent) => !remaining.has(parent),
        ),
      )
      .sort();
    if (ready.length === 0) {
      return { order: [...order, ...[...remaining].sort()], hasCycle: true };
    }
    for (const name of ready) {
      remaining.delete(name);
      order.push(name);
    }
  }
  return { order, hasCycle: false };
}

function selfReferencingTables(
  entries: readonly SourceTableEntry[],
  loaded: ReadonlySet<string>,
): string[] {
  return entries
    .filter(
      (entry) =>
        loaded.has(entry.table.name) &&
        entry.table.foreignKeys.some((fk) => fk.refTable === entry.table.name),
    )
    .map((entry) => entry.table.name);
}

function foreignKeyConstraintName(
  table: string,
  columns: readonly string[],
): string {
  const name = `fk_${table}_${columns.join("_")}`;
  if (name.length > 63) {
    throw new Error(
      `foreign-key constraint name exceeds Postgres' 63-byte limit: ${name}`,
    );
  }
  return name;
}

async function dropConstraints(
  db: AsyncDb,
  names: readonly string[],
  table: string,
): Promise<void> {
  for (const name of names) {
    await db.exec(
      `ALTER TABLE ${quote(table)} DROP CONSTRAINT IF EXISTS ${quote(name)}`,
    );
  }
}

/**
 * Drop the foreign keys that prevent a legal insert order: the self-reference
 * of each table that has one, or every foreign key among the loaded tables
 * when the dependency graph has a cycle. Returns a restore callback that
 * re-adds exactly those constraints from the source model.
 */
async function relaxForeignKeys(
  db: AsyncDb,
  entries: readonly SourceTableEntry[],
  loaded: ReadonlySet<string>,
  selfReferencing: readonly string[],
  hasCycle: boolean,
): Promise<() => Promise<void>> {
  const dropped: SqliteTable[] = [];
  if (hasCycle) {
    for (const entry of entries) {
      if (!loaded.has(entry.table.name)) {
        continue;
      }
      const foreignKeys = entry.table.foreignKeys.filter((fk) =>
        loaded.has(fk.refTable),
      );
      if (foreignKeys.length === 0) {
        continue;
      }
      const table: SqliteTable = { ...entry.table, foreignKeys };
      await dropConstraints(
        db,
        foreignKeys.map((fk) =>
          foreignKeyConstraintName(entry.table.name, fk.columns),
        ),
        entry.table.name,
      );
      dropped.push(table);
    }
  } else {
    for (const name of selfReferencing) {
      const entry = entries.find((candidate) => candidate.table.name === name);
      if (!entry) {
        continue;
      }
      const foreignKeys = entry.table.foreignKeys.filter(
        (fk) => fk.refTable === name,
      );
      await dropConstraints(
        db,
        foreignKeys.map((fk) => foreignKeyConstraintName(name, fk.columns)),
        name,
      );
      dropped.push({ ...entry.table, foreignKeys });
    }
  }
  return async () => {
    for (const table of dropped) {
      for (const statement of buildForeignKeyStatements(table)) {
        await db.exec(statement);
      }
    }
  };
}

type PgTypeCategory =
  | "boolean"
  | "bytea"
  | "integer"
  | "float"
  | "numeric"
  | "text";

/** Value normalizations the target types force, counted per table. */
export interface NormalizationCounts {
  /** 0x00 bytes replaced with U+FFFD: Postgres text cannot store them. */
  nulBytesReplaced: number;
  /** Fractional values truncated into `bigint` columns. */
  fractionalIntegersTruncated: number;
}

function typeCategory(dataType: string): PgTypeCategory {
  switch (dataType) {
    case "boolean":
      return "boolean";
    case "bytea":
      return "bytea";
    case "bigint":
    case "integer":
    case "smallint":
      return "integer";
    case "double precision":
    case "real":
      return "float";
    case "numeric":
      return "numeric";
    default:
      return "text";
  }
}

function describeValue(value: unknown): string {
  if (value === null) {
    return "null";
  }
  return `${typeof value}: ${String(value).slice(0, 40)}`;
}

function asBoolean(value: unknown, context: string): boolean {
  if (value === true || value === 1 || value === 1n) {
    return true;
  }
  if (value === false || value === 0 || value === 0n) {
    return false;
  }
  if (value === "1" || value === "true") {
    return true;
  }
  if (value === "0" || value === "false") {
    return false;
  }
  throw new Error(
    `${context}: expected a boolean, got ${describeValue(value)}`,
  );
}

function asBytes(value: unknown, context: string): Uint8Array {
  if (value instanceof Uint8Array) {
    return value;
  }
  throw new Error(`${context}: expected a BLOB, got ${describeValue(value)}`);
}

function numericText(value: unknown, context: string): string {
  if (typeof value === "number") {
    return value.toString();
  }
  if (typeof value === "bigint") {
    return value.toString();
  }
  if (typeof value === "string") {
    return value;
  }
  if (typeof value === "boolean") {
    return value ? "1" : "0";
  }
  throw new Error(`${context}: expected a number, got ${describeValue(value)}`);
}

/**
 * Postgres text rejects 0x00, so a NUL in a source text cell is replaced with
 * U+FFFD (the same substitution the provider retry wrapper uses for orphan
 * surrogates). Both sides of the checksum apply it, so the verification stays
 * exact; the count is reported.
 */
function asText(
  value: unknown,
  context: string,
  counts?: NormalizationCounts,
): string {
  let text: string;
  if (typeof value === "string") {
    text = value;
  } else if (typeof value === "number" || typeof value === "bigint") {
    text = String(value);
  } else {
    throw new Error(`${context}: expected text, got ${describeValue(value)}`);
  }
  if (!text.includes("\u0000")) {
    return text;
  }
  if (counts) {
    counts.nulBytesReplaced += text.split("\u0000").length - 1;
  }
  return text.replaceAll("\u0000", "\uFFFD");
}

/** SQLite stores a REAL in an INTEGER-affinity cell when it has a fraction. */
function integerText(value: unknown, context: string): string {
  if (typeof value === "number") {
    if (!Number.isFinite(value)) {
      throw new Error(`${context}: non-finite number ${value}`);
    }
    return Math.trunc(value).toString();
  }
  if (typeof value === "bigint") {
    return value.toString();
  }
  if (typeof value === "string") {
    const trimmed = value.trim();
    if (/^[+-]?\d+$/.test(trimmed)) {
      return trimmed;
    }
    const numeric = Number(trimmed);
    if (!Number.isFinite(numeric)) {
      throw new Error(`${context}: not an integer: ${describeValue(value)}`);
    }
    return Math.trunc(numeric).toString();
  }
  if (typeof value === "boolean") {
    return value ? "1" : "0";
  }
  throw new Error(
    `${context}: expected an integer, got ${describeValue(value)}`,
  );
}

function asIntegerParam(
  value: unknown,
  context: string,
  counts?: NormalizationCounts,
): SqlParam {
  if (typeof value === "number") {
    if (!Number.isFinite(value)) {
      throw new Error(`${context}: non-finite number ${value}`);
    }
    if (Number.isInteger(value)) {
      return value;
    }
    if (counts) {
      counts.fractionalIntegersTruncated += 1;
    }
    return Math.trunc(value);
  }
  if (typeof value === "bigint") {
    return value <= BigInt(Number.MAX_SAFE_INTEGER) &&
      value >= BigInt(Number.MIN_SAFE_INTEGER)
      ? Number(value)
      : value.toString();
  }
  if (typeof value === "string") {
    const trimmed = value.trim();
    if (/^[+-]?\d+$/.test(trimmed)) {
      return trimmed;
    }
    const numeric = Number(trimmed);
    if (!Number.isFinite(numeric)) {
      throw new Error(`${context}: not an integer: ${describeValue(value)}`);
    }
    if (!Number.isInteger(numeric)) {
      if (counts) {
        counts.fractionalIntegersTruncated += 1;
      }
      return Math.trunc(numeric);
    }
    return numeric;
  }
  if (typeof value === "boolean") {
    return value ? 1 : 0;
  }
  throw new Error(
    `${context}: expected an integer, got ${describeValue(value)}`,
  );
}

function asFloatParam(value: unknown, context: string): SqlParam {
  if (typeof value === "number") {
    return value;
  }
  if (typeof value === "bigint") {
    return Number(value);
  }
  if (typeof value === "string") {
    return value;
  }
  if (typeof value === "boolean") {
    return value ? 1 : 0;
  }
  throw new Error(`${context}: expected a number, got ${describeValue(value)}`);
}

/** Convert a source value to the bind parameter for its target column type. */
function bindValue(
  value: unknown,
  category: PgTypeCategory,
  context: string,
  counts?: NormalizationCounts,
): SqlParam {
  if (value === null || value === undefined) {
    return null;
  }
  switch (category) {
    case "boolean":
      return asBoolean(value, context);
    case "bytea":
      return asBytes(value, context);
    case "integer":
      return asIntegerParam(value, context, counts);
    case "float":
      return asFloatParam(value, context);
    case "numeric":
      return numericText(value, context);
    case "text":
      return asText(value, context, counts);
  }
}

/** Order-independent canonical form of one source/target value. */
function canonicalValue(value: unknown, category: PgTypeCategory): string {
  if (value === null || value === undefined) {
    return "N";
  }
  switch (category) {
    case "boolean":
      return asBoolean(value, "checksum") ? "B1" : "B0";
    case "bytea":
      return "X" + Buffer.from(asBytes(value, "checksum")).toString("hex");
    case "integer":
      return "D" + integerText(value, "checksum");
    case "float":
    case "numeric":
      return "D" + numericText(value, "checksum");
    case "text":
      return "S" + asText(value, "checksum");
  }
}

/**
 * Non-cryptographic 64-bit hash, native in Bun. Both sides of the comparison
 * run in this process, so the algorithm only has to be stable within a run.
 */
function rowHash(text: string): bigint {
  return Bun.hash.xxHash64(text);
}

function addRowToChecksum(checksum: RowChecksum, parts: readonly string[]) {
  const hash = rowHash(parts.join("\u0001"));
  checksum.rows += 1;
  checksum.sum = (checksum.sum + hash) & MASK_64;
  checksum.xor ^= hash;
}

function formatChecksum(checksum: RowChecksum): string {
  return `rows=${checksum.rows} sum=${checksum.sum.toString(16).padStart(16, "0")} xor=${checksum.xor.toString(16).padStart(16, "0")}`;
}

interface TablePlan {
  table: string;
  slot: AsyncDbSlot;
  path: string;
  /** Target columns that have a source value, in target order. */
  columns: TargetColumn[];
  /** Primary-key columns used for keyset pagination of the target. */
  primaryKey: string[];
  createdTable: boolean;
  addedColumns: string[];
}

function planTable(
  entry: SourceTableEntry,
  targetColumns: readonly TargetColumn[],
  createdTables: readonly string[],
  addedColumns: readonly string[],
): TablePlan {
  const sourceColumns = new Set(
    entry.table.columns.map((column) => column.name),
  );
  const columns = targetColumns.filter((column) =>
    sourceColumns.has(column.name),
  );
  if (columns.length === 0) {
    throw new Error(
      `table "${entry.table.name}" has no column in common with the target`,
    );
  }
  for (const column of targetColumns) {
    if (sourceColumns.has(column.name)) {
      continue;
    }
    if (column.notNull && !column.hasDefault) {
      throw new Error(
        `table "${entry.table.name}": target column "${column.name}" is NOT NULL without a default and has no source value`,
      );
    }
  }
  const primaryKey = entry.table.columns
    .filter((column) => column.pkOrdinal > 0)
    .sort((a, b) => a.pkOrdinal - b.pkOrdinal)
    .map((column) => column.name);
  return {
    table: entry.table.name,
    slot: entry.slot,
    path: entry.path,
    columns,
    primaryKey,
    createdTable: createdTables.includes(entry.table.name),
    addedColumns: addedColumns.filter((name) =>
      name.startsWith(`${entry.table.name}.`),
    ),
  };
}

function uniqueColumnOrder(plan: TablePlan): string[] {
  const names = plan.columns.map((column) => column.name);
  const present = new Set(names);
  for (const name of plan.primaryKey) {
    if (!present.has(name)) {
      names.push(name);
    }
  }
  return names;
}

/** Insert every source row for one table in one transaction. */
async function loadTableRows(
  db: AsyncDb,
  plan: TablePlan,
  batchSize: number,
): Promise<{
  checksum: RowChecksum;
  normalizations: NormalizationCounts;
}> {
  const columns = plan.columns;
  const categories = columns.map((column) => typeCategory(column.dataType));
  const names = columns.map((column) => column.name);
  const selectSql = `SELECT ${names.map(quote).join(", ")} FROM ${quote(plan.table)}`;
  const batch = Math.max(
    1,
    Math.min(batchSize, Math.floor(MAX_PARAMS_PER_STATEMENT / columns.length)),
  );
  const insertHeader = `INSERT INTO ${quote(plan.table)} (${names.map(quote).join(", ")}) VALUES `;
  const rowPlaceholders = `(${names.map(() => "?").join(", ")})`;
  const checksum: RowChecksum = { rows: 0, sum: 0n, xor: 0n };
  const normalizations: NormalizationCounts = {
    nulBytesReplaced: 0,
    fractionalIntegersTruncated: 0,
  };

  const source = new Database(plan.path, { readonly: true });
  try {
    const statement = source.query<Record<string, unknown>, []>(selectSql);
    await db.transaction(async (tx) => {
      let params: SqlParam[] = [];
      let rowsInBatch = 0;

      const flush = async (): Promise<void> => {
        if (rowsInBatch === 0) {
          return;
        }
        const values = Array.from(
          { length: rowsInBatch },
          () => rowPlaceholders,
        ).join(", ");
        await tx.run(insertHeader + values, params);
        params = [];
        rowsInBatch = 0;
      };

      for (const row of statement.iterate()) {
        for (let index = 0; index < columns.length; index++) {
          const column = columns[index]!;
          params.push(
            bindValue(
              row[column.name],
              categories[index]!,
              `${plan.table}.${column.name}`,
              normalizations,
            ),
          );
        }
        addRowToChecksum(
          checksum,
          columns.map((column, index) =>
            canonicalValue(row[column.name], categories[index]!),
          ),
        );
        rowsInBatch += 1;
        if (rowsInBatch >= batch) {
          await flush();
        }
      }
      await flush();
    });
  } finally {
    source.close();
  }
  return { checksum, normalizations };
}

/**
 * Compute the checksum of what is actually in the target table. Keyset
 * pagination over the primary key keeps memory flat on the largest tables
 * (`memory_segments` carries hundreds of megabytes of text).
 */
async function checksumTargetTable(
  db: AsyncDb,
  plan: TablePlan,
  pageSize: number,
): Promise<RowChecksum> {
  const checksum: RowChecksum = { rows: 0, sum: 0n, xor: 0n };
  const categories = plan.columns.map((column) =>
    typeCategory(column.dataType),
  );
  const categoryByColumn = new Map(
    plan.columns.map((column) => [column.name, typeCategory(column.dataType)]),
  );
  const selectColumns = uniqueColumnOrder(plan);
  const columnList = selectColumns.map(quote).join(", ");
  const orderBy = plan.primaryKey.map(quote).join(", ");
  const useKeyset = plan.primaryKey.length > 0;
  const keysetWhere = ` WHERE (${plan.primaryKey.map(quote).join(", ")}) > (${plan.primaryKey.map(() => "?").join(", ")})`;
  let last: SqlParam[] | null = null;
  let offset = 0;

  for (;;) {
    const pagination = !useKeyset
      ? ` LIMIT ${pageSize} OFFSET ${offset}`
      : last === null
        ? ""
        : keysetWhere;
    const rows: Array<Record<string, unknown>> = await db.all<
      Record<string, unknown>
    >(
      `SELECT ${columnList} FROM ${quote(plan.table)}${pagination}` +
        (useKeyset ? ` ORDER BY ${orderBy} LIMIT ${pageSize}` : ""),
      last ?? [],
    );
    if (rows.length === 0) {
      break;
    }
    for (const row of rows) {
      addRowToChecksum(
        checksum,
        plan.columns.map((column, index) =>
          canonicalValue(row[column.name], categories[index]!),
        ),
      );
    }
    if (!useKeyset) {
      offset += rows.length;
    }
    if (rows.length < pageSize) {
      break;
    }
    if (useKeyset) {
      const tail: Record<string, unknown> = rows[rows.length - 1]!;
      last = plan.primaryKey.map(
        (column): SqlParam =>
          bindValue(
            tail[column],
            categoryByColumn.get(column) ?? "text",
            `checksum ${plan.table}.${column}`,
          ),
      );
    }
  }
  return checksum;
}

function quoteLoadedTables(plans: readonly TablePlan[]): string {
  return plans.map((plan) => quote(plan.table)).join(", ");
}

/**
 * Load every source table into the target database and verify each one.
 * The caller supplies an {@link AsyncDb} whose schema was created by the
 * runtime migration path, and owns closing the connection.
 */
export async function loadSqliteToPostgres(
  db: AsyncDb,
  sources: readonly SqliteLoadSource[],
  options: SqliteLoadOptions = {},
): Promise<SqliteLoadReport> {
  const startedAt = Date.now();
  const progress = options.onProgress ?? (() => {});
  const excluded = new Set(options.excludeTables ?? []);
  const batchSize = options.batchSize ?? DEFAULT_BATCH_SIZE;
  const pageSize = options.checksumPageSize ?? DEFAULT_CHECKSUM_PAGE_SIZE;

  const allEntries = readSources(sources);
  const entries = [...allEntries.values()].sort((a, b) =>
    a.table.name.localeCompare(b.table.name),
  );
  const skippedTables = entries
    .filter((entry) => excluded.has(entry.table.name))
    .map((entry) => ({
      table: entry.table.name,
      reason: "excluded by the caller",
    }));
  const loadedEntries = entries.filter(
    (entry) => !excluded.has(entry.table.name),
  );
  const loadedNames = new Set(loadedEntries.map((entry) => entry.table.name));

  const target = await readTargetColumns(db);
  const overrides = typeOverrides();
  const { createdTables, addedColumns } = await reconcileSchema(
    db,
    loadedEntries,
    target,
    overrides,
    progress,
  );

  const plans = loadedEntries.map((entry) =>
    planTable(
      entry,
      target.get(entry.table.name) ?? [],
      createdTables,
      addedColumns,
    ),
  );

  for (const plan of plans) {
    progress(
      `table ${plan.table}: ${plan.columns.length} columns` +
        (plan.createdTable ? ", created" : "") +
        (plan.addedColumns.length > 0
          ? `, added ${plan.addedColumns.length} column(s)`
          : ""),
    );
  }

  const alreadyLoaded = await nonEmptyTargetTables(
    db,
    plans.map((plan) => plan.table),
  );
  if (alreadyLoaded.length > 0) {
    if (!options.force) {
      throw new Error(
        `target tables already contain rows: ${alreadyLoaded.join(", ")}; pass --force to truncate and reload`,
      );
    }
    await db.exec(`TRUNCATE TABLE ${quoteLoadedTables(plans)} CASCADE`);
    progress(
      `truncated ${alreadyLoaded.length} non-empty target table(s) (--force)`,
    );
  }

  const { order, hasCycle } = loadOrder(loadedEntries);
  if (hasCycle) {
    progress(
      "foreign-key cycle detected; constraints are dropped for the load and re-added after",
    );
  }
  const selfReferencing = selfReferencingTables(loadedEntries, loadedNames);
  const restoreForeignKeys = await relaxForeignKeys(
    db,
    loadedEntries,
    loadedNames,
    selfReferencing,
    hasCycle,
  );

  const planByName = new Map(plans.map((plan) => [plan.table, plan]));
  const results: TableLoadResult[] = [];
  const targetOnlyTables: string[] = [];

  try {
    for (const name of order) {
      const plan = planByName.get(name);
      if (!plan) {
        continue;
      }
      const tableStartedAt = Date.now();
      try {
        const { checksum: sourceChecksum, normalizations } =
          await loadTableRows(db, plan, batchSize);
        const targetChecksum = await checksumTargetTable(db, plan, pageSize);
        const checksumOk =
          sourceChecksum.rows === targetChecksum.rows &&
          sourceChecksum.sum === targetChecksum.sum &&
          sourceChecksum.xor === targetChecksum.xor;
        const result: TableLoadResult = {
          table: plan.table,
          slot: plan.slot,
          sourceRows: sourceChecksum.rows,
          targetRows: targetChecksum.rows,
          columns: plan.columns.map((column) => column.name),
          sourceChecksum: formatChecksum(sourceChecksum),
          targetChecksum: formatChecksum(targetChecksum),
          checksumOk,
          durationMs: Date.now() - tableStartedAt,
          createdTable: plan.createdTable,
          addedColumns: plan.addedColumns,
          normalizations,
        };
        results.push(result);
        progress(
          `${checksumOk ? "OK  " : "FAIL"} ${plan.table}: ` +
            `${result.sourceRows} source rows, ${result.targetRows} target rows, ` +
            `${result.durationMs}ms`,
        );
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        results.push({
          table: plan.table,
          slot: plan.slot,
          sourceRows: 0,
          targetRows: 0,
          columns: plan.columns.map((column) => column.name),
          sourceChecksum: "error",
          targetChecksum: "error",
          checksumOk: false,
          durationMs: Date.now() - tableStartedAt,
          createdTable: plan.createdTable,
          addedColumns: plan.addedColumns,
          normalizations: {
            nulBytesReplaced: 0,
            fractionalIntegersTruncated: 0,
          },
          error: message,
        });
        progress(`FAIL ${plan.table}: ${message}`);
      }
    }
  } finally {
    await restoreForeignKeys();
  }

  for (const name of target.keys()) {
    if (!loadedNames.has(name) && name !== "pg_schema_migrations") {
      targetOnlyTables.push(name);
    }
  }

  const failedTables = results.filter(
    (result) => result.error !== undefined || !result.checksumOk,
  ).length;
  const sourceRows = results.reduce(
    (total, result) => total + result.sourceRows,
    0,
  );
  const targetRows = results.reduce(
    (total, result) => total + result.targetRows,
    0,
  );
  const normalizations = results.reduce<NormalizationCounts>(
    (total, result) => ({
      nulBytesReplaced:
        total.nulBytesReplaced + result.normalizations.nulBytesReplaced,
      fractionalIntegersTruncated:
        total.fractionalIntegersTruncated +
        result.normalizations.fractionalIntegersTruncated,
    }),
    { nulBytesReplaced: 0, fractionalIntegersTruncated: 0 },
  );

  return {
    ok: failedTables === 0 && results.length === plans.length,
    tables: results,
    createdTables,
    addedColumns,
    skippedTables,
    targetOnlyTables: targetOnlyTables.sort(),
    totals: {
      tables: results.length,
      failedTables,
      sourceRows,
      targetRows,
      durationMs: Date.now() - startedAt,
      normalizations,
    },
  };
}
