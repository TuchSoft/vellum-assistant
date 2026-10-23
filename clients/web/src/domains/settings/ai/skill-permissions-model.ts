/**
 * View-model derivation for the skill permission card.
 *
 * The gateway stores one grant per `(skillId, versionHash)`. The card shows
 * one row per installed skill and needs three things from that raw data: the
 * grant that applies to the version installed right now, any grant left over
 * from an earlier version, and whether the skill has no grant at all.
 *
 * The classification lives here, separate from React, so the states are
 * covered by a plain unit test instead of only through the rendered card.
 */

import type { SkillCapability, SkillGrant } from "@/lib/skill-grants-api";

export interface InstalledSkill {
  id: string;
  name: string;
  emoji?: string;
  kind: "bundled" | "installed" | "catalog";
  status: "enabled" | "disabled" | "available";
}

/**
 * - `granted`: a grant exists for the installed version.
 * - `version_changed`: grants exist, but none for the installed version.
 * - `denied`: no grant exists for any version.
 * - `unavailable`: the installed version could not be read, so no grant can
 *   be addressed.
 */
export type SkillPermissionStatus =
  "granted" | "version_changed" | "denied" | "unavailable";

export interface SkillPermissionRow {
  skill: InstalledSkill;
  versionHash: string | null;
  /** Short form of the installed version, for display. */
  shortVersion: string | null;
  status: SkillPermissionStatus;
  /** Capabilities of the grant that applies to the installed version. */
  capabilities: SkillCapability[];
  /** Principal on the current grant; null when it was written out of band. */
  grantedBy: string | null;
  /** Grants for versions other than the installed one, newest first. */
  staleGrants: SkillGrant[];
}

/**
 * Shorten a version hash for display: drop the algorithm prefix and keep the
 * first eight hex characters. The full value stays available in the row.
 */
export function shortVersionHash(hash: string): string {
  const separator = hash.indexOf(":");
  const body = separator === -1 ? hash : hash.slice(separator + 1);
  return body.slice(0, 8);
}

function newestFirst(grants: readonly SkillGrant[]): SkillGrant[] {
  return [...grants].sort((a, b) => b.updatedAt - a.updatedAt);
}

function classifyStatus(
  current: SkillGrant | undefined,
  staleGrants: readonly SkillGrant[],
): SkillPermissionStatus {
  if (current) {
    // A row with an empty capability set grants nothing, so it reads as
    // denied even though the version is already addressed.
    return current.capabilities.length > 0 ? "granted" : "denied";
  }
  return staleGrants.length > 0 ? "version_changed" : "denied";
}

/**
 * Group grants by skill and classify every installed skill.
 *
 * `versionHashes` maps a skill id to the version installed right now. A skill
 * missing from the map (or mapped to null) is `unavailable`: without the
 * version there is no address to grant against, so the card must not offer a
 * write.
 */
export function buildSkillPermissionRows(
  skills: readonly InstalledSkill[],
  versionHashes: Readonly<Record<string, string | null>>,
  grants: readonly SkillGrant[],
): SkillPermissionRow[] {
  const grantsBySkill = new Map<string, SkillGrant[]>();
  for (const grant of grants) {
    const existing = grantsBySkill.get(grant.skillId);
    if (existing) {
      existing.push(grant);
    } else {
      grantsBySkill.set(grant.skillId, [grant]);
    }
  }

  const rows: SkillPermissionRow[] = [];
  for (const skill of skills) {
    // Catalog entries that are not installed have no version on disk and no
    // grant to manage.
    if (skill.status === "available" || skill.kind === "catalog") {
      continue;
    }

    const versionHash = versionHashes[skill.id] ?? null;
    const allGrants = newestFirst(grantsBySkill.get(skill.id) ?? []);

    if (versionHash === null) {
      rows.push({
        skill,
        versionHash: null,
        shortVersion: null,
        status: "unavailable",
        capabilities: [],
        grantedBy: null,
        staleGrants: allGrants,
      });
      continue;
    }

    const current = allGrants.find(
      (grant) => grant.versionHash === versionHash,
    );
    const staleGrants = allGrants.filter(
      (grant) => grant.versionHash !== versionHash,
    );

    rows.push({
      skill,
      versionHash,
      shortVersion: shortVersionHash(versionHash),
      status: classifyStatus(current, staleGrants),
      capabilities: current ? [...current.capabilities] : [],
      grantedBy: current?.grantedBy ?? null,
      staleGrants,
    });
  }

  rows.sort((a, b) => {
    const aEnabled = a.skill.status === "enabled" ? 0 : 1;
    const bEnabled = b.skill.status === "enabled" ? 0 : 1;
    if (aEnabled !== bEnabled) {
      return aEnabled - bEnabled;
    }
    return a.skill.name.localeCompare(b.skill.name);
  });

  return rows;
}

/**
 * Canonical capability order. Mirrors `@vellumai/service-contracts`, which the
 * gateway uses to normalize a stored set; keeping the same order means a
 * toggle round-trip never reorders the payload.
 */
export const SKILL_CAPABILITY_ORDER: readonly SkillCapability[] = [
  "host_exec",
  "vetted",
  "input_repairs",
  "computer_use_target",
];

/** Toggle one capability in a set, preserving the contract's order. */
export function toggleCapability(
  capabilities: readonly SkillCapability[],
  capability: SkillCapability,
  enabled: boolean,
): SkillCapability[] {
  const next = new Set(capabilities);
  if (enabled) {
    next.add(capability);
  } else {
    next.delete(capability);
  }
  return SKILL_CAPABILITY_ORDER.filter((entry) => next.has(entry));
}
