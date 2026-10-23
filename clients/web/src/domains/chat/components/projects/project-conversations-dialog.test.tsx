/**
 * The membership picker. The core case is a conversation that belongs to two
 * projects: toggling this project off must keep the other one, because the
 * write replaces the whole set.
 */

import { afterEach, describe, expect, mock, test } from "bun:test";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";

import type { ProjectNode } from "@/domains/chat/components/projects/projects-api";
import {
  ProjectConversationsDialog,
  type ProjectConversationRow,
} from "@/domains/chat/components/projects/project-conversations-dialog";

afterEach(() => {
  cleanup();
});

const alpha: ProjectNode = {
  id: "alpha",
  name: "Alpha",
  description: null,
  parentId: null,
  kind: "user",
  sortPosition: 0,
  isArchived: false,
  createdAt: 0,
  updatedAt: 0,
  archivedAt: null,
  children: [],
};

function renderDialog(
  rows: ProjectConversationRow[],
  overrides: Partial<React.ComponentProps<typeof ProjectConversationsDialog>> = {},
) {
  const handlers = {
    onSearchChange: mock(() => {}),
    onShowMore: mock(() => {}),
    onToggle: mock(() => {}),
    onClose: mock(() => {}),
  };
  render(
    <ProjectConversationsDialog
      open
      project={alpha}
      rows={rows}
      search=""
      hasMore={false}
      error={null}
      isPending={false}
      {...handlers}
      {...overrides}
    />,
  );
  return handlers;
}

function checkboxFor(title: string): HTMLElement {
  return screen.getByRole("checkbox", { name: title });
}

describe("membership", () => {
  test("a conversation in two projects reads as checked and removing this one keeps the other", () => {
    const handlers = renderDialog([
      { conversationId: "conv-1", title: "Shared", projectIds: ["alpha", "beta"] },
    ]);

    const checkbox = checkboxFor("Shared");
    expect(checkbox.getAttribute("aria-checked")).toBe("true");

    fireEvent.click(checkbox);
    expect(handlers.onToggle).toHaveBeenCalledWith("conv-1", ["beta"]);
  });

  test("a conversation outside the project is unchecked and adding it keeps its other projects", () => {
    const handlers = renderDialog([
      { conversationId: "conv-2", title: "Elsewhere", projectIds: ["beta"] },
    ]);

    const checkbox = checkboxFor("Elsewhere");
    expect(checkbox.getAttribute("aria-checked")).toBe("false");

    fireEvent.click(checkbox);
    expect(handlers.onToggle).toHaveBeenCalledWith("conv-2", [
      "alpha",
      "beta",
    ]);
  });

  test("a row whose set is still loading is indeterminate and inert", () => {
    const handlers = renderDialog([
      { conversationId: "conv-3", title: "Pending", projectIds: undefined },
    ]);

    const checkbox = checkboxFor("Pending");
    expect(checkbox.getAttribute("aria-checked")).toBe("mixed");
    fireEvent.click(checkbox);
    expect(handlers.onToggle).not.toHaveBeenCalled();
  });
});

describe("dialog chrome", () => {
  test("names the project and explains multi-project membership", () => {
    renderDialog([]);
    expect(screen.getByText("Conversations in Alpha")).toBeTruthy();
    expect(
      screen.getByText("A conversation can belong to more than one project."),
    ).toBeTruthy();
    expect(screen.getByText("No conversations match.")).toBeTruthy();
  });

  test("reports the search text upward", () => {
    const handlers = renderDialog([]);
    fireEvent.change(screen.getByRole("textbox"), {
      target: { value: "contract" },
    });
    expect(handlers.onSearchChange).toHaveBeenCalledWith("contract");
  });

  test("offers more rows only while there are more", () => {
    const handlers = renderDialog(
      [{ conversationId: "conv-1", title: "One", projectIds: [] }],
      { hasMore: true },
    );
    fireEvent.click(screen.getByRole("button", { name: "Show more" }));
    expect(handlers.onShowMore).toHaveBeenCalledTimes(1);
  });

  test("hides the show-more control on the last page", () => {
    renderDialog([]);
    expect(screen.queryByRole("button", { name: "Show more" })).toBeNull();
  });

  test("shows the write error inside the dialog", () => {
    renderDialog([], { error: "Could not update the conversation projects." });
    expect(
      screen.getByRole("alert").textContent,
    ).toContain("Could not update the conversation projects.");
  });
});
