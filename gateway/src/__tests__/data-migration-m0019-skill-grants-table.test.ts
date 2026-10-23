/**
 * Tests for m0019-skill-grants-table.
 *
 * Verifies the migration is registered after m0018 (with m0020 after it),
 * recreates the table and its unique index when they are missing, is
 * idempotent (a second run is a no-op that keeps existing grants), and that
 * `down()` leaves the store intact.
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
  down as m0019Down,
  up as m0019Up,
} from "../db/data-migrations/m0019-skill-grants-table.js";

function rawDb() {
  return (
    getGatewayDb() as unknown as { $client: import("bun:sqlite").Database }
  ).$client;
}

function tableExists(): boolean {
  return (
    rawDb()
      .prepare(
        "SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'skill_grants'",
      )
      .get() !== null
  );
}

function indexNames(): string[] {
  return (
    rawDb().prepare("PRAGMA index_list('skill_grants')").all() as Array<{
      name: string;
      unique: number;
    }>
  ).map((row) => row.name);
}

function grantCount(): number {
  const row = rawDb()
    .prepare("SELECT COUNT(*) AS n FROM skill_grants")
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

describe("m0019-skill-grants-table", () => {
  test("is registered after m0018", () => {
    const keys = MIGRATIONS.map((migration) => migration.key);

    expect(keys.indexOf("m0019-skill-grants-table")).toBe(
      keys.indexOf("m0018-trust-rules-scope-column") + 1,
    );
  });

  test("recreates the table and its unique index when missing", () => {
    rawDb().exec("DROP TABLE IF EXISTS skill_grants");
    expect(tableExists()).toBe(false);

    expect(m0019Up()).toBe("done");

    expect(tableExists()).toBe(true);
    expect(indexNames()).toContain("idx_skill_grants_skill_version");
  });

  test("is idempotent and preserves existing grants", () => {
    rawDb()
      .prepare(
        `INSERT INTO skill_grants
           (skill_id, version_hash, capabilities_json, granted_by, created_at, updated_at)
         VALUES ('long-run', 'hash-1', '["host_exec"]', NULL, 1, 1)`,
      )
      .run();

    expect(m0019Up()).toBe("done");
    expect(m0019Up()).toBe("done");

    expect(grantCount()).toBe(1);
    expect(indexNames()).toContain("idx_skill_grants_skill_version");
  });

  test("enforces one grant per skill version", () => {
    expect(() =>
      rawDb()
        .prepare(
          `INSERT INTO skill_grants
             (skill_id, version_hash, capabilities_json, granted_by, created_at, updated_at)
           VALUES ('long-run', 'hash-1', '[]', NULL, 2, 2)`,
        )
        .run(),
    ).toThrow();
  });

  test("down() leaves the store intact", () => {
    expect(m0019Down()).toBe("done");
    expect(tableExists()).toBe(true);
    expect(grantCount()).toBe(1);
  });
});
