// ---------------------------------------------------------------------------
// Memory substrate - Project scope
// ---------------------------------------------------------------------------
//
// A concept page can belong to one or more projects and can be *exclusive* to
// them. The scope lives in the page frontmatter (`projects:` / `exclusive:`),
// never in a database column, and it is a soft retrieval hint, not security:
// it keeps unrelated project memory out of the automatic lanes and out of
// `recall`, while direct access by path or slug always works.
//
// This module is the SINGLE place the visibility rule is written:
//
//     not exclusive OR projects intersects visible
//
// `isProjectScopeVisible` is that rule in process; `projectScopeFilter` is the
// same rule translated to a Qdrant filter so the dense lane can apply it
// server-side. Every lane (dense, needle, entity, rare, edge, recall) calls the
// in-process form, so the lanes cannot drift from each other.
//
// The scope is resolved per turn from the conversation's project set plus every
// descendant project (inheritance flows down, never up).

import type { Schemas } from "@qdrant/js-client-rest";

import type { ConceptPageFrontmatter } from "./types.js";

/** A page's resolved project scope. `projects: []` means global. */
export interface PageProjectScope {
  projects: string[];
  exclusive: boolean;
}

/** The scope a page declares. `undefined` means "not declared", which is what
 *  the rewrite guard needs to distinguish from an explicit empty/false. */
export interface DeclaredProjectScope {
  projects?: string[];
  exclusive?: boolean;
}

/** The default scope: global, non-exclusive. */
export const GLOBAL_PROJECT_SCOPE: PageProjectScope = {
  projects: [],
  exclusive: false,
};

/**
 * Boost applied to a finder candidate whose page belongs to a project of the
 * conversation itself. Applied AFTER the lanes merge, never inside Qdrant:
 * cosine similarity has no per-document weight.
 */
export const PROJECT_BOOST_FULL = 1;

/** Boost applied when the page belongs only to a descendant (or ancestor
 *  project) of the conversation's projects. Attenuated: the page is relevant
 *  to the project family, not to the conversation's own work. */
export const PROJECT_BOOST_RELATED = 0.5;

/** Dedupe project ids, dropping empties, preserving order. */
function normalizeProjectIds(ids: readonly string[] | undefined): string[] {
  if (!ids) {
    return [];
  }
  const seen = new Set<string>();
  const out: string[] = [];
  for (const raw of ids) {
    const id = raw.trim();
    if (id.length === 0 || seen.has(id)) {
      continue;
    }
    seen.add(id);
    out.push(id);
  }
  return out;
}

/** The scope a page DECLARES, preserving absence (do not default here). */
export function declaredScopeFromFrontmatter(
  frontmatter: Pick<ConceptPageFrontmatter, "projects" | "exclusive">,
): DeclaredProjectScope {
  return {
    ...(frontmatter.projects !== undefined
      ? { projects: normalizeProjectIds(frontmatter.projects) }
      : {}),
    ...(frontmatter.exclusive !== undefined
      ? { exclusive: frontmatter.exclusive }
      : {}),
  };
}

/** A page's resolved scope: absent fields fall back to global/non-exclusive. */
export function resolveProjectScope(
  declared: DeclaredProjectScope,
): PageProjectScope {
  return {
    projects: normalizeProjectIds(declared.projects),
    exclusive: declared.exclusive ?? false,
  };
}

/** A page's resolved scope straight from its frontmatter. */
export function projectScopeFromFrontmatter(
  frontmatter: Pick<ConceptPageFrontmatter, "projects" | "exclusive">,
): PageProjectScope {
  return resolveProjectScope(declaredScopeFromFrontmatter(frontmatter));
}

/**
 * The anti-loss rewrite guard.
 *
 * A consolidation rewrite is a whole-file LLM edit: a page rewritten without
 * `projects:` must not silently lose its project membership. Each field falls
 * back to the previous value only when the incoming page OMITTED it:
 *
 *     projects  = incoming.projects  ?? previous.projects  ?? []
 *     exclusive = incoming.exclusive ?? previous.exclusive ?? false
 *
 * An explicit `projects: []` / `exclusive: false` in the rewrite still clears
 * the value, so the agent can change membership by writing it.
 */
export function mergeProjectScope(
  incoming: DeclaredProjectScope,
  previous?: DeclaredProjectScope,
): PageProjectScope {
  return resolveProjectScope({
    projects: incoming.projects ?? previous?.projects,
    exclusive: incoming.exclusive ?? previous?.exclusive,
  });
}

/**
 * THE predicate. A page is retrievable when it is not exclusive, or when at
 * least one of its owning projects is in the turn's visible set.
 *
 * `visible` is the conversation's project set plus every descendant project.
 * An empty set therefore means "global content only", not "everything".
 */
export function isProjectScopeVisible(
  scope: PageProjectScope,
  visible: ReadonlySet<string>,
): boolean {
  if (!scope.exclusive) {
    return true;
  }
  return scope.projects.some((project) => visible.has(project));
}

/** {@link isProjectScopeVisible} for an optional per-page scope: an unknown
 *  page (no scope recorded) is global and therefore visible. */
export function isArticleScopeVisible(
  scope: PageProjectScope | undefined,
  visible: ReadonlySet<string>,
): boolean {
  return isProjectScopeVisible(scope ?? GLOBAL_PROJECT_SCOPE, visible);
}

/**
 * Deterministic boost for a page in a finder lane.
 *
 * - full when the page belongs to one of the conversation's OWN projects,
 * - attenuated when it belongs only to a related project (a descendant of a
 *   conversation project, i.e. in `visible` but not in `own`),
 * - zero otherwise (including global pages).
 */
export function projectScopeBoost(
  scope: PageProjectScope | undefined,
  ownProjects: ReadonlySet<string>,
  visibleProjects: ReadonlySet<string>,
): number {
  const projects = scope?.projects ?? [];
  if (projects.some((project) => ownProjects.has(project))) {
    return PROJECT_BOOST_FULL;
  }
  if (projects.some((project) => visibleProjects.has(project))) {
    return PROJECT_BOOST_RELATED;
  }
  return 0;
}

/**
 * The Qdrant translation of {@link isProjectScopeVisible}, for the dense lane.
 *
 * `min_should` (at least one condition) expresses the OR:
 *
 *   - `exclusive == false`,
 *   - `exclusive` is absent (points indexed before the field existed are
 *     global and must stay visible; this is the stale-payload tolerance),
 *   - `projects` matches any visible project.
 *
 * The `projects` condition is omitted when nothing is visible, so the filter
 * never sends an empty `any` list.
 */
export function projectScopeFilter(
  visible: ReadonlySet<string>,
): Schemas["Filter"] {
  const conditions: NonNullable<Schemas["MinShould"]>["conditions"] = [
    { key: "exclusive", match: { value: false } },
    { is_empty: { key: "exclusive" } },
  ];
  const projects = [...visible];
  if (projects.length > 0) {
    conditions.push({ key: "projects", match: { any: projects } });
  }
  return { min_should: { conditions, min_count: 1 } };
}

/** The payload fields a section/page point carries for the scope filter. */
export function projectScopePayload(scope: PageProjectScope): {
  projects: string[];
  exclusive: boolean;
} {
  return {
    projects: [...scope.projects],
    exclusive: scope.exclusive,
  };
}
