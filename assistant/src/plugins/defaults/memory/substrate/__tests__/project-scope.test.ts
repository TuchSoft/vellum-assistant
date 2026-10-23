/**
 * Tests for project scope (WS-26 F2): the frontmatter schema fields, the
 * single visibility predicate, the Qdrant translation, the rewrite guard, the
 * boost, and the recall filter.
 *
 * Coverage matrix (the eight cases from the F2 brief):
 *   1. a global page is visible to a conversation with no projects;
 *   2. a page of one project is visible to that project;
 *   3. an exclusive page is excluded from a conversation without that project;
 *   4. a conversation in two projects sees pages of both;
 *   5. a conversation without projects sees global pages only (non-exclusive
 *      project pages stay visible: exclusion needs `exclusive: true`);
 *   6. `recall` is filtered by the same predicate (lexical arm, end to end);
 *   7. direct access by slug is never filtered;
 *   8. the rewrite guard keeps `projects`/`exclusive` when a rewrite omits them.
 *
 * Tests use temp workspaces under `os.tmpdir()`; they never touch `~/.vellum/`.
 */

import { existsSync, mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";

// ---------------------------------------------------------------------------
// Mocks: a programmable project visibility source and a dead embedding
// backend, so the recall test exercises the lexical arm deterministically.
// Installed BEFORE the dynamic imports below.
// ---------------------------------------------------------------------------

const projectState: { own: string[]; visible: string[]; fail: boolean } = {
  own: [],
  visible: [],
  fail: false,
};

mock.module("../../../../../persistence/project-store.js", () => ({
  resolveVisibleProjectIds: async () => {
    if (projectState.fail) {
      throw new Error("main db unavailable");
    }
    return { own: projectState.own, visible: projectState.visible };
  },
}));

mock.module("../../../../../persistence/embeddings/embed.js", () => ({
  embedWithRetry: async () => {
    throw new Error("no embedding backend in tests");
  },
}));

const projectScope = await import("../project-scope.js");
const { readPage, writePage } = await import("../page-store.js");
const { searchMemoryV2Source } =
  await import("../../context-search/sources/memory-v2.js");
const { invalidatePageIndex } = await import("../page-index.js");
const { invalidateEdgeIndex } = await import("../edge-index.js");
const { ConceptPageFrontmatterSchema } = await import("../types.js");

const {
  GLOBAL_PROJECT_SCOPE,
  isArticleScopeVisible,
  isProjectScopeVisible,
  mergeProjectScope,
  projectScopeBoost,
  projectScopeFilter,
  projectScopeFromFrontmatter,
  PROJECT_BOOST_FULL,
  PROJECT_BOOST_RELATED,
} = projectScope;

type AssistantConfig = Parameters<typeof searchMemoryV2Source>[1]["config"];

let workspaceDir: string;

beforeEach(() => {
  workspaceDir = mkdtempSync(join(tmpdir(), "vellum-project-scope-test-"));
  mkdirSync(join(workspaceDir, "memory", "concepts"), { recursive: true });
  projectState.own = [];
  projectState.visible = [];
  projectState.fail = false;
});

afterEach(() => {
  invalidatePageIndex();
  invalidateEdgeIndex();
  if (existsSync(workspaceDir)) {
    rmSync(workspaceDir, { recursive: true, force: true });
  }
});

function scopePage(
  projects: string[] | undefined,
  exclusive: boolean | undefined,
): ReturnType<typeof projectScopeFromFrontmatter> {
  return projectScopeFromFrontmatter(
    ConceptPageFrontmatterSchema.parse({
      ...(projects !== undefined ? { projects } : {}),
      ...(exclusive !== undefined ? { exclusive } : {}),
    }),
  );
}

// ---------------------------------------------------------------------------
// Frontmatter schema
// ---------------------------------------------------------------------------

describe("project scope frontmatter", () => {
  test("declares projects/exclusive with no default, so absence stays visible", () => {
    const empty = ConceptPageFrontmatterSchema.parse({});
    expect(empty.projects).toBeUndefined();
    expect(empty.exclusive).toBeUndefined();
    expect(projectScopeFromFrontmatter(empty)).toEqual(GLOBAL_PROJECT_SCOPE);
  });

  test("rejects a wrong type on the declared fields", () => {
    expect(() =>
      ConceptPageFrontmatterSchema.parse({ projects: "cliente-x" }),
    ).toThrow();
    expect(() =>
      ConceptPageFrontmatterSchema.parse({ exclusive: "yes" }),
    ).toThrow();
  });
});

// ---------------------------------------------------------------------------
// The single predicate (cases 1-5)
// ---------------------------------------------------------------------------

describe("isProjectScopeVisible", () => {
  test("case 1: a global page is visible to a conversation with no projects", () => {
    expect(
      isProjectScopeVisible(scopePage(undefined, undefined), new Set()),
    ).toBe(true);
  });

  test("case 2: a page of one project is visible to that project", () => {
    expect(
      isProjectScopeVisible(
        scopePage(["cliente-x"], true),
        new Set(["cliente-x"]),
      ),
    ).toBe(true);
  });

  test("case 3: an exclusive page is excluded without its owning project", () => {
    expect(
      isProjectScopeVisible(
        scopePage(["cliente-x"], true),
        new Set(["cliente-y"]),
      ),
    ).toBe(false);
    expect(
      isProjectScopeVisible(scopePage(["cliente-x"], true), new Set()),
    ).toBe(false);
  });

  test("case 4: a conversation in two projects sees pages of both", () => {
    const visible = new Set(["cliente-x", "cliente-y"]);
    expect(isProjectScopeVisible(scopePage(["cliente-x"], true), visible)).toBe(
      true,
    );
    expect(isProjectScopeVisible(scopePage(["cliente-y"], true), visible)).toBe(
      true,
    );
    expect(isProjectScopeVisible(scopePage(["cliente-z"], true), visible)).toBe(
      false,
    );
  });

  test("case 5: a conversation without projects sees global AND non-exclusive project pages", () => {
    const none = new Set<string>();
    expect(isProjectScopeVisible(scopePage(["cliente-x"], false), none)).toBe(
      true,
    );
    expect(isProjectScopeVisible(scopePage(["cliente-x"], true), none)).toBe(
      false,
    );
  });

  test("a page with no scope recorded is global", () => {
    expect(isArticleScopeVisible(undefined, new Set())).toBe(true);
    expect(isArticleScopeVisible(undefined, new Set(["x"]))).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Qdrant translation and boost
// ---------------------------------------------------------------------------

describe("projectScopeFilter", () => {
  test("always excludes a missing `exclusive` (legacy points stay global)", () => {
    const filter = projectScopeFilter(new Set(["cliente-x"]));
    const conditions = (filter as { min_should: { conditions: unknown[] } })
      .min_should.conditions;
    expect(conditions).toContainEqual({
      is_empty: { key: "exclusive" },
    });
    expect(conditions).toContainEqual({
      key: "exclusive",
      match: { value: false },
    });
    expect(conditions).toContainEqual({
      key: "projects",
      match: { any: ["cliente-x"] },
    });
    expect(
      (filter as { min_should: { min_count: number } }).min_should.min_count,
    ).toBe(1);
  });

  test("omits the projects condition when nothing is visible", () => {
    const filter = projectScopeFilter(new Set());
    const conditions = (
      filter as { min_should: { conditions: Array<{ key?: string }> } }
    ).min_should.conditions;
    expect(conditions.some((condition) => condition.key === "projects")).toBe(
      false,
    );
  });
});

describe("projectScopeBoost", () => {
  test("full for the conversation's own project, attenuated for a descendant, zero otherwise", () => {
    const own = new Set(["cliente-x"]);
    const visible = new Set(["cliente-x", "cliente-x/fiscale"]);
    expect(
      projectScopeBoost(scopePage(["cliente-x"], true), own, visible),
    ).toBe(PROJECT_BOOST_FULL);
    expect(
      projectScopeBoost(scopePage(["cliente-x/fiscale"], true), own, visible),
    ).toBe(PROJECT_BOOST_RELATED);
    expect(projectScopeBoost(scopePage(["altro"], true), own, visible)).toBe(0);
    expect(
      projectScopeBoost(scopePage(undefined, undefined), own, visible),
    ).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// Rewrite guard (case 8)
// ---------------------------------------------------------------------------

describe("mergeProjectScope", () => {
  test("case 8: an omitted field keeps the previous value; an explicit one wins", () => {
    const previous = { projects: ["cliente-x"], exclusive: true };
    expect(mergeProjectScope({}, previous)).toEqual({
      projects: ["cliente-x"],
      exclusive: true,
    });
    expect(mergeProjectScope({ projects: ["cliente-y"] }, previous)).toEqual({
      projects: ["cliente-y"],
      exclusive: true,
    });
    expect(mergeProjectScope({ exclusive: false }, previous)).toEqual({
      projects: ["cliente-x"],
      exclusive: false,
    });
    expect(
      mergeProjectScope({ projects: [], exclusive: false }, previous),
    ).toEqual({ projects: [], exclusive: false });
    expect(mergeProjectScope({}, undefined)).toEqual(GLOBAL_PROJECT_SCOPE);
  });

  test("writePage keeps the scope when the incoming page omits it", async () => {
    const scoped = {
      slug: "cliente-x/contratto",
      frontmatter: ConceptPageFrontmatterSchema.parse({
        projects: ["cliente-x"],
        exclusive: true,
      }),
      body: "prima",
    };
    await writePage(workspaceDir, scoped);

    // A consolidation-style rewrite that drops the fields entirely.
    await writePage(workspaceDir, {
      slug: "cliente-x/contratto",
      frontmatter: ConceptPageFrontmatterSchema.parse({}),
      body: "dopo",
    });

    const page = await readPage(workspaceDir, "cliente-x/contratto");
    expect(page?.body).toBe("dopo");
    expect(projectScopeFromFrontmatter(page!.frontmatter)).toEqual({
      projects: ["cliente-x"],
      exclusive: true,
    });
  });

  test("writePage lets an explicit clear through", async () => {
    await writePage(workspaceDir, {
      slug: "cliente-x/contratto",
      frontmatter: ConceptPageFrontmatterSchema.parse({
        projects: ["cliente-x"],
        exclusive: true,
      }),
      body: "prima",
    });
    await writePage(workspaceDir, {
      slug: "cliente-x/contratto",
      frontmatter: ConceptPageFrontmatterSchema.parse({
        projects: [],
        exclusive: false,
      }),
      body: "dopo",
    });

    const page = await readPage(workspaceDir, "cliente-x/contratto");
    expect(projectScopeFromFrontmatter(page!.frontmatter)).toEqual(
      GLOBAL_PROJECT_SCOPE,
    );
  });
});

// ---------------------------------------------------------------------------
// Direct access (case 7)
// ---------------------------------------------------------------------------

describe("direct access", () => {
  test("case 7: readPage returns an exclusive page regardless of projects", async () => {
    await writePage(workspaceDir, {
      slug: "cliente-x/segreto",
      frontmatter: ConceptPageFrontmatterSchema.parse({
        projects: ["cliente-x"],
        exclusive: true,
      }),
      body: "materiale riservato",
    });

    const page = await readPage(workspaceDir, "cliente-x/segreto");
    expect(page?.body).toBe("materiale riservato");
  });
});

// ---------------------------------------------------------------------------
// Recall (case 6)
// ---------------------------------------------------------------------------

describe("recall", () => {
  test("case 6: the lexical arm excludes an exclusive page outside the visible projects", async () => {
    await writePage(workspaceDir, {
      slug: "cliente-x/segreto",
      frontmatter: ConceptPageFrontmatterSchema.parse({
        projects: ["cliente-x"],
        exclusive: true,
      }),
      body: "contratto riservato del cliente",
    });
    await writePage(workspaceDir, {
      slug: "globale",
      frontmatter: ConceptPageFrontmatterSchema.parse({}),
      body: "contratto pubblico",
    });

    const context = {
      workingDir: workspaceDir,
      conversationId: "conv-1",
      config: { memory: {} } as AssistantConfig,
    };

    // Outside the project: only the global page.
    projectState.visible = [];
    const outside = await searchMemoryV2Source("contratto", context, 10);
    expect(outside.evidence.map((item) => item.locator.split(":")[0])).toEqual([
      "memory/concepts/globale.md",
    ]);

    // Inside the project: both pages.
    projectState.own = ["cliente-x"];
    projectState.visible = ["cliente-x"];
    const inside = await searchMemoryV2Source("contratto", context, 10);
    expect(
      new Set(inside.evidence.map((item) => item.locator.split(":")[0])),
    ).toEqual(
      new Set([
        "memory/concepts/globale.md",
        "memory/concepts/cliente-x/segreto.md",
      ]),
    );
  });

  test("a scope-resolution failure degrades to global memory only", async () => {
    await writePage(workspaceDir, {
      slug: "cliente-x/segreto",
      frontmatter: ConceptPageFrontmatterSchema.parse({
        projects: ["cliente-x"],
        exclusive: true,
      }),
      body: "contratto riservato",
    });

    projectState.fail = true;
    const context = {
      workingDir: workspaceDir,
      conversationId: "conv-1",
      config: { memory: {} } as AssistantConfig,
    };
    const result = await searchMemoryV2Source("contratto", context, 10);
    expect(result.evidence).toEqual([]);
  });
});
