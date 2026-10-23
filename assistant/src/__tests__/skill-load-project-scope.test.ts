/**
 * Tests the project gate on `skill_load`: a skill that declares `projects` is
 * loadable only from a conversation whose inherited project set intersects it,
 * and loading it elsewhere is a hard error naming the skill and its projects.
 * A skill without `projects` stays available everywhere, including Inbox.
 *
 * `loadSkillCatalog` / `loadSkillBySelector` are mocked against real temp
 * directories (so the successful path completes its filesystem reads) and
 * `resolveInheritedProjectIds` supplies the per-conversation project set.
 */
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { beforeEach, describe, expect, mock, test } from "bun:test";

import type { SkillDefinition, SkillSummary } from "../config/skills.js";

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

const skillDir = mkdtempSync(join(tmpdir(), "skill-project-scope-"));
writeFileSync(
  join(skillDir, "SKILL.md"),
  `---\nname: "fixture"\ndescription: "Project scope fixture"\n---\n\nDo the fixture thing.\n`,
);

function makeSkill(
  id: string,
  projects: string[] | undefined,
): SkillDefinition {
  return {
    id,
    name: id,
    displayName: id,
    description: `${id} description`,
    directoryPath: skillDir,
    skillFilePath: join(skillDir, "SKILL.md"),
    source: "bundled",
    body: `Body for ${id}.`,
    includes: [],
    ...(projects ? { projects } : {}),
  };
}

const globalSkill = makeSkill("global-skill", undefined);
const clienteXSkill = makeSkill("cliente-x-skill", ["cliente-x"]);
const altroSkill = makeSkill("altro-skill", ["altro"]);
const inboxSkill = makeSkill("inbox-skill", ["system:inbox"]);

const skillsById: Record<string, SkillDefinition> = {
  "global-skill": globalSkill,
  "cliente-x-skill": clienteXSkill,
  "altro-skill": altroSkill,
  "inbox-skill": inboxSkill,
};

const catalogSummaries: SkillSummary[] = Object.values(skillsById).map(
  ({ body: _body, ...summary }) => summary,
);

let conversationProjectIds: string[] = [];

// eslint-disable-next-line @typescript-eslint/no-require-imports
const realSkills = require("../config/skills.js");
mock.module("../config/skills.js", () => ({
  ...realSkills,
  loadSkillCatalog: () => catalogSummaries,
  loadSkillBySelector: (
    selector: string,
    _workspaceSkillsDir?: string,
    catalog?: readonly SkillSummary[],
  ) => {
    const scoped = catalog ?? catalogSummaries;
    const summary = scoped.find((entry) => entry.id === selector);
    if (!summary) {
      return {
        skill: undefined,
        error: `not found: ${selector}`,
        errorCode: "not_found",
      };
    }
    return { skill: skillsById[summary.id] };
  },
}));

mock.module("../persistence/project-store.js", () => ({
  resolveInheritedProjectIds: async () => conversationProjectIds,
}));

const { skillLoadTool } = await import("../tools/skills/load.js");
const { _resetSkillProjectScopeCacheForTest } =
  await import("../skills/project-scope.js");

async function load(
  selector: string,
): Promise<{ content: string; isError: boolean }> {
  const result = await skillLoadTool.execute(
    { skill: selector },
    {
      workingDir: "/tmp",
      conversationId: "conversation-1",
      trustClass: "guardian",
    },
  );
  return { content: result.content, isError: result.isError };
}

beforeEach(() => {
  conversationProjectIds = [];
  _resetSkillProjectScopeCacheForTest();
});

describe("skill_load — project scope", () => {
  test("a skill without projects loads with no project set", async () => {
    conversationProjectIds = [];
    const result = await load("global-skill");
    expect(result.isError).toBe(false);
    expect(result.content).toContain("Body for global-skill.");
  });

  test("a scoped skill loads inside its project", async () => {
    conversationProjectIds = ["cliente-x"];
    const result = await load("cliente-x-skill");
    expect(result.isError).toBe(false);
    expect(result.content).toContain("Body for cliente-x-skill.");
  });

  test("a scoped skill outside its project is a hard error", async () => {
    conversationProjectIds = ["altro"];
    const result = await load("cliente-x-skill");
    expect(result.isError).toBe(true);
    expect(result.content).toBe(
      'Error: skill "cliente-x-skill" is restricted to project(s) "cliente-x"; this conversation is in project set "altro".',
    );
  });

  test("a multi-project conversation matches any of the skill's projects", async () => {
    conversationProjectIds = ["cliente-x", "altro"];
    expect((await load("cliente-x-skill")).isError).toBe(false);
    expect((await load("altro-skill")).isError).toBe(false);
  });

  test("Inbox conversations get Inbox skills only", async () => {
    conversationProjectIds = ["system:inbox"];
    const inbox = await load("inbox-skill");
    expect(inbox.isError).toBe(false);
    expect(inbox.content).toContain("Body for inbox-skill.");

    const other = await load("cliente-x-skill");
    expect(other.isError).toBe(true);
    expect(other.content).toContain("cliente-x-skill");
    expect(other.content).toContain('"cliente-x"');
  });

  test("an unknown skill keeps the plain not-found error", async () => {
    conversationProjectIds = ["cliente-x"];
    const result = await load("does-not-exist");
    expect(result.isError).toBe(true);
    expect(result.content).toContain("not found: does-not-exist");
  });
});
