/**
 * Skill permissions card states.
 *
 * The data hook is stubbed so each test renders one classification from
 * fixtures and asserts the write the card asks for. The classification itself
 * is covered by `skill-permissions-model.test.ts`.
 */

import { afterEach, describe, expect, mock, test } from "bun:test";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";

import type { SkillCapability } from "@/lib/skill-grants-api";

import type {
  SkillPermissionRow,
  SkillPermissionStatus,
} from "./skill-permissions-model";

type HookResult = {
  rows: SkillPermissionRow[];
  isLoading: boolean;
  error: Error | null;
  refetch: () => void;
  savingSkillId: string | null;
  setCapability: (
    row: SkillPermissionRow,
    capability: SkillCapability,
    enabled: boolean,
  ) => void;
  revoke: (row: SkillPermissionRow, versionHash?: string) => void;
};

const setCapabilityCalls: Array<{
  skillId: string;
  capability: SkillCapability;
  enabled: boolean;
}> = [];
const revokeCalls: Array<{ skillId: string; versionHash?: string }> = [];
let refetchCalls = 0;

let hookResult: HookResult;

mock.module("@/domains/settings/ai/use-skill-permissions", () => ({
  useSkillPermissions: () => hookResult,
}));

const { SkillPermissionsCard } =
  await import("@/domains/settings/ai/skill-permissions-card");

function row(
  status: SkillPermissionStatus,
  overrides: Partial<SkillPermissionRow> = {},
): SkillPermissionRow {
  return {
    skill: {
      id: "long-run",
      name: "Long Run",
      emoji: "🏃",
      kind: "bundled",
      status: "enabled",
    },
    versionHash: "v1:0123456789abcdef",
    shortVersion: "01234567",
    status,
    capabilities: [],
    grantedBy: null,
    staleGrants: [],
    ...overrides,
  };
}

function makeHook(overrides: Partial<HookResult> = {}): HookResult {
  return {
    rows: [row("granted")],
    isLoading: false,
    error: null,
    refetch: () => {
      refetchCalls += 1;
    },
    savingSkillId: null,
    setCapability: (target, capability, enabled) => {
      setCapabilityCalls.push({
        skillId: target.skill.id,
        capability,
        enabled,
      });
    },
    revoke: (target, versionHash) => {
      revokeCalls.push({ skillId: target.skill.id, versionHash });
    },
    ...overrides,
  };
}

function renderCard() {
  return render(<SkillPermissionsCard assistantId="asst-test" />);
}

afterEach(() => {
  cleanup();
  setCapabilityCalls.length = 0;
  revokeCalls.length = 0;
  refetchCalls = 0;
});

describe("SkillPermissionsCard", () => {
  test("shows a granted skill with its version and capability switches", () => {
    hookResult = makeHook({
      rows: [
        row("granted", {
          capabilities: ["host_exec", "vetted"],
          grantedBy: "defaults",
        }),
      ],
    });
    renderCard();

    expect(screen.getByText("Granted")).toBeDefined();
    expect(screen.getByText("Version 01234567")).toBeDefined();
    expect(screen.getByText("Default")).toBeDefined();

    const hostExec = screen.getByRole("switch", {
      name: "Host execution for Long Run",
    });
    expect(hostExec.getAttribute("aria-checked")).toBe("true");

    fireEvent.click(hostExec);
    expect(setCapabilityCalls).toEqual([
      { skillId: "long-run", capability: "host_exec", enabled: false },
    ]);
  });

  test("shows a denied skill and grants a capability on toggle", () => {
    hookResult = makeHook({ rows: [row("denied")] });
    renderCard();

    expect(screen.getByText("No grant")).toBeDefined();
    const vetted = screen.getByRole("switch", {
      name: "Vetted for Long Run",
    });
    expect(vetted.getAttribute("aria-checked")).toBe("false");

    fireEvent.click(vetted);
    expect(setCapabilityCalls).toEqual([
      { skillId: "long-run", capability: "vetted", enabled: true },
    ]);
  });

  test("shows the version change warning and revokes the stale version", () => {
    hookResult = makeHook({
      rows: [
        row("version_changed", {
          staleGrants: [
            {
              skillId: "long-run",
              versionHash: "v1:ffffffffffffffff",
              capabilities: ["host_exec"],
              grantedBy: "defaults",
              createdAt: 1,
              updatedAt: 1,
            },
          ],
        }),
      ],
    });
    renderCard();

    expect(screen.getByText("Version changed")).toBeDefined();
    expect(screen.getByText("Version ffffffff")).toBeDefined();
    expect(screen.getByText("host_exec")).toBeDefined();

    fireEvent.click(screen.getAllByRole("button", { name: "Revoke" })[0]!);
    expect(revokeCalls).toEqual([
      { skillId: "long-run", versionHash: "v1:ffffffffffffffff" },
    ]);
  });

  test("disables the switches when the installed version is unknown", () => {
    hookResult = makeHook({
      rows: [
        row("unavailable", {
          versionHash: null,
          shortVersion: null,
          staleGrants: [
            {
              skillId: "long-run",
              versionHash: "v1:eeeeeeeeeeeeeeee",
              capabilities: ["vetted"],
              grantedBy: "defaults",
              createdAt: 1,
              updatedAt: 1,
            },
          ],
        }),
      ],
    });
    renderCard();

    expect(screen.getByText("Version unavailable")).toBeDefined();
    const hostExec = screen.getByRole("switch", {
      name: "Host execution for Long Run",
    }) as HTMLButtonElement;
    expect(hostExec.disabled).toBe(true);

    // A grant the gateway still reports can be revoked even when the installed
    // version is unknown, because the revoke names the grant's own version.
    fireEvent.click(screen.getByRole("button", { name: "Revoke" }));
    expect(revokeCalls).toEqual([
      { skillId: "long-run", versionHash: "v1:eeeeeeeeeeeeeeee" },
    ]);
  });

  test("shows the loading state", () => {
    hookResult = makeHook({ isLoading: true, rows: [] });
    renderCard();

    expect(screen.getByText("Loading skill permissions…")).toBeDefined();
  });

  test("shows a load error and retries", () => {
    hookResult = makeHook({
      rows: [],
      error: new Error("boom"),
    });
    renderCard();

    expect(screen.getByText("Could not load skill permissions.")).toBeDefined();
    fireEvent.click(screen.getByRole("button", { name: "Retry" }));
    expect(refetchCalls).toBe(1);
  });
});
