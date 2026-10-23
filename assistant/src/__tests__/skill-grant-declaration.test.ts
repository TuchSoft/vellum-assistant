/**
 * Tests for the skill version declaration.
 *
 * The declaration is the assistant's half of the grant seed: it states which
 * skill versions exist, and the gateway decides what each may do. The cases
 * below pin the shape of that statement (ids and hashes only), its cost (one
 * call per distinct set), and its failure mode (nothing is recorded, so the
 * next attempt declares again).
 */

import { afterAll, beforeEach, describe, expect, mock, test } from "bun:test";

let catalog: Array<{ id: string; directoryPath: string }> = [];
let catalogThrows = false;
const hashByPath = new Map<string, string>();

mock.module("../config/skills.js", () => ({
  loadSkillCatalog: () => {
    if (catalogThrows) {
      throw new Error("catalog is unreadable");
    }
    return catalog;
  },
}));

mock.module("../skills/version-hash.js", () => ({
  computeSkillVersionHash: (directoryPath: string) => {
    const hash = hashByPath.get(directoryPath);
    if (hash === undefined) {
      throw new Error(`cannot hash ${directoryPath}`);
    }
    return hash;
  },
}));

let ipcHandler: (
  method: string,
  params?: Record<string, unknown>,
) => unknown = () => undefined;
const ipcCalls: Array<{ method: string; params?: Record<string, unknown> }> =
  [];

mock.module("../ipc/gateway-client.js", () => ({
  ipcCall: async (
    method: string,
    params?: Record<string, unknown>,
  ): Promise<unknown> => {
    ipcCalls.push({ method, params });
    return ipcHandler(method, params);
  },
  ipcCallPersistent: async () => undefined,
  resetPersistentClient: () => {},
}));

import {
  _resetSkillVersionDeclarationForTest,
  collectInstalledSkillVersions,
  declareInstalledSkillVersions,
  notifySkillCatalogChanged,
} from "../skills/grant-declaration.js";

function seedResponse(seeded = 0) {
  return {
    seeded: Array.from({ length: seeded }, (_, index) => ({
      skillId: `skill-${index}`,
      versionHash: `hash-${index}`,
      capabilities: ["host_exec"],
    })),
    skipped: [],
  };
}

beforeEach(() => {
  _resetSkillVersionDeclarationForTest();
  ipcCalls.length = 0;
  ipcHandler = () => seedResponse();
  hashByPath.clear();
  catalog = [];
  catalogThrows = false;
});

// The mocks above replace modules the rest of the suite also loads, and Bun
// keeps module mocks for the whole process. Restore them so this file cannot
// change what a later test file sees.
afterAll(() => {
  mock.restore();
});

describe("collectInstalledSkillVersions", () => {
  test("reports the id and content hash of every installed skill", () => {
    catalog = [
      { id: "long-run", directoryPath: "/skills/long-run" },
      { id: "schedule", directoryPath: "/skills/schedule" },
    ];
    hashByPath.set("/skills/long-run", "v1:aaa");
    hashByPath.set("/skills/schedule", "v1:bbb");

    expect(collectInstalledSkillVersions()).toEqual([
      { skillId: "long-run", versionHash: "v1:aaa" },
      { skillId: "schedule", versionHash: "v1:bbb" },
    ]);
  });

  test("leaves out a skill whose content cannot be hashed", () => {
    catalog = [
      { id: "long-run", directoryPath: "/skills/long-run" },
      { id: "broken", directoryPath: "/skills/broken" },
    ];
    hashByPath.set("/skills/long-run", "v1:aaa");

    expect(collectInstalledSkillVersions()).toEqual([
      { skillId: "long-run", versionHash: "v1:aaa" },
    ]);
  });
  test("declares nothing when the catalog cannot be read", () => {
    catalogThrows = true;

    expect(collectInstalledSkillVersions()).toEqual([]);
  });
});

describe("declareInstalledSkillVersions", () => {
  test("declares ids and hashes only", async () => {
    catalog = [{ id: "long-run", directoryPath: "/skills/long-run" }];
    hashByPath.set("/skills/long-run", "v1:aaa");

    expect(await declareInstalledSkillVersions()).toBe("declared");

    expect(ipcCalls).toEqual([
      {
        method: "declare_skill_versions",
        params: { skills: [{ skillId: "long-run", versionHash: "v1:aaa" }] },
      },
    ]);
  });

  test("does not repeat a declaration for an unchanged set", async () => {
    catalog = [{ id: "long-run", directoryPath: "/skills/long-run" }];
    hashByPath.set("/skills/long-run", "v1:aaa");

    expect(await declareInstalledSkillVersions()).toBe("declared");
    expect(await declareInstalledSkillVersions()).toBe("unchanged");
    expect(ipcCalls).toHaveLength(1);
  });

  test("declares again when a skill version changes", async () => {
    catalog = [{ id: "long-run", directoryPath: "/skills/long-run" }];
    hashByPath.set("/skills/long-run", "v1:aaa");
    await declareInstalledSkillVersions();

    hashByPath.set("/skills/long-run", "v1:bbb");
    expect(await declareInstalledSkillVersions()).toBe("declared");

    expect(ipcCalls).toHaveLength(2);
    expect(ipcCalls[1]?.params).toEqual({
      skills: [{ skillId: "long-run", versionHash: "v1:bbb" }],
    });
  });

  test("shares one call between concurrent callers", async () => {
    catalog = [{ id: "long-run", directoryPath: "/skills/long-run" }];
    hashByPath.set("/skills/long-run", "v1:aaa");

    const [first, second] = await Promise.all([
      declareInstalledSkillVersions(),
      declareInstalledSkillVersions(),
    ]);

    expect(first).toBe("declared");
    expect(second).toBe("declared");
    expect(ipcCalls).toHaveLength(1);
  });

  test("reports a gateway that never answers, and declares again later", async () => {
    catalog = [{ id: "long-run", directoryPath: "/skills/long-run" }];
    hashByPath.set("/skills/long-run", "v1:aaa");
    ipcHandler = () => undefined;

    expect(await declareInstalledSkillVersions()).toBe("failed");
    // Nothing was recorded, so the next attempt is a real declaration.
    ipcHandler = () => seedResponse();
    expect(await declareInstalledSkillVersions()).toBe("declared");
    expect(ipcCalls).toHaveLength(2);
  });

  test("rejects an answer that does not match the contract", async () => {
    catalog = [{ id: "long-run", directoryPath: "/skills/long-run" }];
    hashByPath.set("/skills/long-run", "v1:aaa");
    ipcHandler = () => ({ grants: [] });

    expect(await declareInstalledSkillVersions()).toBe("failed");
    expect(await declareInstalledSkillVersions()).toBe("failed");
    expect(ipcCalls).toHaveLength(2);
  });

  test("does not call the gateway when no skill is installed", async () => {
    expect(await declareInstalledSkillVersions()).toBe("declared");
    // An empty set is still a declaration, but there is nothing to say twice.
    expect(await declareInstalledSkillVersions()).toBe("unchanged");
    expect(ipcCalls).toHaveLength(1);
    expect(ipcCalls[0]?.params).toEqual({ skills: [] });
  });
});

describe("notifySkillCatalogChanged", () => {
  test("coalesces a burst of changes into one declaration", async () => {
    catalog = [{ id: "long-run", directoryPath: "/skills/long-run" }];
    hashByPath.set("/skills/long-run", "v1:aaa");

    notifySkillCatalogChanged("install");
    notifySkillCatalogChanged("enable");
    notifySkillCatalogChanged("delete");

    await new Promise((resolve) => setTimeout(resolve, 800));

    expect(ipcCalls).toHaveLength(1);
    expect(ipcCalls[0]?.method).toBe("declare_skill_versions");
  });
});
