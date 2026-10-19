import { computeSkillVersionHash as computeSkillContentHash } from "./skill-content-hash.js";

/**
 * Compute the deterministic content version hash for a skill directory.
 *
 * The implementation lives in `skill-content-hash.ts` so capability tests can
 * import it directly; this module keeps the public import path stable.
 */
export function computeSkillVersionHash(skillDir: string): string {
  return computeSkillContentHash(skillDir);
}
