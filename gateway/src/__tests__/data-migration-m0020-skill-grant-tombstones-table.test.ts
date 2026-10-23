/**
 * Tests for m0020-skill-grant-tombstones-table.
 *
 * Verifies the migration is registered after m0019, recreates the tombstone
 * table and its unique index when they are missing, is idempotent (a second run
 * keeps existing tombstones), and that `down()` leaves the store intact.
 */

import { afterAll, beforeAll, describe, expect, test } from "bun:test";

import "./test-preload.js";
import {
  getGatewayDb,
  initGatewayDb,
  resetGatewayDb,
} from "../db/connection.js";
import { MIGRATIONS } from "../db/data-migrations/index.js";
import {
  down as m0020Down,
  up as m0020Up,
} from "../db/data-migrations/m0020-skill-grant-tombstones-table.js";

function rawDb() {
  return (
    getGatewayDb() as unknown as { $client: import("bun:sqlite").Database }
  ).$client;
}

function tableExists(): boolean {
  return (
    rawDb()
      .prepare(
        "SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'skill_grant_tombstones'",
      )
      .get() !== null
  );
}

function indexNames(): string[] {
  return (
    rawDb()
      .prepare("PRAGMA index_list('skill_grant_tombstones')")
      .all() as Array<{
      name: string;
      unique: number;
    }>
  ).map((row) => row.name);
}

function tombstoneCount(): number {
  const row = rawDb()
    .prepare("SELECT COUNT(*) AS n FROM skill_grant_tombstones")
    .get() as { n: number };
  return row.n;
}

beforeAll(async () => {
  resetGatewayDb();
  await initGatewayDb();
});

afterAll(() => {
  resetGatewayDb();
});

describe("m0020-skill-grant-tombstones-table", () => {
  test("is registered after m0019", () => {
    const keys = MIGRATIONS.map((migration) => migration.key);

    expect(keys.at(-1)).toBe("m0020-skill-grant-tombstones-table");
    expect(keys.indexOf("m0020-skill-grant-tombstones-table")).toBe(
      keys.indexOf("m0019-skill-grants-table") + 1,
    );
  });

  test("recreates the table and its unique index when missing", () => {
    rawDb().exec("DROP TABLE IF EXISTS skill_grant_tombstones");
    expect(tableExists()).toBe(false);

    expect(m0020Up()).toBe("done");

    expect(tableExists()).toBe(true);
    expect(indexNames()).toContain("idx_skill_grant_tombstones_skill_version");
  });

  test("is idempotent and preserves existing tombstones", () => {
    rawDb()
      .prepare(
        "INSERT INTO skill_grant_tombstones (skill_id, version_hash, revoked_at) VALUES (?, ?, ?)",
      )
      .run("long-run", "hash-1", Date.now());
    expect(tombstoneCount()).toBe(1);

    expect(m0020Up()).toBe("done");
    expect(tombstoneCount()).toBe(1);
  });

  test("down() leaves the tombstones intact", () => {
    expect(m0020Down()).toBe("done");
    expect(tableExists()).toBe(true);
    expect(tombstoneCount()).toBe(1);
  });
});
