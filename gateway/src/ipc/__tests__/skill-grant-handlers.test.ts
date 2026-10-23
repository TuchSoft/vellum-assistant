/**
 * Tests for the skill grant IPC routes.
 *
 * Two methods with different powers. `get_skill_grants` is a read and answers
 * fail-closed: an unreadable store returns an empty grant list, never an error
 * the assistant could retry into a grant. `declare_skill_versions` is a write,
 * but only of facts — it seeds the gateway's own defaults onto versions that
 * have no decision yet, so the test asserts a declared capability list is not
 * part of the surface at all.
 */

import { rmSync, writeFileSync } from "node:fs";

import { afterEach, beforeEach, describe, expect, test } from "bun:test";

import {
  getGatewayDb,
  initGatewayDb,
  resetGatewayDb,
} from "../../db/connection.js";
import { skillGrants, skillGrantTombstones } from "../../db/schema.js";
import {
  _resetSkillGrantDefaultsCacheForTest,
  getSkillGrantDefaultsPath,
} from "../../db/skill-grant-defaults.js";
import { getSkillGrant, upsertSkillGrant } from "../../db/skill-grant-store.js";
import { skillGrantRoutes } from "../skill-grant-handlers.js";

function rawDb() {
  return (
    getGatewayDb() as unknown as { $client: import("bun:sqlite").Database }
  ).$client;
}

function route(method: string) {
  const found = skillGrantRoutes.find((entry) => entry.method === method);
  if (!found) {
    throw new Error(`missing IPC method ${method}`);
  }
  return found;
}

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

describe("skill grant IPC routes", () => {
  test("exposes one read method and one declaration method", () => {
    const methods = skillGrantRoutes.map((entry) => entry.method);
    expect(methods).toEqual(["get_skill_grants", "declare_skill_versions"]);
  });

  test("validates the read params", () => {
    const schema = route("get_skill_grants").schema;
    expect(schema).toBeDefined();

    expect(schema?.safeParse({}).success).toBe(true);
    expect(schema?.safeParse({ skillId: "long-run" }).success).toBe(true);
    expect(
      schema?.safeParse({ skillId: "long-run", versionHash: "hash-1" }).success,
    ).toBe(true);
    expect(schema?.safeParse({ skillId: "" }).success).toBe(false);
    expect(schema?.safeParse({ versionHash: "   " }).success).toBe(false);
  });

  test("validates the declaration params", () => {
    const schema = route("declare_skill_versions").schema;
    expect(schema).toBeDefined();

    expect(schema?.safeParse({ skills: [] }).success).toBe(true);
    expect(
      schema?.safeParse({
        skills: [{ skillId: "long-run", versionHash: "hash-1" }],
      }).success,
    ).toBe(true);
    // A declaration names versions only: a capability in the payload is not
    // part of the contract, and a version without its skill is meaningless.
    expect(
      schema?.safeParse({
        skills: [
          {
            skillId: "long-run",
            versionHash: "hash-1",
            capabilities: ["host_exec"],
          },
        ],
      }).success,
    ).toBe(true);
    expect(
      schema?.safeParse({ skills: [{ skillId: "long-run" }] }).success,
    ).toBe(false);
    expect(
      schema?.safeParse({ skills: [{ versionHash: "hash-1" }] }).success,
    ).toBe(false);
    expect(
      schema?.safeParse({ skills: [{ skillId: "a/b", versionHash: "h" }] })
        .success,
    ).toBe(false);
  });

  test("returns every grant when no filter is given", () => {
    upsertSkillGrant({
      skillId: "long-run",
      versionHash: "hash-1",
      capabilities: ["host_exec"],
    });

    const result = route("get_skill_grants").handler({}) as {
      grants: Array<{ skillId: string; capabilities: string[] }>;
    };

    expect(result.grants).toHaveLength(1);
    expect(result.grants[0]?.skillId).toBe("long-run");
    expect(result.grants[0]?.capabilities).toEqual(["host_exec"]);
  });

  test("filters by skill id and version hash", () => {
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

    const bySkill = route("get_skill_grants").handler({
      skillId: "long-run",
    }) as { grants: unknown[] };
    expect(bySkill.grants).toHaveLength(2);

    const byVersion = route("get_skill_grants").handler({
      skillId: "long-run",
      versionHash: "hash-2",
    }) as { grants: Array<{ capabilities: string[] }> };
    expect(byVersion.grants).toHaveLength(1);
    expect(byVersion.grants[0]?.capabilities).toEqual(["vetted"]);
  });

  test("returns no grants when the store is unreadable", async () => {
    upsertSkillGrant({
      skillId: "long-run",
      versionHash: "hash-1",
      capabilities: ["host_exec"],
    });

    rawDb().exec("DROP TABLE skill_grants");

    expect(route("get_skill_grants").handler({})).toEqual({ grants: [] });

    // Restore the table for the tests that follow in this file.
    resetGatewayDb();
    await initGatewayDb();
  });

  test("seeds the declared versions from the defaults document", () => {
    writeDefaults({ "long-run": ["host_exec", "vetted"] });

    const result = route("declare_skill_versions").handler({
      skills: [
        { skillId: "long-run", versionHash: "hash-1" },
        { skillId: "unlisted", versionHash: "hash-1" },
      ],
    }) as {
      seeded: Array<{
        skillId: string;
        versionHash: string;
        capabilities: string[];
      }>;
      skipped: Array<{
        skillId: string;
        versionHash: string;
        reason: string;
      }>;
    };

    expect(result.seeded).toEqual([
      {
        skillId: "long-run",
        versionHash: "hash-1",
        capabilities: ["host_exec", "vetted"],
      },
    ]);
    expect(result.skipped).toEqual([
      { skillId: "unlisted", versionHash: "hash-1", reason: "no_default" },
    ]);

    expect(getSkillGrant("long-run", "hash-1")?.grantedBy).toBe("defaults");
  });

  test("a declaration cannot widen an existing grant", () => {
    writeDefaults({ "long-run": ["host_exec", "vetted"] });
    upsertSkillGrant({
      skillId: "long-run",
      versionHash: "hash-1",
      capabilities: ["vetted"],
      grantedBy: "user-123",
    });

    route("declare_skill_versions").handler({
      skills: [{ skillId: "long-run", versionHash: "hash-1" }],
    });

    expect(getSkillGrant("long-run", "hash-1")?.capabilities).toEqual([
      "vetted",
    ]);
  });
});
