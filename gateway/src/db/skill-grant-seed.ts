/**
 * Seeds default grants for the skill versions the assistant declares.
 *
 * The assistant knows which skills it has and what their content hashes are
 * (it owns the skill directories); the gateway knows which capabilities a fresh
 * version of a skill may have. Neither can do the other's half, so the
 * assistant declares `(skillId, versionHash)` pairs and the gateway applies its
 * own defaults document to the pairs it has nothing for.
 *
 * The declaration is a statement of fact, not a request: a skill id the
 * defaults document does not name gets nothing, and nothing here can widen a
 * grant beyond what the document already allows.
 *
 * Rules:
 * - An existing grant is never touched, whatever its `grantedBy`.
 * - A revoked version is never resurrected (the tombstone wins over the
 *   default; an explicit write clears the tombstone).
 * - A skill with no entry, or an empty entry, is left unseeded.
 *
 * The seed is idempotent: re-running it is a no-op once every declared pair is
 * decided, so a declaration that fails halfway is simply completed by the next
 * one.
 */

import type { SkillCapability } from "@vellumai/service-contracts/skill-capabilities";

import { getLogger } from "../logger.js";

import { loadSkillGrantDefaults } from "./skill-grant-defaults.js";
import {
  getSkillGrant,
  isSkillGrantRevoked,
  upsertSkillGrant,
} from "./skill-grant-store.js";

const log = getLogger("skill-grant-seed");

/** The principal recorded on a grant this seed created. */
export const DEFAULT_GRANT_PRINCIPAL = "defaults";

export interface DeclaredSkillVersion {
  skillId: string;
  versionHash: string;
}

export type SkillGrantSeedSkipReason = "existing" | "revoked" | "no_default";

export interface SkillGrantSeedResult {
  seeded: Array<{
    skillId: string;
    versionHash: string;
    capabilities: SkillCapability[];
  }>;
  skipped: Array<{
    skillId: string;
    versionHash: string;
    reason: SkillGrantSeedSkipReason;
  }>;
}

function dedupe(
  declared: readonly DeclaredSkillVersion[],
): DeclaredSkillVersion[] {
  const seen = new Set<string>();
  const unique: DeclaredSkillVersion[] = [];
  for (const entry of declared) {
    const key = `${entry.skillId}\0${entry.versionHash}`;
    if (seen.has(key)) {
      continue;
    }
    seen.add(key);
    unique.push(entry);
  }
  return unique;
}

/**
 * Apply the defaults document to every declared skill version that has no
 * decision yet. Returns what was created and what was left alone, so the caller
 * can log or assert on it.
 */
export function seedSkillGrantsFromDefaults(
  declared: readonly DeclaredSkillVersion[],
): SkillGrantSeedResult {
  const defaults = loadSkillGrantDefaults();
  const result: SkillGrantSeedResult = { seeded: [], skipped: [] };

  for (const { skillId, versionHash } of dedupe(declared)) {
    if (getSkillGrant(skillId, versionHash) !== null) {
      result.skipped.push({ skillId, versionHash, reason: "existing" });
      continue;
    }

    if (isSkillGrantRevoked(skillId, versionHash)) {
      result.skipped.push({ skillId, versionHash, reason: "revoked" });
      continue;
    }

    const capabilities = defaults[skillId] ?? [];
    if (capabilities.length === 0) {
      result.skipped.push({ skillId, versionHash, reason: "no_default" });
      continue;
    }

    const grant = upsertSkillGrant({
      skillId,
      versionHash,
      capabilities,
      grantedBy: DEFAULT_GRANT_PRINCIPAL,
    });
    result.seeded.push({
      skillId,
      versionHash,
      capabilities: grant.capabilities,
    });
  }

  if (result.seeded.length > 0) {
    log.info(
      {
        seeded: result.seeded.length,
        skipped: result.skipped.length,
      },
      "Seeded skill grants from the defaults document",
    );
  }

  return result;
}
