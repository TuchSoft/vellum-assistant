/**
 * Generate the build-time capability manifest for bundled skills.
 *
 * Every bundled skill gets `vetted` and `input_repairs`. `host_exec` is added
 * when at least one tool declares `execution_target: "host"`, and
 * `computer_use_target` is added only for the `computer-use` skill. The
 * version hash binds each entry to the exact content it was generated from.
 *
 * Run from `assistant/`: `bun run generate:skill-capabilities`.
 */
import { existsSync, readdirSync, writeFileSync } from "node:fs";
import { basename, join, resolve } from "node:path";

import {
  type BundledSkillCapabilityDefaults,
  SKILL_CAPABILITIES,
  type SkillCapability,
} from "@vellumai/service-contracts/skill-capabilities";

import { getBundledSkillsDir } from "../src/config/bundled-skills-dir.js";
import { computeSkillVersionHash } from "../src/skills/skill-content-hash.js";
import { parseToolManifestFile } from "../src/skills/tool-manifest.js";

const CAPABILITY_ORDER = new Map(
  SKILL_CAPABILITIES.map((capability, index) => [capability, index]),
);

function sortCapabilities(
  capabilities: readonly SkillCapability[],
): SkillCapability[] {
  return [...new Set(capabilities)].sort(
    (a, b) => CAPABILITY_ORDER.get(a)! - CAPABILITY_ORDER.get(b)!,
  );
}

const bundledDir = getBundledSkillsDir();
const skillDirs = readdirSync(bundledDir, { withFileTypes: true })
  .filter((entry) => entry.isDirectory())
  .map((entry) => join(bundledDir, entry.name))
  .filter((directory) => existsSync(join(directory, "SKILL.md")))
  .sort((a, b) => a.localeCompare(b));

const skills: BundledSkillCapabilityDefaults["skills"] = {};

for (const directory of skillDirs) {
  const skillId = basename(directory);
  const capabilities: SkillCapability[] = ["vetted", "input_repairs"];

  const toolsPath = join(directory, "TOOLS.json");
  if (existsSync(toolsPath)) {
    const manifest = parseToolManifestFile(toolsPath);
    if (manifest.tools.some((tool) => tool.execution_target === "host")) {
      capabilities.push("host_exec");
    }
  }

  if (skillId === "computer-use") {
    capabilities.push("computer_use_target");
  }

  skills[skillId] = {
    versionHash: computeSkillVersionHash(directory),
    capabilities: sortCapabilities(capabilities),
  };
}

const output: BundledSkillCapabilityDefaults = { version: 1, skills };
const outputPath = resolve(
  import.meta.dir,
  "../src/config/bundled-skills.capabilities.json",
);

writeFileSync(outputPath, `${JSON.stringify(output, null, 2)}\n`);
console.log(
  `Wrote ${Object.keys(skills).length} bundled skill capability entries to ${outputPath}`,
);
