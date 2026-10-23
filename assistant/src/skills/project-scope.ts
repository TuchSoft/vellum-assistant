import { statSync } from "node:fs";

import { getBundledSkillsDir } from "../config/bundled-skills-dir.js";
import { loadSkillCatalog, type SkillSummary } from "../config/skills.js";
import { getLogger } from "../util/logger.js";
import {
  getWorkspacePluginsDir,
  getWorkspaceSkillsDir,
} from "../util/platform.js";
import { readWorkspaceSkillMdSignature } from "./workspace-skill-md-signature.js";

const log = getLogger("skill-project-scope");

/**
 * Project scoping for skills.
 *
 * A skill may declare `projects` in its frontmatter. Unset or empty means the
 * skill is available everywhere; a non-empty list restricts it to conversations
 * whose inherited project set intersects it. Unlike memory (soft, advisory),
 * skills are executable code, so the boundary is hard: the catalog used by
 * `skill_load` excludes out-of-scope skills and loading one is an explicit
 * error rather than a silent miss.
 *
 * The filtered catalog is cached per project set because the caller is on a
 * per-turn path and `loadSkillCatalog()` walks and parses every `SKILL.md`. The
 * cache is keyed by a cheap on-disk signature of the skill roots, so an install,
 * delete or frontmatter edit invalidates it on the next read, and
 * {@link invalidateSkillProjectScopeCache} covers the catalog changes that touch
 * config rather than `SKILL.md` (enable/disable).
 */

interface CatalogSnapshot {
  /** On-disk signature the cached catalog was built from. */
  signature: string;
  catalog: SkillSummary[];
}

let baseSnapshot: CatalogSnapshot | null = null;
const scopedSnapshots = new Map<string, CatalogSnapshot>();

/**
 * Cheap change detector for the skill roots the catalog reads. Bundled and
 * managed roots contribute a per-skill `SKILL.md` mtime list (the same shape
 * `loadSkillCatalog` walks), plugins contribute their root directory mtime
 * (installs and removals bump it; inner edits are covered by the explicit
 * invalidation the catalog-change paths call).
 */
function skillCatalogSignature(): string {
  const pluginsDir = getWorkspacePluginsDir();
  let pluginsStamp = "";
  try {
    pluginsStamp = String(Math.trunc(statSync(pluginsDir).mtimeMs));
  } catch {
    // Missing plugins root: nothing to contribute.
  }

  return [
    readWorkspaceSkillMdSignature(getBundledSkillsDir()),
    readWorkspaceSkillMdSignature(getWorkspaceSkillsDir()),
    pluginsStamp,
  ].join("\n");
}

/**
 * Drop every cached catalog. Call after a catalog change that does not touch
 * `SKILL.md` on disk (enable/disable), or to be explicit alongside a write that
 * does.
 */
export function invalidateSkillProjectScopeCache(): void {
  baseSnapshot = null;
  scopedSnapshots.clear();
}

function currentBaseCatalog(): SkillSummary[] {
  const signature = skillCatalogSignature();
  if (baseSnapshot && baseSnapshot.signature === signature) {
    return baseSnapshot.catalog;
  }
  try {
    baseSnapshot = { signature, catalog: loadSkillCatalog() };
  } catch (err) {
    // Never let a catalog read failure hide every skill: serve an empty scoped
    // view for this call and retry on the next one.
    log.warn({ err }, "Skill catalog read failed while scoping by project");
    baseSnapshot = { signature, catalog: [] };
  }
  scopedSnapshots.clear();
  return baseSnapshot.catalog;
}

/** Stable cache key for a project set (order- and duplicate-insensitive). */
export function projectSetKey(projectIds: readonly string[]): string {
  return [...new Set(projectIds)].sort().join("\u0000");
}

/**
 * Whether a skill is available to a conversation whose inherited project set is
 * `projectIds`. A skill without `projects` is available everywhere; a skill with
 * `projects` needs at least one shared id.
 */
export function isSkillInProjectScope(
  skill: Pick<SkillSummary, "projects">,
  projectIds: readonly string[],
): boolean {
  const required = skill.projects;
  if (!required || required.length === 0) {
    return true;
  }
  if (projectIds.length === 0) {
    return false;
  }
  const allowed = new Set(required);
  return projectIds.some((id) => allowed.has(id));
}

/** The subset of `catalog` available to a conversation's project set. */
export function filterSkillCatalogByProjectScope<
  T extends Pick<SkillSummary, "projects">,
>(catalog: readonly T[], projectIds: readonly string[]): T[] {
  return catalog.filter((skill) => isSkillInProjectScope(skill, projectIds));
}

/**
 * The project-scoped skill catalog for one conversation, cached per project set
 * and invalidated when the catalog changes.
 */
export function loadProjectScopedSkillCatalog(
  projectIds: readonly string[],
): SkillSummary[] {
  const base = currentBaseCatalog();
  const key = projectSetKey(projectIds);
  const cached = scopedSnapshots.get(key);
  if (cached && cached.signature === baseSnapshot?.signature) {
    return cached.catalog;
  }
  const catalog = filterSkillCatalogByProjectScope(base, projectIds);
  scopedSnapshots.set(key, {
    signature: baseSnapshot?.signature ?? "",
    catalog,
  });
  return catalog;
}

/**
 * The message for an out-of-scope load attempt. Names the skill and the
 * projects it requires; empty project sets render as `none`.
 */
export function skillProjectScopeErrorMessage(
  skill: Pick<SkillSummary, "id" | "projects">,
  projectIds: readonly string[],
): string {
  const required = (skill.projects ?? []).map((id) => `"${id}"`).join(", ");
  const current =
    projectIds.length > 0
      ? projectIds.map((id) => `"${id}"`).join(", ")
      : "none";
  return `skill "${skill.id}" is restricted to project(s) ${required}; this conversation is in project set ${current}.`;
}

/** @internal Test-only: drop the cached snapshots. */
export function _resetSkillProjectScopeCacheForTest(): void {
  invalidateSkillProjectScopeCache();
}
