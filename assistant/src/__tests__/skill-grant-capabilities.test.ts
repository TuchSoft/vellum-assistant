import { join } from "node:path";
import { beforeEach, describe, expect, mock, test } from "bun:test";

import { getBundledSkillsDir } from "../config/bundled-skills-dir.js";
import { computeSkillVersionHash } from "../skills/skill-content-hash.js";

// The capability resolver reads grants over the gateway IPC transport. The
// mock stands in for the gateway: tests run without a stack, and every case
// below drives the answer (a grant, no grant, a broken response, no answer).
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
  _clearSkillCapabilityCacheForTest,
  getCachedSkillCapabilities,
  getSkillCapabilities,
  hasSkillCapability,
} from "../skills/capabilities.js";

function grantResponse(
  skillId: string,
  versionHash: string,
  capabilities: string[],
): unknown {
  return {
    grants: [
      {
        skillId,
        versionHash,
        capabilities,
        grantedBy: "user-123",
        createdAt: 1,
        updatedAt: 1,
      },
    ],
  };
}

const ALL_GRANTED = {
  host_exec: true,
  vetted: true,
  input_repairs: true,
  computer_use_target: true,
};

const NOTHING_GRANTED = {
  host_exec: false,
  vetted: false,
  input_repairs: false,
  computer_use_target: false,
};

beforeEach(() => {
  _clearSkillCapabilityCacheForTest();
  ipcCalls.length = 0;
  ipcHandler = () => undefined;
});

describe("getSkillCapabilities: the gateway grant decides", () => {
  test("returns the capabilities granted for the exact skill version", async () => {
    ipcHandler = () =>
      grantResponse("deploy", "hash-1", [
        "host_exec",
        "vetted",
        "input_repairs",
        "computer_use_target",
      ]);

    const capabilities = await getSkillCapabilities({
      skillId: "deploy",
      versionHash: "hash-1",
    });

    expect(capabilities).toEqual(ALL_GRANTED);
    expect(ipcCalls).toEqual([
      {
        method: "get_skill_grants",
        params: { skillId: "deploy", versionHash: "hash-1" },
      },
    ]);
  });

  test("a version with no grant gets nothing", async () => {
    ipcHandler = () => ({ grants: [] });

    const capabilities = await getSkillCapabilities({
      skillId: "deploy",
      versionHash: "hash-1",
    });

    expect(capabilities).toEqual(NOTHING_GRANTED);
  });

  test("a grant for another version does not apply", async () => {
    ipcHandler = () =>
      grantResponse("deploy", "hash-1", ["host_exec", "vetted"]);

    const capabilities = await getSkillCapabilities({
      skillId: "deploy",
      versionHash: "hash-2",
    });

    expect(capabilities).toEqual(NOTHING_GRANTED);
  });

  test("a grant for another skill does not apply", async () => {
    ipcHandler = () =>
      grantResponse("other-skill", "hash-1", ["host_exec", "vetted"]);

    const capabilities = await getSkillCapabilities({
      skillId: "deploy",
      versionHash: "hash-1",
    });

    expect(capabilities).toEqual(NOTHING_GRANTED);
  });

  test("only the granted capabilities are enabled", async () => {
    ipcHandler = () => grantResponse("deploy", "hash-1", ["vetted"]);

    const capabilities = await getSkillCapabilities({
      skillId: "deploy",
      versionHash: "hash-1",
    });

    expect(capabilities).toEqual({ ...NOTHING_GRANTED, vetted: true });
    expect(
      await hasSkillCapability(
        { skillId: "deploy", versionHash: "hash-1" },
        "vetted",
      ),
    ).toBe(true);
    expect(
      await hasSkillCapability(
        { skillId: "deploy", versionHash: "hash-1" },
        "host_exec",
      ),
    ).toBe(false);
  });
});

describe("getSkillCapabilities: fail-closed", () => {
  test("an unreachable gateway (no answer) denies everything", async () => {
    ipcHandler = () => undefined;

    expect(
      await getSkillCapabilities({ skillId: "deploy", versionHash: "hash-1" }),
    ).toEqual(NOTHING_GRANTED);
  });

  test("a throwing IPC call denies everything", async () => {
    ipcHandler = () => {
      throw new Error("connect ENOENT gateway.sock");
    };

    expect(
      await getSkillCapabilities({ skillId: "deploy", versionHash: "hash-1" }),
    ).toEqual(NOTHING_GRANTED);
  });

  test("a response that does not match the contract denies everything", async () => {
    ipcHandler = () => ({ grants: [{ skillId: "deploy" }] });

    expect(
      await getSkillCapabilities({ skillId: "deploy", versionHash: "hash-1" }),
    ).toEqual(NOTHING_GRANTED);
  });

  test("a lookup that cannot address a grant never calls the gateway", async () => {
    expect(await getSkillCapabilities({ skillId: "deploy" })).toEqual(
      NOTHING_GRANTED,
    );
    expect(
      await getSkillCapabilities({ skillId: "../etc", versionHash: "hash-1" }),
    ).toEqual(NOTHING_GRANTED);
    expect(ipcCalls).toEqual([]);
  });
});

describe("getSkillCapabilities: bundled is provenance, not permission", () => {
  const bundledDir = getBundledSkillsDir();
  const skillId = "long-run";
  const versionHash = computeSkillVersionHash(join(bundledDir, skillId));

  test("a bundled skill version with no grant is denied", async () => {
    ipcHandler = () => ({ grants: [] });

    const capabilities = await getSkillCapabilities({ skillId, versionHash });

    expect(capabilities).toEqual(NOTHING_GRANTED);
  });

  test("a bundled skill version passes once the grant exists", async () => {
    ipcHandler = () =>
      grantResponse(skillId, versionHash, ["host_exec", "vetted"]);

    const capabilities = await getSkillCapabilities({ skillId, versionHash });

    expect(capabilities).toEqual({
      ...NOTHING_GRANTED,
      host_exec: true,
      vetted: true,
    });
  });

  test("a bundled skill whose content changed loses the grant", async () => {
    ipcHandler = () =>
      grantResponse(skillId, versionHash, ["host_exec", "vetted"]);

    const capabilities = await getSkillCapabilities({
      skillId,
      versionHash: "hash-of-the-previous-content",
    });

    expect(capabilities).toEqual(NOTHING_GRANTED);
  });
});

describe("getSkillCapabilities: cache", () => {
  test("a resolved grant is reused inside the TTL", async () => {
    ipcHandler = () => grantResponse("deploy", "hash-1", ["vetted"]);

    await getSkillCapabilities({ skillId: "deploy", versionHash: "hash-1" });
    await getSkillCapabilities({ skillId: "deploy", versionHash: "hash-1" });

    expect(ipcCalls).toHaveLength(1);
  });

  test("concurrent lookups share one read", async () => {
    ipcHandler = () => grantResponse("deploy", "hash-1", ["vetted"]);

    const [first, second] = await Promise.all([
      getSkillCapabilities({ skillId: "deploy", versionHash: "hash-1" }),
      getSkillCapabilities({ skillId: "deploy", versionHash: "hash-1" }),
    ]);

    expect(first).toEqual(second);
    expect(ipcCalls).toHaveLength(1);
  });

  test("the synchronous accessor answers fail-closed on a miss", () => {
    ipcHandler = () => grantResponse("deploy", "hash-1", ["vetted"]);

    expect(
      getCachedSkillCapabilities({ skillId: "deploy", versionHash: "hash-1" }),
    ).toEqual(NOTHING_GRANTED);
  });

  test("the synchronous accessor returns the resolved set once read", async () => {
    ipcHandler = () => grantResponse("deploy", "hash-1", ["vetted"]);

    await getSkillCapabilities({ skillId: "deploy", versionHash: "hash-1" });

    expect(
      getCachedSkillCapabilities({ skillId: "deploy", versionHash: "hash-1" }),
    ).toEqual({ ...NOTHING_GRANTED, vetted: true });
  });
});
