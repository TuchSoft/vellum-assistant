/**
 * The projects tree: nesting, expansion, and the per-node action set.
 *
 * The Inbox invariant lives here: the server answers 403 for archiving it, so
 * the tree must not offer the action at all. Everything else is a callback the
 * connected wrapper owns, which is why these tests assert the calls rather than
 * the writes.
 */

import { afterEach, describe, expect, mock, test } from "bun:test";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";

import type { ProjectNode } from "@/domains/chat/components/projects/projects-api";
import { ProjectsTree } from "@/domains/chat/components/projects/projects-tree";

afterEach(() => {
  cleanup();
});

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

function renderTree(
  overrides: Partial<React.ComponentProps<typeof ProjectsTree>> = {},
) {
  const handlers = {
    onToggleExpanded: mock(() => {}),
    onToggleShowArchived: mock(() => {}),
    onRetry: mock(() => {}),
    onNewProject: mock(() => {}),
    onRename: mock(() => {}),
    onArchive: mock(() => {}),
    onManageConversations: mock(() => {}),
  };
  render(
    <ProjectsTree
      projects={[inbox, client]}
      isLoading={false}
      isError={false}
      showArchived={false}
      expandedIds={new Set<string>()}
      {...handlers}
      {...overrides}
    />,
  );
  return handlers;
}

async function openMenu(name: string) {
  fireEvent.pointerDown(
    screen.getByRole("button", { name: `Actions for ${name}` }),
    { button: 0, ctrlKey: false },
  );
  return await screen.findByRole("menu");
}

describe("tree", () => {
  test("draws the Inbox and the user roots, and hides a collapsed subtree", () => {
    renderTree();
    expect(screen.getByText("Inbox")).toBeTruthy();
    expect(screen.getByText("Client")).toBeTruthy();
    expect(screen.queryByText("Child")).toBeNull();
  });

  test("a collapsed parent offers an expand control that reports the node", () => {
    const handlers = renderTree();
    fireEvent.click(
      screen.getByRole("button", { name: "Expand Client" }),
    );
    expect(handlers.onToggleExpanded).toHaveBeenCalledWith("client");
  });

  test("an expanded parent draws its children and offers collapse", () => {
    renderTree({ expandedIds: new Set(["client"]) });
    expect(screen.getByText("Child")).toBeTruthy();
    expect(
      screen.getByRole("button", { name: "Collapse Client" }),
    ).toBeTruthy();
  });

  test("expanding a leaf is not offered", () => {
    renderTree();
    expect(screen.queryByRole("button", { name: "Expand Inbox" })).toBeNull();
    expect(screen.queryByRole("button", { name: "Expand Child" })).toBeNull();
  });

  test("the header plus creates a root project", () => {
    const handlers = renderTree();
    fireEvent.click(screen.getByRole("button", { name: "New project" }));
    expect(handlers.onNewProject).toHaveBeenCalledWith(null);
  });

  test("the footer reveals archived projects", () => {
    const handlers = renderTree();
    fireEvent.click(
      screen.getByRole("button", { name: "Show archived" }),
    );
    expect(handlers.onToggleShowArchived).toHaveBeenCalledTimes(1);
  });
});

describe("node actions", () => {
  test("the Inbox offers rename and conversations but never archive or a subproject", async () => {
    renderTree();
    await openMenu("Inbox");
    expect(screen.getByRole("menuitem", { name: "Rename" })).toBeTruthy();
    expect(
      screen.getByRole("menuitem", { name: "Conversations" }),
    ).toBeTruthy();
    expect(screen.queryByRole("menuitem", { name: "Archive" })).toBeNull();
    expect(
      screen.queryByRole("menuitem", { name: "New subproject" }),
    ).toBeNull();
  });

  test("a user project offers a subproject, rename, conversations and archive", async () => {
    renderTree();
    await openMenu("Client");
    expect(
      screen.getByRole("menuitem", { name: "New subproject" }),
    ).toBeTruthy();
    expect(screen.getByRole("menuitem", { name: "Rename" })).toBeTruthy();
    expect(
      screen.getByRole("menuitem", { name: "Conversations" }),
    ).toBeTruthy();
    expect(screen.getByRole("menuitem", { name: "Archive" })).toBeTruthy();
  });

  test("each action reports the node it belongs to", async () => {
    const handlers = renderTree();
    await openMenu("Client");

    fireEvent.click(screen.getByRole("menuitem", { name: "New subproject" }));
    expect(handlers.onNewProject).toHaveBeenCalledWith("client");

    await openMenu("Client");
    fireEvent.click(screen.getByRole("menuitem", { name: "Rename" }));
    expect(handlers.onRename).toHaveBeenCalledWith(
      expect.objectContaining({ id: "client" }),
    );

    await openMenu("Client");
    fireEvent.click(screen.getByRole("menuitem", { name: "Conversations" }));
    expect(handlers.onManageConversations).toHaveBeenCalledWith(
      expect.objectContaining({ id: "client" }),
    );

    await openMenu("Client");
    fireEvent.click(screen.getByRole("menuitem", { name: "Archive" }));
    expect(handlers.onArchive).toHaveBeenCalledWith(
      expect.objectContaining({ id: "client" }),
    );
  });
});
