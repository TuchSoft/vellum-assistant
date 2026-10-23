/**
 * Tests for the skill capability grant store.
 *
 * Covers the CRUD surface, the normalization applied on write and read, and
 * the fail-closed read path: a row whose payload cannot be parsed grants
 * nothing, and an unreadable store resolves to an empty list rather than
 * throwing.
 */

import { afterEach, beforeEach, describe, expect, it } from "bun:test";

import "../../__tests__/test-preload.js";
import { getGatewayDb, initGatewayDb, resetGatewayDb } from "../connection.js";
import { skillGrants } from "../schema.js";
import {
  deleteSkillGrant,
  getSkillGrant,
  listSkillGrants,
  listSkillGrantsSafe,
  normalizeSkillCapabilities,
  upsertSkillGrant,
} from "../skill-grant-store.js";

function rawDb() {
  return (
    getGatewayDb() as unknown as { $client: import("bun:sqlite").Database }
  ).$client;
}

beforeEach(async () => {
  resetGatewayDb();
  await initGatewayDb();
  getGatewayDb().delete(skillGrants).run();
});

afterEach(() => {
  resetGatewayDb();
});

describe("normalizeSkillCapabilities", () => {
  it("drops duplicates and orders capabilities canonically", () => {
    expect(
      normalizeSkillCapabilities([
        "vetted",
        "host_exec",
        "vetted",
        "computer_use_target",
      ]),
    ).toEqual(["host_exec", "vetted", "computer_use_target"]);
  });

  it("returns an empty list for an empty input", () => {
    expect(normalizeSkillCapabilities([])).toEqual([]);
  });
});

describe("skill grant store", () => {
  it("starts empty", () => {
    expect(listSkillGrants()).toEqual([]);
    expect(getSkillGrant("long-run", "hash-1")).toBeNull();
    expect(listSkillGrantsSafe()).toEqual([]);
  });

  it("records a grant and reads it back", () => {
    const grant = upsertSkillGrant({
      skillId: "long-run",
      versionHash: "hash-1",
      capabilities: ["host_exec"],
      grantedBy: "guardian-1",
    });

    expect(grant.skillId).toBe("long-run");
    expect(grant.versionHash).toBe("hash-1");
    expect(grant.capabilities).toEqual(["host_exec"]);
    expect(grant.grantedBy).toBe("guardian-1");
    expect(grant.createdAt).toBeGreaterThan(0);
    expect(grant.updatedAt).toBe(grant.createdAt);

    expect(getSkillGrant("long-run", "hash-1")?.capabilities).toEqual([
      "host_exec",
    ]);
    expect(listSkillGrants()).toHaveLength(1);
  });

  it("replaces the grant for the same skill version instead of accumulating", () => {
    upsertSkillGrant({
      skillId: "long-run",
      versionHash: "hash-1",
      capabilities: ["host_exec", "vetted"],
    });
    upsertSkillGrant({
      skillId: "long-run",
      versionHash: "hash-1",
      capabilities: ["input_repairs"],
    });

    const grants = listSkillGrants();
    expect(grants).toHaveLength(1);
    expect(grants[0]?.capabilities).toEqual(["input_repairs"]);
  });

  it("keeps different versions of the same skill independent", () => {
    upsertSkillGrant({
      skillId: "long-run",
      versionHash: "hash-1",
      capabilities: ["host_exec"],
    });
    upsertSkillGrant({
      skillId: "long-run",
      versionHash: "hash-2",
      capabilities: ["vetted"],
    });

    expect(listSkillGrants({ skillId: "long-run" })).toHaveLength(2);
    expect(getSkillGrant("long-run", "hash-1")?.capabilities).toEqual([
      "host_exec",
    ]);
    expect(getSkillGrant("long-run", "hash-2")?.capabilities).toEqual([
      "vetted",
    ]);
  });

  it("filters by skill id and version hash", () => {
    upsertSkillGrant({
      skillId: "long-run",
      versionHash: "hash-1",
      capabilities: ["host_exec"],
    });
    upsertSkillGrant({
      skillId: "other-skill",
      versionHash: "hash-1",
      capabilities: ["vetted"],
    });

    expect(
      listSkillGrants({ versionHash: "hash-1" }).map((g) => g.skillId),
    ).toEqual(["long-run", "other-skill"]);
    expect(
      listSkillGrants({ skillId: "other-skill", versionHash: "missing" }),
    ).toEqual([]);
  });

  it("reports whether a delete removed a grant", () => {
    upsertSkillGrant({
      skillId: "long-run",
      versionHash: "hash-1",
      capabilities: ["host_exec"],
    });

    expect(deleteSkillGrant("long-run", "hash-1")).toBe(true);
    expect(deleteSkillGrant("long-run", "hash-1")).toBe(false);
    expect(listSkillGrants()).toEqual([]);
  });

  it("enforces one grant per skill version in the database", () => {
    upsertSkillGrant({
      skillId: "long-run",
      versionHash: "hash-1",
      capabilities: ["host_exec"],
    });

    expect(() =>
      rawDb()
        .prepare(
          `INSERT INTO skill_grants
             (skill_id, version_hash, capabilities_json, granted_by, created_at, updated_at)
           VALUES ('long-run', 'hash-1', '[]', NULL, 1, 1)`,
        )
        .run(),
    ).toThrow();
  });

  it("reads an unparsable capabilities payload as no capabilities", () => {
    rawDb()
      .prepare(
        `INSERT INTO skill_grants
           (skill_id, version_hash, capabilities_json, granted_by, created_at, updated_at)
         VALUES ('long-run', 'hash-1', 'not json', NULL, 1, 1)`,
      )
      .run();

    const grant = getSkillGrant("long-run", "hash-1");
    expect(grant).not.toBeNull();
    expect(grant?.capabilities).toEqual([]);
  });

  it("reads an unknown capability name as no capabilities", () => {
    rawDb()
      .prepare(
        `INSERT INTO skill_grants
           (skill_id, version_hash, capabilities_json, granted_by, created_at, updated_at)
         VALUES ('long-run', 'hash-1', '["host_exec","future_capability"]', NULL, 1, 1)`,
      )
      .run();

    expect(getSkillGrant("long-run", "hash-1")?.capabilities).toEqual([]);
  });

  it("fails closed when the store is unreadable", async () => {
    upsertSkillGrant({
      skillId: "long-run",
      versionHash: "hash-1",
      capabilities: ["host_exec"],
    });

    rawDb().exec("DROP TABLE skill_grants");

    expect(listSkillGrantsSafe()).toEqual([]);
    expect(listSkillGrantsSafe({ skillId: "long-run" })).toEqual([]);
    expect(() => listSkillGrants()).toThrow();

    // Restore the table for the tests that follow in this file.
    resetGatewayDb();
    await initGatewayDb();
  });
});
