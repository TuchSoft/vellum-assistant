/**
 * Tests for the skill grant IPC route.
 *
 * The surface is read-only: the test asserts the route map contains no write
 * method, because the assistant can reach every method registered on the
 * gateway socket. The read path is fail-closed: an unreadable store returns an
 * empty grant list, never an error the assistant could retry into a grant.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";

import {
  getGatewayDb,
  initGatewayDb,
  resetGatewayDb,
} from "../../db/connection.js";
import { skillGrants } from "../../db/schema.js";
import { upsertSkillGrant } from "../../db/skill-grant-store.js";
import { skillGrantRoutes } from "../skill-grant-handlers.js";

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

describe("skill grant IPC routes", () => {
  test("exposes exactly one read-only method", () => {
    expect(skillGrantRoutes).toHaveLength(1);

    const methods = skillGrantRoutes.map((route) => route.method);
    expect(methods).toEqual(["get_skill_grants"]);

    for (const method of methods) {
      expect(method.startsWith("get_")).toBe(true);
    }
  });

  test("validates its params", () => {
    const schema = skillGrantRoutes[0]?.schema;
    expect(schema).toBeDefined();

    expect(schema?.safeParse({}).success).toBe(true);
    expect(schema?.safeParse({ skillId: "long-run" }).success).toBe(true);
    expect(
      schema?.safeParse({ skillId: "long-run", versionHash: "hash-1" }).success,
    ).toBe(true);
    expect(schema?.safeParse({ skillId: "" }).success).toBe(false);
    expect(schema?.safeParse({ versionHash: "   " }).success).toBe(false);
  });

  test("returns every grant when no filter is given", () => {
    upsertSkillGrant({
      skillId: "long-run",
      versionHash: "hash-1",
      capabilities: ["host_exec"],
    });

    const result = skillGrantRoutes[0]?.handler({}) as {
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

    const bySkill = skillGrantRoutes[0]?.handler({ skillId: "long-run" }) as {
      grants: unknown[];
    };
    expect(bySkill.grants).toHaveLength(2);

    const byVersion = skillGrantRoutes[0]?.handler({
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

    expect(skillGrantRoutes[0]?.handler({})).toEqual({ grants: [] });

    // Restore the table for the tests that follow in this file.
    resetGatewayDb();
    await initGatewayDb();
  });
});
