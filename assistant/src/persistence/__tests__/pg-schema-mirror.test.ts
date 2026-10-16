/**
 * The Postgres schema mirror (`pg-schema/`) must stay structurally identical to
 * the SQLite schema (`schema/`): same table names, same column names in the
 * same order. Table/column types intentionally differ (that is the point of the
 * mirror), so only structure is asserted here. A drift means a pgTable edit
 * forgot to mirror a sqliteTable edit (or vice versa).
 */
import { describe, expect, test } from "bun:test";

import { getTableColumns, getTableName, is, Table } from "drizzle-orm";

import * as pgSchema from "../pg-schema/index.js";
import * as sqliteSchema from "../schema/index.js";

function tableCatalog(mod: Record<string, unknown>) {
  const catalog = new Map<string, string[]>();
  for (const value of Object.values(mod)) {
    if (!is(value, Table)) {
      continue;
    }
    const name = getTableName(value);
    const columns = Object.values(getTableColumns(value)).map((c) => c.name);
    catalog.set(name, columns);
  }
  return catalog;
}

const sqlite = tableCatalog(sqliteSchema as Record<string, unknown>);
const pg = tableCatalog(pgSchema as Record<string, unknown>);

describe("pg-schema mirror parity", () => {
  test("every pgTable has a same-named sqliteTable", () => {
    const missing = [...pg.keys()].filter((name) => !sqlite.has(name)).sort();
    expect(missing).toEqual([]);
  });

  test("every sqliteTable is mirrored as a pgTable", () => {
    const missing = [...sqlite.keys()].filter((name) => !pg.has(name)).sort();
    expect(missing).toEqual([]);
  });

  test("each mirrored table has the same columns, in order", () => {
    const mismatches: Array<{ table: string; sqlite: string[]; pg: string[] }> =
      [];
    for (const [name, sqliteColumns] of sqlite) {
      const pgColumns = pg.get(name);
      if (!pgColumns) {
        continue;
      }
      if (JSON.stringify(pgColumns) !== JSON.stringify(sqliteColumns)) {
        mismatches.push({ table: name, sqlite: sqliteColumns, pg: pgColumns });
      }
    }
    expect(mismatches).toEqual([]);
  });
});
