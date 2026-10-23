/**
 * Tests for the skill grant seed.
 *
 * The seed is what makes the gate deployable: without it every capability a
 * skill asks for is denied. The cases below are the ones that decide whether
 * that is safe — a fresh database gets the defaults, a decision already on the
 * record is never overwritten, a revoked version stays revoked, and a new
 * version of a skill is treated as a new decision.
 */

import { readFileSync, rmSync, writeFileSync } from "node:fs";

import { afterEach, beforeEach, describe, expect, test } from "bun:test";

import "../../__tests__/test-preload.js";
import { getGatewayDb, initGatewayDb, resetGatewayDb } from "../connection.js";
import { skillGrants, skillGrantTombstones } from "../schema.js";
import {
  _resetSkillGrantDefaultsCacheForTest,
  BUILTIN_SKILL_GRANT_DEFAULTS,
  getSkillGrantDefaultsPath,
  loadSkillGrantDefaults,
} from "../skill-grant-defaults.js";
import {
  DEFAULT_GRANT_PRINCIPAL,
  seedSkillGrantsFromDefaults,
} from "../skill-grant-seed.js";
import {
  deleteSkillGrant,
  getSkillGrant,
  listSkillGrants,
  listSkillGrantTombstones,
  upsertSkillGrant,
} from "../skill-grant-store.js";

function writeDefaults(document: unknown): void {
  writeFileSync(getSkillGrantDefaultsPath(), JSON.stringify(document), "utf-8");
  _resetSkillGrantDefaultsCacheForTest();
}

beforeEach(async () => {
  resetGatewayDb();
  await initGatewayDb();
  getGatewayDb().delete(skillGrants).run();
  getGatewayDb().delete(skillGrantTombstones).run();
  rmSync(getSkillGrantDefaultsPath(), { force: true });
  _resetSkillGrantDefaultsCacheForTest();
});

afterEach(() => {
  resetGatewayDb();
  rmSync(getSkillGrantDefaultsPath(), { force: true });
  _resetSkillGrantDefaultsCacheForTest();
});

describe("seedSkillGrantsFromDefaults", () => {
  test("seeds a declared version from the defaults document", () => {
    writeDefaults({ "long-run": ["host_exec", "vetted"] });

    const result = seedSkillGrantsFromDefaults([
      { skillId: "long-run", versionHash: "hash-1" },
    ]);

    expect(result.seeded).toEqual([
      {
        skillId: "long-run",
        versionHash: "hash-1",
        capabilities: ["host_exec", "vetted"],
      },
    ]);
    expect(result.skipped).toEqual([]);

    const grant = getSkillGrant("long-run", "hash-1");
    expect(grant?.capabilities).toEqual(["host_exec", "vetted"]);
    expect(grant?.grantedBy).toBe(DEFAULT_GRANT_PRINCIPAL);
  });

  test("leaves a skill with no default entry unseeded", () => {
    writeDefaults({ "long-run": ["host_exec"] });

    const result = seedSkillGrantsFromDefaults([
      { skillId: "unlisted", versionHash: "hash-1" },
    ]);

    expect(result.seeded).toEqual([]);
    expect(result.skipped).toEqual([
      { skillId: "unlisted", versionHash: "hash-1", reason: "no_default" },
    ]);
    expect(listSkillGrants()).toEqual([]);
  });

  test("never overwrites a grant that is already on the record", () => {
    writeDefaults({ "long-run": ["host_exec", "vetted"] });
    upsertSkillGrant({
      skillId: "long-run",
      versionHash: "hash-1",
      capabilities: ["input_repairs"],
      grantedBy: "user-123",
    });

    const result = seedSkillGrantsFromDefaults([
      { skillId: "long-run", versionHash: "hash-1" },
    ]);

    expect(result.seeded).toEqual([]);
    expect(result.skipped).toEqual([
      { skillId: "long-run", versionHash: "hash-1", reason: "existing" },
    ]);

    const grant = getSkillGrant("long-run", "hash-1");
    expect(grant?.capabilities).toEqual(["input_repairs"]);
    expect(grant?.grantedBy).toBe("user-123");
  });

  test("does not resurrect a revoked version, but seeds the next one", () => {
    writeDefaults({ "long-run": ["host_exec"] });

    seedSkillGrantsFromDefaults([
      { skillId: "long-run", versionHash: "hash-1" },
    ]);
    expect(deleteSkillGrant("long-run", "hash-1")).toBe(true);
    expect(listSkillGrantTombstones()).toEqual([
      {
        skillId: "long-run",
        versionHash: "hash-1",
        revokedAt: expect.any(Number),
      },
    ]);

    const afterRevoke = seedSkillGrantsFromDefaults([
      { skillId: "long-run", versionHash: "hash-1" },
    ]);
    expect(afterRevoke.seeded).toEqual([]);
    expect(afterRevoke.skipped).toEqual([
      { skillId: "long-run", versionHash: "hash-1", reason: "revoked" },
    ]);
    expect(getSkillGrant("long-run", "hash-1")).toBeNull();

    const nextVersion = seedSkillGrantsFromDefaults([
      { skillId: "long-run", versionHash: "hash-2" },
    ]);
    expect(nextVersion.seeded).toEqual([
      {
        skillId: "long-run",
        versionHash: "hash-2",
        capabilities: ["host_exec"],
      },
    ]);
  });

  test("records a tombstone even when there was no grant to delete", () => {
    expect(deleteSkillGrant("long-run", "hash-1")).toBe(false);
    expect(getSkillGrant("long-run", "hash-1")).toBeNull();
    expect(listSkillGrantTombstones()).toHaveLength(1);
  });

  test("an explicit write clears the tombstone", () => {
    deleteSkillGrant("long-run", "hash-1");
    expect(listSkillGrantTombstones()).toHaveLength(1);

    upsertSkillGrant({
      skillId: "long-run",
      versionHash: "hash-1",
      capabilities: ["vetted"],
      grantedBy: "user-123",
    });

    expect(listSkillGrantTombstones()).toEqual([]);
    expect(getSkillGrant("long-run", "hash-1")?.capabilities).toEqual([
      "vetted",
    ]);
  });

  test("is idempotent across repeated declarations", () => {
    writeDefaults({ "long-run": ["host_exec"] });
    const declared = [{ skillId: "long-run", versionHash: "hash-1" }];

    seedSkillGrantsFromDefaults(declared);
    const second = seedSkillGrantsFromDefaults(declared);

    expect(second.seeded).toEqual([]);
    expect(second.skipped).toEqual([
      { skillId: "long-run", versionHash: "hash-1", reason: "existing" },
    ]);
    expect(listSkillGrants()).toHaveLength(1);
  });

  test("deduplicates repeated pairs in one declaration", () => {
    writeDefaults({ "long-run": ["host_exec"] });

    const result = seedSkillGrantsFromDefaults([
      { skillId: "long-run", versionHash: "hash-1" },
      { skillId: "long-run", versionHash: "hash-1" },
    ]);

    expect(result.seeded).toHaveLength(1);
    expect(result.skipped).toEqual([]);
  });

  test("seeds nothing when the defaults document is unreadable", () => {
    writeFileSync(getSkillGrantDefaultsPath(), "{ not json", "utf-8");
    _resetSkillGrantDefaultsCacheForTest();

    const result = seedSkillGrantsFromDefaults([
      { skillId: "long-run", versionHash: "hash-1" },
    ]);

    expect(result.seeded).toEqual([]);
    expect(result.skipped).toEqual([
      { skillId: "long-run", versionHash: "hash-1", reason: "no_default" },
    ]);
  });
});

describe("skill grant defaults document", () => {
  test("materializes the shipped defaults into the security volume", () => {
    expect(loadSkillGrantDefaults()).toEqual(
      // The shipped document is frozen; compare as plain objects.
      JSON.parse(JSON.stringify(BUILTIN_SKILL_GRANT_DEFAULTS)),
    );

    // The file is now the operator's copy: it holds ids and capabilities only,
    // never a version hash, so a seed cannot bind a capability to content the
    // operator has not seen.
    const written = JSON.parse(
      readFileSync(getSkillGrantDefaultsPath(), "utf-8"),
    );
    expect(written["long-run"]).toEqual([
      "host_exec",
      "vetted",
      "input_repairs",
    ]);
    expect(JSON.stringify(written)).not.toContain("v1:");
  });

  test("never overwrites an existing document", () => {
    writeDefaults({ "long-run": [] });

    expect(loadSkillGrantDefaults()).toEqual({ "long-run": [] });
    const onDisk = JSON.parse(
      readFileSync(getSkillGrantDefaultsPath(), "utf-8"),
    );
    expect(onDisk).toEqual({ "long-run": [] });
  });

  test("picks up edits to the document", () => {
    writeDefaults({ "long-run": ["host_exec"] });
    expect(loadSkillGrantDefaults()).toEqual({ "long-run": ["host_exec"] });

    writeDefaults({ "long-run": ["vetted"] });
    expect(loadSkillGrantDefaults()).toEqual({ "long-run": ["vetted"] });
  });

  test("drops entries whose skill id is not a valid id", () => {
    writeDefaults({
      "long-run": ["host_exec"],
      "nested/id": ["host_exec"],
    });

    expect(loadSkillGrantDefaults()).toEqual({ "long-run": ["host_exec"] });
  });
});
