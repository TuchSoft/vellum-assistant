import { existsSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import { beforeEach, describe, expect, test } from "bun:test";

import {
  BundledSkillCapabilityDefaultsSchema,
  type SkillCapability,
} from "@vellumai/service-contracts/skill-capabilities";

import capabilityDefaults from "../config/bundled-skills.capabilities.json" with { type: "json" };
import { getBundledSkillsDir } from "../config/skills.js";
import {
  _clearSkillCapabilityCacheForTest,
  getSkillCapabilities,
} from "../skills/capabilities.js";
import { parseToolManifestFile } from "../skills/tool-manifest.js";
import { computeSkillVersionHash } from "../skills/version-hash.js";

interface ExpectedEntry {
  versionHash: string;
  capabilities: SkillCapability[];
}

function expectedCapabilities(directory: string): SkillCapability[] {
  const capabilities: SkillCapability[] = ["vetted", "input_repairs"];
  const toolsPath = join(directory, "TOOLS.json");
  if (existsSync(toolsPath)) {
    const manifest = parseToolManifestFile(toolsPath);
    if (manifest.tools.some((tool) => tool.execution_target === "host")) {
      capabilities.push("host_exec");
    }
  }
  if (basename(directory) === "computer-use") {
    capabilities.push("computer_use_target");
  }
  return capabilities;
}

function buildExpectedManifest(): Record<string, ExpectedEntry> {
  const bundledDir = getBundledSkillsDir();
  const directories = readdirSync(bundledDir, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => join(bundledDir, entry.name))
    .filter((directory) => existsSync(join(directory, "SKILL.md")))
    .sort((a, b) => a.localeCompare(b));

  const expected: Record<string, ExpectedEntry> = {};
  for (const directory of directories) {
    expected[basename(directory)] = {
      versionHash: computeSkillVersionHash(directory),
      capabilities: expectedCapabilities(directory),
    };
  }
  return expected;
}

describe("bundled skill capability manifest", () => {
  test("matches the current bundled skill content", () => {
    const parsed =
      BundledSkillCapabilityDefaultsSchema.safeParse(capabilityDefaults);
    expect(parsed.success).toBe(true);
    if (!parsed.success) {
      return;
    }

    const expected = buildExpectedManifest();
    expect(Object.keys(parsed.data.skills).sort()).toEqual(
      Object.keys(expected).sort(),
    );
    for (const [skillId, entry] of Object.entries(expected)) {
      const actual = parsed.data.skills[skillId];
      // Regenerate with `bun run generate:skill-capabilities` when this fails.
      expect(actual?.versionHash).toBe(entry.versionHash);
      expect([...(actual?.capabilities ?? [])].sort()).toEqual(
        [...entry.capabilities].sort(),
      );
    }
  });
});

describe("getSkillCapabilities", () => {
  const bundledDir = getBundledSkillsDir();
  const expected = buildExpectedManifest();

  beforeEach(() => {
    _clearSkillCapabilityCacheForTest();
  });

  test("grants a bundled skill's defaults for the matching hash", () => {
    const longRun = expected["long-run"];
    const capabilities = getSkillCapabilities({
      skillId: "long-run",
      versionHash: longRun.versionHash,
      directoryPath: join(bundledDir, "long-run"),
    });

    expect(capabilities).toEqual({
      host_exec: true,
      vetted: true,
      input_repairs: true,
      computer_use_target: false,
    });
  });

  test("grants computer_use_target only to computer-use", () => {
    const computerUse = expected["computer-use"];
    const capabilities = getSkillCapabilities({
      skillId: "computer-use",
      versionHash: computerUse.versionHash,
      directoryPath: join(bundledDir, "computer-use"),
    });

    expect(capabilities.computer_use_target).toBe(true);
  });

  test("an instruction-only bundled skill has no host_exec", () => {
    const visualize = expected.visualize;
    const capabilities = getSkillCapabilities({
      skillId: "visualize",
      versionHash: visualize.versionHash,
      directoryPath: join(bundledDir, "visualize"),
    });

    expect(capabilities).toEqual({
      host_exec: false,
      vetted: true,
      input_repairs: true,
      computer_use_target: false,
    });
  });

  test("a modified content hash inherits nothing", () => {
    const capabilities = getSkillCapabilities({
      skillId: "long-run",
      versionHash: "v1:modified-content",
      directoryPath: join(bundledDir, "long-run"),
    });

    expect(capabilities.host_exec).toBe(false);
    expect(capabilities.vetted).toBe(false);
    expect(capabilities.input_repairs).toBe(false);
  });

  test("a same-named skill outside the bundled directory inherits nothing", () => {
    const capabilities = getSkillCapabilities({
      skillId: "long-run",
      versionHash: expected["long-run"].versionHash,
      directoryPath: join(tmpdir(), "long-run"),
    });

    expect(capabilities).toEqual({
      host_exec: false,
      vetted: false,
      input_repairs: false,
      computer_use_target: false,
    });
  });

  test("rejects ids that are not a single path segment", () => {
    const capabilities = getSkillCapabilities({
      skillId: "../long-run",
      versionHash: expected["long-run"].versionHash,
      directoryPath: join(bundledDir, "long-run"),
    });

    expect(capabilities.host_exec).toBe(false);
  });
});
