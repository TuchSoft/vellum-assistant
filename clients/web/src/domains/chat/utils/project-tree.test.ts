import { describe, expect, test } from "bun:test";

import type { ProjectNode } from "@/domains/chat/components/projects/projects-api";
import {
  canArchiveProject,
  projectAncestorIds,
  setIncludesProject,
  toggleProjectMembership,
  visibleProjectRows,
} from "@/domains/chat/utils/project-tree";

function project(
  overrides: Partial<ProjectNode> & Pick<ProjectNode, "id" | "name">,
): ProjectNode {
  return {
    description: null,
    parentId: null,
    kind: "user",
    sortPosition: 0,
    isArchived: false,
    createdAt: 0,
    updatedAt: 0,
    archivedAt: null,
    children: [],
    ...overrides,
  };
}

const inbox = project({ id: "inbox", name: "Inbox", kind: "inbox" });
const child = project({ id: "child", name: "Child", parentId: "client" });
const client = project({ id: "client", name: "Client", children: [child] });
const tree = [inbox, client];

describe("visibleProjectRows", () => {
  test("draws roots and hides the subtree of a collapsed node", () => {
    const rows = visibleProjectRows(tree, () => false);
    expect(rows.map((row) => row.project.id)).toEqual(["inbox", "client"]);
    expect(rows.map((row) => row.depth)).toEqual([0, 0]);
    expect(rows.map((row) => row.hasChildren)).toEqual([false, true]);
  });

  test("descends into an expanded node and indents its children", () => {
    const rows = visibleProjectRows(tree, (id) => id === "client");
    expect(rows.map((row) => row.project.id)).toEqual([
      "inbox",
      "client",
      "child",
    ]);
    expect(rows.map((row) => row.depth)).toEqual([0, 0, 1]);
  });
});

describe("projectAncestorIds", () => {
  test("returns the chain from the nearest parent up", () => {
    expect(projectAncestorIds(tree, "child")).toEqual(["client"]);
    expect(projectAncestorIds(tree, "client")).toEqual([]);
  });
});

describe("canArchiveProject", () => {
  test("only user projects that are still active can be archived", () => {
    expect(canArchiveProject(project({ id: "a", name: "A" }))).toBe(true);
    expect(canArchiveProject(inbox)).toBe(false);
    expect(
      canArchiveProject(project({ id: "b", name: "B", kind: "system" })),
    ).toBe(false);
    expect(
      canArchiveProject(project({ id: "c", name: "C", isArchived: true })),
    ).toBe(false);
  });
});

describe("toggleProjectMembership", () => {
  test("adds a project without dropping the others", () => {
    expect(toggleProjectMembership(["alpha"], "beta")).toEqual([
      "alpha",
      "beta",
    ]);
  });

  test("removes one project and keeps the rest of the set", () => {
    expect(toggleProjectMembership(["alpha", "beta"], "alpha")).toEqual([
      "beta",
    ]);
  });

  test("toggling twice restores the same set", () => {
    const once = toggleProjectMembership(["alpha", "beta"], "beta");
    expect(toggleProjectMembership(once, "beta")).toEqual(["alpha", "beta"]);
  });
});

describe("setIncludesProject", () => {
  test("reports membership from the set alone", () => {
    expect(setIncludesProject(["alpha", "beta"], "beta")).toBe(true);
    expect(setIncludesProject(["alpha"], "beta")).toBe(false);
  });
});
