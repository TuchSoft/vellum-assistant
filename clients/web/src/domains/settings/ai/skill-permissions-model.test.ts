/**
 * Classification of installed skills against the gateway's grants.
 *
 * These are the three states the settings card renders: a grant for the
 * installed version, a grant left over from an earlier version, and no grant
 * at all. The fourth, `unavailable`, covers a daemon that cannot report the
 * installed version.
 */

import { describe, expect, test } from "bun:test";

import type { SkillGrant } from "@/lib/skill-grants-api";

import {
  buildSkillPermissionRows,
  shortVersionHash,
  toggleCapability,
  type InstalledSkill,
} from "./skill-permissions-model";

function skill(
  id: string,
  overrides: Partial<InstalledSkill> = {},
): InstalledSkill {
  return {
    id,
    name: id,
    kind: "installed",
    status: "enabled",
    ...overrides,
  };
}

function grant(
  skillId: string,
  versionHash: string,
  capabilities: SkillGrant["capabilities"] = ["host_exec"],
  overrides: Partial<SkillGrant> = {},
): SkillGrant {
  return {
    skillId,
    versionHash,
    capabilities,
    grantedBy: "defaults",
    createdAt: 1,
    updatedAt: 1,
    ...overrides,
  };
}

describe("buildSkillPermissionRows", () => {
  test("marks a skill with a grant for the installed version as granted", () => {
    const rows = buildSkillPermissionRows(
      [skill("long-run")],
      { "long-run": "v1:aaa" },
      [grant("long-run", "v1:aaa", ["host_exec", "vetted"])],
    );

    expect(rows).toHaveLength(1);
    expect(rows[0]?.status).toBe("granted");
    expect(rows[0]?.capabilities).toEqual(["host_exec", "vetted"]);
    expect(rows[0]?.shortVersion).toBe("aaa");
    expect(rows[0]?.staleGrants).toEqual([]);
  });

  test("marks a skill with no grant as denied", () => {
    const rows = buildSkillPermissionRows(
      [skill("daily-brief")],
      { "daily-brief": "v1:bbb" },
      [],
    );

    expect(rows[0]?.status).toBe("denied");
    expect(rows[0]?.capabilities).toEqual([]);
    expect(rows[0]?.grantedBy).toBeNull();
  });

  test("flags a grant for another version as version changed", () => {
    const rows = buildSkillPermissionRows(
      [skill("long-run")],
      { "long-run": "v1:new" },
      [grant("long-run", "v1:old")],
    );

    expect(rows[0]?.status).toBe("version_changed");
    expect(rows[0]?.capabilities).toEqual([]);
    expect(rows[0]?.staleGrants.map((entry) => entry.versionHash)).toEqual([
      "v1:old",
    ]);
  });

  test("keeps stale grants newest first", () => {
    const rows = buildSkillPermissionRows(
      [skill("long-run")],
      { "long-run": "v1:new" },
      [
        grant("long-run", "v1:older", ["host_exec"], { updatedAt: 1 }),
        grant("long-run", "v1:oldest", ["vetted"], { updatedAt: 0 }),
        grant("long-run", "v1:new", ["vetted"], { updatedAt: 2 }),
      ],
    );

    expect(rows[0]?.status).toBe("granted");
    expect(rows[0]?.staleGrants.map((entry) => entry.versionHash)).toEqual([
      "v1:older",
      "v1:oldest",
    ]);
  });

  test("reads an empty current grant as denied but keeps the version", () => {
    const rows = buildSkillPermissionRows(
      [skill("long-run")],
      { "long-run": "v1:aaa" },
      [grant("long-run", "v1:aaa", [])],
    );

    expect(rows[0]?.status).toBe("denied");
    expect(rows[0]?.versionHash).toBe("v1:aaa");
    expect(rows[0]?.grantedBy).toBe("defaults");
  });

  test("marks a skill as unavailable when the installed version is unknown", () => {
    const rows = buildSkillPermissionRows(
      [skill("long-run")],
      { "long-run": null },
      [grant("long-run", "v1:aaa")],
    );

    expect(rows[0]?.status).toBe("unavailable");
    expect(rows[0]?.versionHash).toBeNull();
    expect(rows[0]?.staleGrants).toHaveLength(1);
  });

  test("drops catalog entries that are not installed", () => {
    const rows = buildSkillPermissionRows(
      [skill("catalog-only", { kind: "catalog", status: "available" })],
      {},
      [],
    );

    expect(rows).toEqual([]);
  });

  test("lists enabled skills before disabled ones, then by name", () => {
    const rows = buildSkillPermissionRows(
      [
        skill("zeta", { name: "Zeta" }),
        skill("alpha", { name: "Alpha", status: "disabled" }),
        skill("beta", { name: "Beta" }),
      ],
      {},
      [],
    );

    expect(rows.map((row) => row.skill.id)).toEqual(["beta", "zeta", "alpha"]);
  });
});

describe("shortVersionHash", () => {
  test("drops the algorithm prefix and truncates", () => {
    expect(shortVersionHash("v1:0123456789abcdef")).toBe("01234567");
    expect(shortVersionHash("0123456789abcdef")).toBe("01234567");
  });
});

describe("toggleCapability", () => {
  test("adds a capability in the contract's order", () => {
    expect(toggleCapability(["vetted"], "host_exec", true)).toEqual([
      "host_exec",
      "vetted",
    ]);
  });

  test("removes a capability", () => {
    expect(
      toggleCapability(["host_exec", "vetted"], "host_exec", false),
    ).toEqual(["vetted"]);
  });

  test("does not duplicate an already granted capability", () => {
    expect(toggleCapability(["host_exec"], "host_exec", true)).toEqual([
      "host_exec",
    ]);
  });
});
