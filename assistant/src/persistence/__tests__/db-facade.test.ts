/**
 * Tests for the async DB facade (`db-facade.ts`) — the driver-agnostic seam
 * that the DB port colors the codebase against. The backend under test must
 * behave like the synchronous helpers it wraps: same rows, same changed-row
 * counts, same transaction semantics; only the calling convention is async.
 *
 * Runs against whichever backend the telemetry slot is configured for (SQLite
 * by default, Postgres with `VELLUM_TELEMETRY_DB_BACKEND=postgres`), so the
 * probe uses dialect-neutral DDL and a per-dialect existence probe.
 */

import { beforeAll, beforeEach, describe, expect, test } from "bun:test";

import { getAsyncDb, getTelemetryAsyncDb } from "../db-facade.js";
import { initializeDb } from "../db-init.js";

await initializeDb();

const isPostgres =
  (process.env.VELLUM_TELEMETRY_DB_BACKEND ?? process.env.VELLUM_DB_BACKEND) ===
  "postgres";
const INT_TYPE = isPostgres ? "BIGINT" : "INTEGER";

/** Dialect-appropriate existence probe for a table by name. */
function tableExistsSql(): string {
  return isPostgres
    ? `SELECT table_name AS name FROM information_schema.tables
       WHERE table_schema = 'public' AND table_name = ?`
    : `SELECT name FROM sqlite_master WHERE type = 'table' AND name = ?`;
}

function telemetry() {
  const db = getTelemetryAsyncDb();
  if (!db) {
    throw new Error("telemetry facade unavailable");
  }
  return db;
}

beforeAll(async () => {
  await telemetry().exec(
    `CREATE TABLE IF NOT EXISTS facade_probe (id TEXT PRIMARY KEY, value ${INT_TYPE} NOT NULL)`,
  );
});

describe("AsyncDb facade", () => {
  beforeEach(async () => {
    await telemetry().run("DELETE FROM facade_probe");
  });

  test("slot is reported", () => {
    expect(telemetry().slot).toBe("telemetry");
  });

  test("run returns the changed-row count", async () => {
    const inserted = await telemetry().run(
      "INSERT INTO facade_probe (id, value) VALUES (?, ?)",
      ["a", 1],
    );
    expect(inserted).toBe(1);

    const updated = await telemetry().run(
      "UPDATE facade_probe SET value = ? WHERE id = ?",
      [2, "a"],
    );
    expect(updated).toBe(1);

    const deleted = await telemetry().run(
      "DELETE FROM facade_probe WHERE id IN (?, ?)",
      ["a", "missing"],
    );
    expect(deleted).toBe(1);
  });

  test("all returns every row; get returns the first or null", async () => {
    await telemetry().run(
      "INSERT INTO facade_probe (id, value) VALUES (?, ?), (?, ?)",
      ["a", 1, "b", 2],
    );

    const rows = await telemetry().all<{ id: string; value: number }>(
      "SELECT id, value FROM facade_probe ORDER BY id",
    );
    expect(rows).toEqual([
      { id: "a", value: 1 },
      { id: "b", value: 2 },
    ]);

    const one = await telemetry().get<{ value: number }>(
      "SELECT value FROM facade_probe WHERE id = ?",
      ["b"],
    );
    expect(one).toEqual({ value: 2 });

    const none = await telemetry().get(
      "SELECT value FROM facade_probe WHERE id = ?",
      ["missing"],
    );
    expect(none).toBeNull();
  });

  test("all resolves to [] when nothing matches", async () => {
    expect(await telemetry().all("SELECT * FROM facade_probe")).toEqual([]);
  });

  test("exec runs DDL without bindings", async () => {
    await telemetry().exec(
      "CREATE TABLE IF NOT EXISTS facade_probe_ddl (id TEXT PRIMARY KEY)",
    );
    const row = await telemetry().get<{ name: string }>(tableExistsSql(), [
      "facade_probe_ddl",
    ]);
    expect(row).toEqual({ name: "facade_probe_ddl" });
    await telemetry().exec("DROP TABLE IF EXISTS facade_probe_ddl");
  });

  test("label returns a facade that still executes", async () => {
    const n = await telemetry()
      .label("test:facade")
      .run("INSERT INTO facade_probe (id, value) VALUES (?, ?)", [
        "labelled",
        9,
      ]);
    expect(n).toBe(1);
  });

  test("transaction commits on resolve", async () => {
    await telemetry().transaction(async (tx) => {
      await tx.run("INSERT INTO facade_probe (id, value) VALUES (?, ?)", [
        "t1",
        1,
      ]);
      await tx.run("INSERT INTO facade_probe (id, value) VALUES (?, ?)", [
        "t2",
        2,
      ]);
    });
    const rows = await telemetry().all(
      "SELECT id FROM facade_probe ORDER BY id",
    );
    expect(rows).toEqual([{ id: "t1" }, { id: "t2" }]);
  });

  test("transaction rolls back on throw", async () => {
    await expect(
      telemetry().transaction(async (tx) => {
        await tx.run("INSERT INTO facade_probe (id, value) VALUES (?, ?)", [
          "boom",
          1,
        ]);
        throw new Error("rollback");
      }),
    ).rejects.toThrow("rollback");
    expect(await telemetry().all("SELECT id FROM facade_probe")).toEqual([]);
  });

  test("getAsyncDb exposes the main connection", async () => {
    const db = getAsyncDb();
    expect(db).not.toBeNull();
    const row = await db!.get<{ one: number }>("SELECT 1 AS one");
    expect(row).toEqual({ one: 1 });
  });
});
