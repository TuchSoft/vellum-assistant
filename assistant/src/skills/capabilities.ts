import { join, resolve } from "node:path";

import {
  BundledSkillCapabilityDefaultsSchema,
  NO_SKILL_CAPABILITIES,
  type SkillCapabilities,
  type SkillCapability,
} from "@vellumai/service-contracts/skill-capabilities";

import bundledCapabilityDefaults from "../config/bundled-skills.capabilities.json" with { type: "json" };
import { getBundledSkillsDir } from "../config/bundled-skills-dir.js";
import { getLogger } from "../util/logger.js";

const log = getLogger("skill-capabilities");

const parsedDefaults = BundledSkillCapabilityDefaultsSchema.safeParse(
  bundledCapabilityDefaults,
);
if (!parsedDefaults.success) {
  log.error(
    { issues: parsedDefaults.error.issues },
    "Bundled skill capability manifest is invalid; no defaults are available",
  );
}

const defaults = parsedDefaults.success ? parsedDefaults.data.skills : {};

/**
 * Resolved capabilities are pure functions of (skill id, version hash,
 * directory). The manifest is static for the life of the process, so the
 * cache only avoids repeated path resolution and object construction.
 */
const capabilityCache = new Map<string, SkillCapabilities>();

/**
 * Test seam: lets suite files that mock `config/skills.js` keep the resolver
 * pointed at the real bundled directory. Production never sets this.
 */
let bundledSkillsDirOverride: string | null = null;

function resolveBundledSkillsDir(): string {
  return bundledSkillsDirOverride ?? getBundledSkillsDir();
}

export interface SkillCapabilityLookup {
  skillId: string;
  versionHash?: string;
  directoryPath?: string;
}

function capabilitiesFromList(
  capabilities: readonly SkillCapability[],
): SkillCapabilities {
  const set = new Set(capabilities);
  return {
    host_exec: set.has("host_exec"),
    vetted: set.has("vetted"),
    input_repairs: set.has("input_repairs"),
    computer_use_target: set.has("computer_use_target"),
  };
}

function cacheKey(input: SkillCapabilityLookup, directoryPath: string): string {
  return `${input.skillId}\0${input.versionHash}\0${directoryPath}`;
}

/**
 * Resolve the capability set for one skill version.
 *
 * Defaults are scoped to bundled skills: the skill must live at
 * `<bundledSkillsDir>/<skillId>` and its version hash must match the manifest
 * entry. A managed or workspace skill that reuses a bundled id, or a bundled
 * skill whose content changed since the manifest was generated, gets the
 * fail-closed empty set.
 */
export function getSkillCapabilities(
  input: SkillCapabilityLookup,
): SkillCapabilities {
  const { skillId, versionHash, directoryPath } = input;
  if (!skillId || !versionHash || !directoryPath) {
    return NO_SKILL_CAPABILITIES;
  }
  // Skill ids are directory basenames. Reject separators so an id can never
  // point the manifest lookup at another directory.
  if (skillId.includes("/") || skillId.includes("\\")) {
    return NO_SKILL_CAPABILITIES;
  }

  const resolvedDirectory = resolve(directoryPath);
  const key = cacheKey(input, resolvedDirectory);
  const cached = capabilityCache.get(key);
  if (cached) {
    return cached;
  }

  const bundledDirectory = resolve(join(resolveBundledSkillsDir(), skillId));
  if (resolvedDirectory !== bundledDirectory) {
    capabilityCache.set(key, NO_SKILL_CAPABILITIES);
    return NO_SKILL_CAPABILITIES;
  }

  const entry = defaults[skillId];
  if (!entry || entry.versionHash !== versionHash) {
    capabilityCache.set(key, NO_SKILL_CAPABILITIES);
    return NO_SKILL_CAPABILITIES;
  }

  const capabilities = capabilitiesFromList(entry.capabilities);
  capabilityCache.set(key, capabilities);
  return capabilities;
}

/** Whether one capability is granted for the given skill version. */
export function hasSkillCapability(
  input: SkillCapabilityLookup,
  capability: SkillCapability,
): boolean {
  return getSkillCapabilities(input)[capability];
}

/** Clear the memoized capability sets. Exported for tests. */
export function _clearSkillCapabilityCacheForTest(): void {
  capabilityCache.clear();
}

/** Point the resolver at a specific bundled directory. Exported for tests. */
export function _setBundledSkillsDirForTest(directory: string | null): void {
  bundledSkillsDirOverride = directory;
  capabilityCache.clear();
}
