/**
 * Tests for the async DB facade (`db-facade.ts`) - the single seam between the
 * data layer and Postgres.
 *
 * The backend under test must behave like the synchronous helpers it supersedes:
 * same rows, same changed-row counts, same transaction semantics; only the
 * calling convention is async. The suite runs against the process's Postgres
 * test schema, bootstrapped by `src/__tests__/pg-test-db.ts`.
 *
 * Gated on `VELLUM_PG_TEST_URL` (throwaway instance); with it unset the suite
 * skips.
 */

import { beforeAll, beforeEach, expect, test } from "bun:test";

import { describePg } from "../../__tests__/pg-test-db.js";
import {
  getAsyncDb,
  getMemoryAsyncDb,
  getTelemetryAsyncDb,
} from "../db-facade.js";
import { initializeDb } from "../db-init.js";

await initializeDb();

function telemetry() {
  const db = getTelemetryAsyncDb();
  if (!db) {
    throw new Error("telemetry facade unavailable");
  }
  return db;
}

/** Existence probe for a table in the active schema. */
const TABLE_EXISTS_SQL = `SELECT table_name AS name FROM information_schema.tables
  WHERE table_schema = current_schema() AND table_name = ?`;

beforeAll(async () => {
  await telemetry().exec(
    "CREATE TABLE IF NOT EXISTS facade_probe (id TEXT PRIMARY KEY, value BIGINT NOT NULL)",
  );
});

describePg("AsyncDb facade (postgres)", () => {
  beforeEach(async () => {
    await telemetry().run("DELETE FROM facade_probe");
  });

  test("slot is reported", () => {
    expect(telemetry().slot).toBe("telemetry");
  });

  test("main, memory, and telemetry resolve the same database", async () => {
    await telemetry().run(
      "INSERT INTO facade_probe (id, value) VALUES (?, ?)",
      ["shared", 1],
    );

    for (const db of [getAsyncDb(), getMemoryAsyncDb()]) {
      expect(db).not.toBeNull();
      const row = await db!.get<{ value: number }>(
        "SELECT value FROM facade_probe WHERE id = ?",
        ["shared"],
      );
      expect(row).toEqual({ value: 1 });
    }
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
    const row = await telemetry().get<{ name: string }>(TABLE_EXISTS_SQL, [
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

  test("accessors return null when no connection URL is configured", () => {
    const saved = process.env.VELLUM_DATABASE_URL;
    process.env.VELLUM_DATABASE_URL = "";
    try {
      expect(getAsyncDb()).toBeNull();
      expect(getMemoryAsyncDb()).toBeNull();
      expect(getTelemetryAsyncDb()).toBeNull();
    } finally {
      if (saved === undefined) {
        delete process.env.VELLUM_DATABASE_URL;
      } else {
        process.env.VELLUM_DATABASE_URL = saved;
      }
    }
  });
});
