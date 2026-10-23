/**
 * The connected projects list: create, rename, archive, and the archived
 * toggle. The daemon client is mocked at the API boundary so the test drives
 * the real hooks, the real dialogs, and the real refetch-on-success.
 */

import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { createElement, type ReactNode } from "react";

import type { ProjectNode } from "@/domains/chat/components/projects/projects-api";

const inbox: ProjectNode = {
  id: "inbox",
  name: "Inbox",
  description: null,
  parentId: null,
  kind: "inbox",
  sortPosition: -1,
  isArchived: false,
  createdAt: 0,
  updatedAt: 0,
  archivedAt: null,
  children: [],
};

const clientProject: ProjectNode = {
  id: "client",
  name: "Client",
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

const api = {
  fetchProjects: mock(async (_assistantId: string) => [inbox, clientProject]),
  createProject: mock(async () => ({ ...clientProject, id: "created" })),
  renameProject: mock(async () => clientProject),
  archiveProject: mock(async () => clientProject),
  fetchConversationProjects: mock(async () => []),
  replaceConversationProjects: mock(async () => []),
};

mock.module("@/domains/chat/components/projects/projects-api", () => api);
mock.module("@/hooks/conversation-queries", () => ({
  useCanQueryDaemon: () => true,
}));

const { ProjectsNav } = await import(
  "@/domains/chat/components/projects/projects-nav"
);

beforeEach(() => {
  for (const value of Object.values(api)) {
    value.mockClear();
  }
  api.fetchProjects.mockImplementation(async () => [inbox, clientProject]);
});

afterEach(() => {
  cleanup();
});

function renderNav() {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  function Wrapper({ children }: { children: ReactNode }) {
    return createElement(QueryClientProvider, { client }, children);
  }
  render(
    <Wrapper>
      <ProjectsNav assistantId="assistant-1" conversations={[]} />
    </Wrapper>,
  );
}

async function openNodeMenu(name: string) {
  fireEvent.pointerDown(
    screen.getByRole("button", { name: `Actions for ${name}` }),
    { button: 0, ctrlKey: false },
  );
  return await screen.findByRole("menu");
}

describe("create", () => {
  test("creates a root project and refetches the tree", async () => {
    renderNav();
    await screen.findByText("Client");

    fireEvent.click(screen.getByRole("button", { name: "New project" }));
    const input = screen.getByRole("textbox");
    fireEvent.change(input, { target: { value: "Delta" } });
    fireEvent.click(screen.getByRole("button", { name: "Create" }));

    await waitFor(() => {
      expect(api.createProject).toHaveBeenCalledWith("assistant-1", {
        name: "Delta",
        parentId: null,
      });
    });
    await waitFor(() => {
      expect(api.fetchProjects.mock.calls.length).toBeGreaterThan(1);
    });
  });

  test("creates a subproject from the node menu", async () => {
    renderNav();
    await screen.findByText("Client");

    await openNodeMenu("Client");
    fireEvent.click(screen.getByRole("menuitem", { name: "New subproject" }));
    fireEvent.change(screen.getByRole("textbox"), {
      target: { value: "Delta" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Create" }));

    await waitFor(() => {
      expect(api.createProject).toHaveBeenCalledWith("assistant-1", {
        name: "Delta",
        parentId: "client",
      });
    });
  });
});

describe("rename", () => {
  test("opens the current name, saves the new one, and refetches", async () => {
    renderNav();
    await screen.findByText("Client");

    await openNodeMenu("Client");
    fireEvent.click(screen.getByRole("menuitem", { name: "Rename" }));

    const input = screen.getByRole("textbox") as HTMLInputElement;
    expect(input.value).toBe("Client");
    fireEvent.change(input, { target: { value: "Client X" } });
    fireEvent.click(screen.getByRole("button", { name: "Save" }));

    await waitFor(() => {
      expect(api.renameProject).toHaveBeenCalledWith(
        "assistant-1",
        "client",
        "Client X",
      );
    });
    await waitFor(() => {
      expect(api.fetchProjects.mock.calls.length).toBeGreaterThan(1);
    });
  });
});

describe("archive", () => {
  test("asks for confirmation before archiving a user project", async () => {
    renderNav();
    await screen.findByText("Client");

    await openNodeMenu("Client");
    fireEvent.click(screen.getByRole("menuitem", { name: "Archive" }));
    expect(api.archiveProject).not.toHaveBeenCalled();

    const confirm = screen
      .getAllByRole("button", { name: "Archive" })
      .find((button) => button.getAttribute("data-confirm-dialog-confirm") !== null);
    if (!confirm) {
      throw new Error("expected the confirmation dialog's archive button");
    }
    fireEvent.click(confirm);

    await waitFor(() => {
      expect(api.archiveProject).toHaveBeenCalledWith("assistant-1", "client");
    });
    await waitFor(() => {
      expect(api.fetchProjects.mock.calls.length).toBeGreaterThan(1);
    });
  });

  test("never offers to archive the Inbox", async () => {
    renderNav();
    await screen.findByText("Inbox");

    await openNodeMenu("Inbox");
    expect(screen.queryByRole("menuitem", { name: "Archive" })).toBeNull();
  });
});

describe("archived visibility", () => {
  test("asks the route for archived projects only after the toggle", async () => {
    renderNav();
    await screen.findByText("Inbox");
    expect(api.fetchProjects).toHaveBeenCalledWith("assistant-1", {
      includeArchived: false,
    });

    fireEvent.click(screen.getByRole("button", { name: "Show archived" }));
    await waitFor(() => {
      expect(api.fetchProjects).toHaveBeenCalledWith("assistant-1", {
        includeArchived: true,
      });
    });
  });
});
