/**
 * Project scoping of the skill catalog: the `projects` frontmatter field is
 * parsed, a malformed value drops the skill (fail closed) instead of crashing,
 * and the filtered catalog keeps only skills whose project list intersects the
 * conversation's inherited project set.
 */
import { existsSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";

const TEST_DIR = process.env.VELLUM_WORKSPACE_DIR!;

const noopLogger = new Proxy({} as Record<string, unknown>, {
  get: (_t, prop) => (prop === "child" ? () => noopLogger : () => {}),
});

mock.module("../util/logger.js", () => ({
  getLogger: () => noopLogger,
  getCliLogger: () => noopLogger,
  truncateForLog: (s: unknown) => String(s),
  initLogger: () => {},
  pruneOldLogFiles: () => 0,
}));

const { loadSkillCatalog } = await import("../config/skills.js");
const {
  _resetSkillProjectScopeCacheForTest,
  filterSkillCatalogByProjectScope,
  isSkillInProjectScope,
  loadProjectScopedSkillCatalog,
  skillProjectScopeErrorMessage,
} = await import("../skills/project-scope.js");

const SKILLS_DIR = join(TEST_DIR, "skills");

function writeSkill(
  skillId: string,
  frontmatterExtras: string = "",
  name: string = skillId,
): void {
  const skillDir = join(SKILLS_DIR, skillId);
  mkdirSync(skillDir, { recursive: true });
  writeFileSync(
    join(skillDir, "SKILL.md"),
    `---\nname: "${name}"\ndescription: "${name} description"\n${frontmatterExtras}---\n\nBody for ${name}.\n`,
  );
}

function resetSkillsDir(): void {
  if (existsSync(SKILLS_DIR)) {
    rmSync(SKILLS_DIR, { recursive: true, force: true });
  }
  mkdirSync(SKILLS_DIR, { recursive: true });
}

function userCatalog() {
  return loadSkillCatalog().filter((skill) => !skill.bundled);
}

describe("skill project frontmatter", () => {
  beforeEach(() => {
    resetSkillsDir();
    _resetSkillProjectScopeCacheForTest();
  });

  afterEach(() => {
    resetSkillsDir();
    _resetSkillProjectScopeCacheForTest();
  });

  test("parses projects into a deduplicated list", () => {
    writeSkill("scoped", 'projects: ["cliente-x", "cliente-x", "altro"]\n');

    const skill = userCatalog().find((entry) => entry.id === "scoped");
    expect(skill?.projects).toEqual(["cliente-x", "altro"]);
  });

  test("omitting projects or declaring an empty list means global", () => {
    writeSkill("no-projects");
    writeSkill("empty-projects", "projects: []\n");

    const catalog = userCatalog();
    expect(catalog.find((entry) => entry.id === "no-projects")?.projects).toBe(
      undefined,
    );
    expect(
      catalog.find((entry) => entry.id === "empty-projects")?.projects,
    ).toBe(undefined);
  });

  test("a malformed projects value drops the skill instead of throwing", () => {
    writeSkill("good", 'projects: ["cliente-x"]\n');
    writeSkill("bad-string", 'projects: "cliente-x"\n');
    writeSkill("bad-object", "projects:\n  name: cliente-x\n");
    writeSkill("bad-entry", 'projects: ["cliente-x", 42]\n');

    const ids = userCatalog().map((entry) => entry.id);
    expect(ids).toEqual(["good"]);
  });
});

describe("skill project scope filter", () => {
  const global = { id: "global", projects: undefined };
  const clienteX = { id: "cliente-x-skill", projects: ["cliente-x"] };
  const multi = { id: "multi-skill", projects: ["cliente-x", "altro"] };

  test("a skill without projects is available in every project set", () => {
    expect(isSkillInProjectScope(global, [])).toBe(true);
    expect(isSkillInProjectScope(global, ["unknown"])).toBe(true);
    expect(isSkillInProjectScope(global, ["system:inbox"])).toBe(true);
  });

  test("a scoped skill is available only inside its projects", () => {
    expect(isSkillInProjectScope(clienteX, ["cliente-x"])).toBe(true);
    expect(isSkillInProjectScope(clienteX, ["altro"])).toBe(false);
    expect(isSkillInProjectScope(clienteX, [])).toBe(false);
    expect(isSkillInProjectScope(clienteX, ["system:inbox"])).toBe(false);
  });

  test("a multi-project conversation matches any of a skill's projects", () => {
    expect(isSkillInProjectScope(clienteX, ["altro", "cliente-x"])).toBe(true);
    expect(isSkillInProjectScope(multi, ["altro"])).toBe(true);
    expect(isSkillInProjectScope(multi, ["terzo"])).toBe(false);
  });

  test("filter keeps global and in-scope skills, drops the rest", () => {
    const filtered = filterSkillCatalogByProjectScope(
      [global, clienteX, multi],
      ["altro"],
    );
    expect(filtered.map((skill) => skill.id)).toEqual([
      "global",
      "multi-skill",
    ]);
  });

  test("the error message names the skill and the projects it requires", () => {
    expect(skillProjectScopeErrorMessage(clienteX, ["altro"])).toBe(
      'skill "cliente-x-skill" is restricted to project(s) "cliente-x"; this conversation is in project set "altro".',
    );
    expect(skillProjectScopeErrorMessage(multi, [])).toBe(
      'skill "multi-skill" is restricted to project(s) "cliente-x", "altro"; this conversation is in project set none.',
    );
  });
});

describe("project-scoped catalog cache", () => {
  beforeEach(() => {
    resetSkillsDir();
    _resetSkillProjectScopeCacheForTest();
  });

  afterEach(() => {
    resetSkillsDir();
    _resetSkillProjectScopeCacheForTest();
  });

  test("caches per project set and refreshes after invalidation", () => {
    writeSkill("global");
    writeSkill("scoped", 'projects: ["cliente-x"]\n');

    const inside = loadProjectScopedSkillCatalog(["cliente-x"]).filter(
      (skill) => !skill.bundled,
    );
    const outside = loadProjectScopedSkillCatalog(["altro"]).filter(
      (skill) => !skill.bundled,
    );
    expect(inside.map((skill) => skill.id)).toEqual(["global", "scoped"]);
    expect(outside.map((skill) => skill.id)).toEqual(["global"]);

    // A new skill installed after a catalog-change invalidation shows up.
    writeSkill("global", "", "global renamed");
    _resetSkillProjectScopeCacheForTest();
    const refreshed = loadProjectScopedSkillCatalog(["altro"]).filter(
      (skill) => !skill.bundled,
    );
    expect(refreshed.map((skill) => skill.displayName)).toEqual([
      "global renamed",
    ]);
  });
});
