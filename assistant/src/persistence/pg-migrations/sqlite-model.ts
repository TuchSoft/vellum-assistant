/**
 * SQLite schema introspection for the Postgres baseline.
 *
 * Reads the *effective* schema of a live SQLite database — the DDL that the
 * migration chain actually produced — rather than the Drizzle `schema/*.ts`
 * files, which are a subset of the live tables. The result is a neutral model
 * that `baseline.ts` translates to Postgres DDL.
 *
 * Introspection is synchronous (`bun:sqlite`), which is fine: it runs once, at
 * baseline-generation time, against a file.
 */

import type { Database } from "bun:sqlite";

export interface SqliteColumn {
  name: string;
  /** Declared type as written in the DDL (may be empty for typeless columns). */
  declaredType: string;
  notNull: boolean;
  /** Raw SQL default expression, or null. */
  defaultValue: string | null;
  /** 1-based ordinal within the primary key, or 0 when not part of it. */
  pkOrdinal: number;
}

export interface SqliteIndex {
  name: string;
  unique: boolean;
  columns: string[];
}

export interface SqliteForeignKey {
  columns: string[];
  refTable: string;
  refColumns: string[];
  onDelete: string | null;
}

export interface SqliteTable {
  name: string;
  columns: SqliteColumn[];
  indexes: SqliteIndex[];
  foreignKeys: SqliteForeignKey[];
}

export interface SqliteSchema {
  tables: SqliteTable[];
}

const IDENTIFIER = /^[A-Za-z_][A-Za-z0-9_]*$/;

/** Quote an identifier, refusing anything that is not a plain identifier. */
function quoteIdentifier(name: string): string {
  if (!IDENTIFIER.test(name)) {
    throw new Error(`refusing to introspect unsafe identifier: ${name}`);
  }
  return `"${name}"`;
}

interface RawColumn {
  name: string;
  type: string;
  notnull: number;
  dflt_value: string | null;
  pk: number;
}

interface RawIndex {
  name: string;
  unique: number;
  origin: string;
}

interface RawIndexColumn {
  seqno: number;
  name: string | null;
}

interface RawForeignKey {
  id: number;
  seq: number;
  table: string;
  from: string;
  to: string | null;
  on_delete: string;
}

/**
 * Introspect every user table (excluding SQLite internals) into a
 * {@link SqliteSchema}, in `sqlite_master` name order.
 */
export function introspectSqlite(db: Database): SqliteSchema {
  const tableNames = (
    db
      .query(
        `SELECT name FROM sqlite_master
         WHERE type = 'table' AND name NOT LIKE 'sqlite_%'
         ORDER BY name`,
      )
      .all() as Array<{ name: string }>
  ).map((row) => row.name);

  const tables: SqliteTable[] = [];
  for (const name of tableNames) {
    const ident = quoteIdentifier(name);
    const columns = (
      db.query(`PRAGMA table_info(${ident})`).all() as RawColumn[]
    ).map((column) => ({
      name: column.name,
      declaredType: column.type ?? "",
      notNull: column.notnull === 1,
      defaultValue: column.dflt_value,
      pkOrdinal: column.pk ?? 0,
    }));

    // Indexes: skip the implicit primary-key index (`origin = 'pk'`) and any
    // index with an expression column (name null) — the drizzle schema does not
    // produce them, and their DDL cannot be reconstructed from index_info.
    const indexes: SqliteIndex[] = [];
    for (const index of db
      .query(`PRAGMA index_list(${ident})`)
      .all() as RawIndex[]) {
      if (index.origin === "pk") {
        continue;
      }
      const indexColumns = (
        db
          .query(`PRAGMA index_info(${quoteIdentifier(index.name)})`)
          .all() as RawIndexColumn[]
      )
        .sort((a, b) => a.seqno - b.seqno)
        .map((row) => row.name);
      if (indexColumns.some((column) => column === null)) {
        continue;
      }
      indexes.push({
        name: index.name,
        unique: index.unique === 1,
        columns: indexColumns as string[],
      });
    }

    const foreignKeyRows = db
      .query(`PRAGMA foreign_key_list(${ident})`)
      .all() as RawForeignKey[];
    const byId = new Map<number, RawForeignKey[]>();
    for (const row of foreignKeyRows) {
      const group = byId.get(row.id) ?? [];
      group.push(row);
      byId.set(row.id, group);
    }
    const foreignKeys: SqliteForeignKey[] = [...byId.values()].map((group) => {
      const ordered = [...group].sort((a, b) => a.seq - b.seq);
      return {
        columns: ordered.map((row) => row.from),
        refTable: ordered[0]!.table,
        refColumns: ordered.map((row) => row.to ?? ""),
        onDelete: ordered[0]!.on_delete?.toUpperCase() ?? null,
      };
    });

    tables.push({ name, columns, indexes, foreignKeys });
  }

  return { tables };
}
