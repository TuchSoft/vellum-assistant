/**
 * Loader conformance: SQLite fixture -> the isolated Postgres test schema.
 *
 * The fixture covers the value mappings the port depends on: epoch-ms
 * integers as `bigint`, 0/1 as `boolean`, BLOBs as `bytea`, JSON kept as
 * text, NULLs preserved, and a table and columns that only exist because the
 * runtime creates them after the baseline (`conversation_groups`).
 */

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Database } from "bun:sqlite";
import { afterAll, beforeEach, expect, test } from "bun:test";

import { describePg } from "../../../__tests__/pg-test-db.js";
import { requireMainDb } from "../../db-facade.js";
import { loadSqliteToPostgres } from "../sqlite-loader.js";

const roots: string[] = [];

function tempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), "vellum-sqlite-loader-test-"));
  roots.push(dir);
  return dir;
}

function fixtureDb(fileName = "assistant.db"): string {
  const path = join(tempDir(), fileName);
  const db = new Database(path);
  db.exec(`
    CREATE TABLE app_pins (
      app_id TEXT PRIMARY KEY,
      sort_position REAL NOT NULL,
      color TEXT,
      created_at INTEGER NOT NULL
    );
    CREATE TABLE watch_timeline_entries (
      id TEXT PRIMARY KEY,
      session_id TEXT NOT NULL,
      conversation_id TEXT NOT NULL,
      at_ms INTEGER NOT NULL,
      kind TEXT NOT NULL,
      text TEXT NOT NULL,
      ax_tree TEXT,
      ax_diff TEXT,
      created_at INTEGER NOT NULL,
      screenshot BLOB
    );
    CREATE TABLE client_connection_events (
      id TEXT PRIMARY KEY,
      client_id TEXT NOT NULL,
      interface_id TEXT NOT NULL,
      connection_id TEXT NOT NULL,
      reason TEXT NOT NULL,
      occurred_at INTEGER NOT NULL,
      actor_principal_id TEXT,
      client_version TEXT,
      sse_watchdog INTEGER,
      machine_name TEXT
    );
    CREATE TABLE conversation_groups (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      icon TEXT,
      sort_position REAL NOT NULL DEFAULT 0,
      is_system_group BOOLEAN NOT NULL DEFAULT FALSE,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL
    );
  `);

  const pin = db.query(
    "INSERT INTO app_pins (app_id, sort_position, color, created_at) VALUES (?, ?, ?, ?)",
  );
  pin.run("app-1", 1.5, null, 1_700_000_000_000);
  pin.run("app-2", -2.25, "red", 1_700_000_000_001);

  const timeline = db.query(
    "INSERT INTO watch_timeline_entries (id, session_id, conversation_id, at_ms, kind, text, ax_tree, ax_diff, created_at, screenshot) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
  );
  timeline.run(
    "entry-1",
    "session-1",
    "conv-1",
    1_700_000_000_100,
    "click",
    "line one\nline two \u00e8 \u{1f680}",
    '{"tree":1}',
    null,
    1_700_000_000_100,
    new Uint8Array([0, 1, 2, 255]),
  );
  timeline.run(
    "entry-2",
    "session-1",
    "conv-1",
    1_700_000_000_101,
    "note",
    "plain",
    null,
    null,
    1_700_000_000_101,
    null,
  );

  const connection = db.query(
    "INSERT INTO client_connection_events (id, client_id, interface_id, connection_id, reason, occurred_at, actor_principal_id, client_version, sse_watchdog, machine_name) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
  );
  connection.run(
    "evt-1",
    "c1",
    "web",
    "conn-1",
    "open",
    1,
    null,
    null,
    1,
    null,
  );
  connection.run(
    "evt-2",
    "c1",
    "web",
    "conn-1",
    "close",
    2,
    "user-123",
    "1.0",
    0,
    null,
  );
  connection.run(
    "evt-3",
    "c2",
    "cli",
    "conn-2",
    "open",
    3,
    null,
    null,
    null,
    "machine-1",
  );

  const groups = db.query(
    "INSERT INTO conversation_groups (id, name, icon, sort_position, is_system_group, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)",
  );
  groups.run("system:all", "Recents", null, 3, 1, 10, 10);
  groups.run("custom-1", "\u00c8lite", "star", 4, 0, 11, 11);

  db.close();
  return path;
}

async function resetTarget(): Promise<void> {
  const db = requireMainDb();
  for (const table of [
    "app_pins",
    "watch_timeline_entries",
    "client_connection_events",
    "conversation_groups",
  ]) {
    await db.exec(`DROP TABLE IF EXISTS "${table}" CASCADE`);
  }
  await db.exec(`DROP TABLE IF EXISTS pg_schema_migrations`);
}

describePg("SQLite -> Postgres loader", () => {
  beforeEach(async () => {
    await resetTarget();
  });

  afterAll(() => {
    for (const root of roots.splice(0)) {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("loads every table and verifies the checksums", async () => {
    const path = fixtureDb();
    const db = requireMainDb();

    const report = await loadSqliteToPostgres(db, [{ slot: "main", path }]);

    expect(
      report.tables
        .filter((table) => table.error !== undefined || !table.checksumOk)
        .map((table) => ({
          table: table.table,
          error: table.error,
          source: table.sourceChecksum,
          target: table.targetChecksum,
        })),
    ).toEqual([]);
    expect(report.ok).toBe(true);
    expect(report.totals.tables).toBe(4);
    expect(report.totals.failedTables).toBe(0);
    expect(report.totals.sourceRows).toBe(9);
    expect(report.totals.targetRows).toBe(9);
    expect(report.createdTables).toContain("conversation_groups");
    for (const table of report.tables) {
      expect(table.checksumOk).toBe(true);
      expect(table.sourceRows).toBe(table.targetRows);
    }

    const pins = await db.all<{ app_id: string; color: string | null }>(
      "SELECT app_id, color FROM app_pins ORDER BY app_id",
    );
    expect(pins).toEqual([
      { app_id: "app-1", color: null },
      { app_id: "app-2", color: "red" },
    ]);

    const watchdog = await db.all<{ id: string; sse_watchdog: boolean | null }>(
      "SELECT id, sse_watchdog FROM client_connection_events ORDER BY id",
    );
    expect(watchdog).toEqual([
      { id: "evt-1", sse_watchdog: true },
      { id: "evt-2", sse_watchdog: false },
      { id: "evt-3", sse_watchdog: null },
    ]);

    const screenshot = await db.get<{ screenshot: Uint8Array | null }>(
      "SELECT screenshot FROM watch_timeline_entries WHERE id = 'entry-1'",
    );
    expect(Buffer.from(screenshot!.screenshot!).toString("hex")).toBe(
      "000102ff",
    );

    const groups = await db.all<{ id: string; is_system_group: boolean }>(
      "SELECT id, is_system_group FROM conversation_groups ORDER BY id",
    );
    expect(groups).toEqual([
      { id: "custom-1", is_system_group: false },
      { id: "system:all", is_system_group: true },
    ]);
  });

  test("refuses a non-empty target without --force", async () => {
    const path = fixtureDb();
    const db = requireMainDb();
    await loadSqliteToPostgres(db, [{ slot: "main", path }]);

    await expect(
      loadSqliteToPostgres(db, [{ slot: "main", path }]),
    ).rejects.toThrow(/already contain rows/);
  });

  test("--force truncates and reloads without duplicating rows", async () => {
    const path = fixtureDb();
    const db = requireMainDb();
    await loadSqliteToPostgres(db, [{ slot: "main", path }]);

    const report = await loadSqliteToPostgres(db, [{ slot: "main", path }], {
      force: true,
    });

    expect(report.ok).toBe(true);
    const row = await db.get<{ count: string | number }>(
      "SELECT COUNT(*) AS count FROM client_connection_events",
    );
    expect(Number(row?.count)).toBe(3);
  });

  test("refuses two source databases that define the same table", async () => {
    const first = fixtureDb("assistant.db");
    const second = fixtureDb("assistant-memory.db");
    const db = requireMainDb();

    await expect(
      loadSqliteToPostgres(db, [
        { slot: "main", path: first },
        { slot: "memory", path: second },
      ]),
    ).rejects.toThrow(/appears in both main/);
  });
});
