import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";

import type { ProjectRow } from "../../persistence/project-store.js";

// The store is mocked so the tests drive the inherited project set and the
// project rows directly, without a database.
let projectIds: string[] = [];
let projectRows: Map<string, ProjectRow> = new Map();

mock.module("../../persistence/project-store.js", () => ({
  INBOX_PROJECT_ID: "inbox",
  resolveInheritedProjectIds: async () => projectIds,
  getProject: async (id: string) => projectRows.get(id) ?? null,
}));

const { renderProjectBriefingBlock, resolveProjectBriefingBlock } =
  await import("../project-briefing.js");
const { renderWorkspaceSections } = await import("../sections.js");

function makeProject(
  id: string,
  name: string,
  kind: ProjectRow["kind"] = "user",
): ProjectRow {
  return {
    id,
    name,
    description: null,
    parentId: null,
    kind,
    sortPosition: 0,
    isArchived: false,
    createdAt: 0,
    updatedAt: 0,
    archivedAt: null,
  };
}

let workspaceDir: string;
let originalWorkspaceDir: string | undefined;

function writeRefs(projectId: string, content: string): void {
  const dir = join(workspaceDir, "data", "projects", projectId);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "refs.yaml"), content);
}

beforeEach(() => {
  workspaceDir = mkdtempSync(join(tmpdir(), "project-briefing-"));
  originalWorkspaceDir = process.env.VELLUM_WORKSPACE_DIR;
  process.env.VELLUM_WORKSPACE_DIR = workspaceDir;
  projectIds = [];
  projectRows = new Map();
});

afterEach(() => {
  if (originalWorkspaceDir === undefined) {
    delete process.env.VELLUM_WORKSPACE_DIR;
  } else {
    process.env.VELLUM_WORKSPACE_DIR = originalWorkspaceDir;
  }
  rmSync(workspaceDir, { recursive: true, force: true });
});

describe("resolveProjectBriefingBlock", () => {
  test("no projects produces no block", async () => {
    expect(await resolveProjectBriefingBlock("conv-1")).toBeNull();
  });

  test("a conversation without an id produces no block", async () => {
    expect(await resolveProjectBriefingBlock(undefined)).toBeNull();
  });

  test("one project renders its name and refs", async () => {
    projectIds = ["p1"];
    projectRows.set("p1", makeProject("p1", "Cliente X"));
    writeRefs(
      "p1",
      `refs:
  - name: docs
    where: /workspace/hostmount/Progetti/cliente-x/docs
    what: documentazione e contratti del cliente
    access: rw
`,
    );

    expect(await resolveProjectBriefingBlock("conv-1")).toBe(
      [
        "<projects>",
        "## Cliente X",
        "- docs | /workspace/hostmount/Progetti/cliente-x/docs | documentazione e contratti del cliente | rw",
        "</projects>",
      ].join("\n"),
    );
  });

  test("two projects render in a deterministic name order", async () => {
    projectIds = ["p2", "p1"];
    projectRows.set("p1", makeProject("p1", "Zeta"));
    projectRows.set("p2", makeProject("p2", "Alfa"));
    writeRefs(
      "p1",
      `refs:
  - name: docs
    where: /z
    what: zeta docs
`,
    );
    writeRefs(
      "p2",
      `refs:
  - name: openproject
    where: https://openproject.example.com/projects/1
    what: task e milestone
    access: ro
`,
    );

    expect(await resolveProjectBriefingBlock("conv-1")).toBe(
      [
        "<projects>",
        "## Alfa",
        "- openproject | https://openproject.example.com/projects/1 | task e milestone | ro",
        "## Zeta",
        "- docs | /z | zeta docs",
        "</projects>",
      ].join("\n"),
    );
  });

  test("a user project without a refs.yaml renders its name alone", async () => {
    projectIds = ["p1"];
    projectRows.set("p1", makeProject("p1", "Cliente X"));

    expect(await resolveProjectBriefingBlock("conv-1")).toBe(
      ["<projects>", "## Cliente X", "</projects>"].join("\n"),
    );
  });

  test("a system project without a refs.yaml is omitted", async () => {
    projectIds = ["sys", "p1"];
    projectRows.set("sys", makeProject("sys", "Background", "system"));
    projectRows.set("p1", makeProject("p1", "Cliente X"));

    expect(await resolveProjectBriefingBlock("conv-1")).toBe(
      ["<projects>", "## Cliente X", "</projects>"].join("\n"),
    );
  });

  test("the inbox never contributes a block", async () => {
    projectIds = ["inbox"];
    projectRows.set("inbox", makeProject("inbox", "Inbox", "inbox"));

    expect(await resolveProjectBriefingBlock("conv-1")).toBeNull();
  });

  test("malformed YAML degrades to the project name without throwing", async () => {
    projectIds = ["p1"];
    projectRows.set("p1", makeProject("p1", "Cliente X"));
    writeRefs("p1", "refs: [unclosed\n  - name: docs");

    expect(await resolveProjectBriefingBlock("conv-1")).toBe(
      ["<projects>", "## Cliente X", "</projects>"].join("\n"),
    );
  });

  test("refs with missing mandatory fields are skipped", async () => {
    projectIds = ["p1"];
    projectRows.set("p1", makeProject("p1", "Cliente X"));
    writeRefs(
      "p1",
      `refs:
  - name: docs
    where: /docs
    what: valid entry
  - name: incomplete
    where: /nowhere
  - just-a-string
`,
    );

    expect(await resolveProjectBriefingBlock("conv-1")).toBe(
      [
        "<projects>",
        "## Cliente X",
        "- docs | /docs | valid entry",
        "</projects>",
      ].join("\n"),
    );
  });

  test("identical inputs render identical bytes", async () => {
    projectIds = ["p1"];
    projectRows.set("p1", makeProject("p1", "Cliente X"));
    writeRefs(
      "p1",
      `refs:
  - name: docs
    where: /docs
    what: documentation
`,
    );

    const first = await resolveProjectBriefingBlock("conv-1");
    const second = await resolveProjectBriefingBlock("conv-1");
    expect(first).not.toBeNull();
    expect(second).toBe(first);
  });

  test("a changed refs.yaml changes the next block", async () => {
    projectIds = ["p1"];
    projectRows.set("p1", makeProject("p1", "Cliente X"));
    writeRefs(
      "p1",
      `refs:
  - name: docs
    where: /docs
    what: documentation
`,
    );
    const before = await resolveProjectBriefingBlock("conv-1");

    writeRefs(
      "p1",
      `refs:
  - name: docs
    where: /docs-v2
    what: documentation, second edition
    access: rw
`,
    );
    const after = await resolveProjectBriefingBlock("conv-1");

    expect(before).not.toBe(after);
    expect(after).toContain(
      "- docs | /docs-v2 | documentation, second edition | rw",
    );
  });
});

describe("10b-project-briefing section", () => {
  test("lands in the cached block, before the cache breakpoint", async () => {
    projectIds = ["p1"];
    projectRows.set("p1", makeProject("p1", "Cliente X"));
    writeRefs(
      "p1",
      `refs:
  - name: docs
    where: /docs
    what: documentation
`,
    );

    const blocks = await renderWorkspaceSections({ conversationId: "conv-1" });
    expect(blocks[0]!.join("\n\n")).toContain("<projects>\n## Cliente X");
    expect((blocks[1] ?? []).join("\n\n")).not.toContain("<projects>");
  });

  test("two builds over identical inputs produce identical bytes", async () => {
    projectIds = ["p1"];
    projectRows.set("p1", makeProject("p1", "Cliente X"));
    writeRefs(
      "p1",
      `refs:
  - name: docs
    where: /docs
    what: documentation
`,
    );

    const first = await renderWorkspaceSections({ conversationId: "conv-1" });
    const second = await renderWorkspaceSections({ conversationId: "conv-1" });
    expect(second).toEqual(first);
  });

  test("is omitted when the conversation has no project", async () => {
    const blocks = await renderWorkspaceSections({ conversationId: "conv-1" });
    expect(blocks.flat().join("\n\n")).not.toContain("<projects>");
  });
});

describe("renderProjectBriefingBlock", () => {
  test("returns null for an empty entry list", () => {
    expect(renderProjectBriefingBlock([])).toBeNull();
  });

  test("collapses whitespace and neutralizes the field separator", () => {
    const block = renderProjectBriefingBlock([
      {
        project: makeProject("p1", "Cliente   X"),
        refs: [
          {
            name: "docs",
            where: "/a | b",
            what: "multi\nline   scope",
            access: null,
          },
        ],
      },
    ]);

    expect(block).toBe(
      [
        "<projects>",
        "## Cliente X",
        "- docs | /a / b | multi line scope",
        "</projects>",
      ].join("\n"),
    );
  });
});
