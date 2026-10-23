/**
 * Tests for `projectIds` on `GET /v1/conversations` rows.
 *
 * The list reads every row's project set with one batched query for the page,
 * so these cover the shapes a client renders: no project, one project, two
 * projects, and a paginated read where a row outside the first page still
 * carries its own set.
 *
 * Gated on `VELLUM_PG_TEST_URL`; with it unset the suite skips.
 */

import { beforeEach, expect, mock, setDefaultTimeout, test } from "bun:test";

setDefaultTimeout(30_000);

import { describePg } from "../../../__tests__/pg-test-db.js";

// Avoid spinning up the real event hub for the pinned/groups branches.
mock.module("../../assistant-event-hub.js", () => ({
  assistantEventHub: {
    publish: async () => {},
    subscribe: () => () => {},
  },
  broadcastMessage: () => {},
}));

import { createConversation } from "../../../persistence/conversation-crud.js";
import { requireMainDb } from "../../../persistence/db-facade.js";
import { initializePostgresDb } from "../../../persistence/pg-migrations/pg-db-init.js";
import {
  createProject,
  INBOX_PROJECT_ID,
  setConversationProjects,
} from "../../../persistence/project-store.js";
import { ROUTES as CONVERSATION_LIST_ROUTES } from "../conversation-list-routes.js";
import type { RouteDefinition } from "../types.js";

await initializePostgresDb();

const NOW = 1_760_000_000_000;

interface ConversationSummary {
  id: string;
  title: string;
  projectIds: string[];
}

interface ListResponse {
  conversations: ConversationSummary[];
  nextOffset: number;
  hasMore: boolean;
}

function handler(operationId: string): RouteDefinition["handler"] {
  const route = CONVERSATION_LIST_ROUTES.find(
    (entry) => entry.operationId === operationId,
  );
  if (!route) {
    throw new Error(`Route ${operationId} not found`);
  }
  return route.handler;
}

const list = handler("listConversations");

async function resetProjects(): Promise<void> {
  const db = requireMainDb();
  await db.exec("DELETE FROM conversation_projects");
  await db.exec("DELETE FROM conversations");
  await db.exec("DELETE FROM projects WHERE kind <> 'inbox'");
  await db.run(
    `INSERT INTO projects (id, name, kind, sort_position, is_archived, created_at, updated_at)
     VALUES (?, 'Inbox', 'inbox', -1, FALSE, ?, ?)
     ON CONFLICT (id) DO NOTHING`,
    [INBOX_PROJECT_ID, NOW, NOW],
  );
}

async function invoke(
  queryParams: Record<string, string> = {},
): Promise<ListResponse> {
  return (await list({ queryParams })) as ListResponse;
}

/** A row by title; the list orders by activity, not by insertion. */
function row(response: ListResponse, title: string): ConversationSummary {
  const found = response.conversations.find(
    (conversation) => conversation.title === title,
  );
  if (!found) {
    throw new Error(`Conversation "${title}" not in response`);
  }
  return found;
}

describePg("GET /v1/conversations: projectIds", () => {
  beforeEach(async () => {
    await resetProjects();
  });

  test("a conversation with no project serializes an empty array", async () => {
    await createConversation("no-project");

    const result = await invoke();

    expect(row(result, "no-project").projectIds).toEqual([]);
  });

  test("a conversation in one project serializes that project", async () => {
    const project = await createProject({ name: "Alpha" });
    const conversation = await createConversation("one-project");
    await setConversationProjects(conversation.id, [project.id]);

    const result = await invoke();

    expect(row(result, "one-project").projectIds).toEqual([project.id]);
  });

  test("a conversation in two projects serializes both", async () => {
    const alpha = await createProject({ name: "Alpha" });
    const beta = await createProject({ name: "Beta" });
    const conversation = await createConversation("two-projects");
    await setConversationProjects(conversation.id, [alpha.id, beta.id]);

    const result = await invoke();

    expect(row(result, "two-projects").projectIds.sort()).toEqual(
      [alpha.id, beta.id].sort(),
    );
  });

  test("each row keeps its own set across a paginated read", async () => {
    const alpha = await createProject({ name: "Alpha" });
    const beta = await createProject({ name: "Beta" });
    await createConversation("page-1-none");
    const second = await createConversation("page-2-alpha");
    const third = await createConversation("page-3-both");
    await setConversationProjects(second.id, [alpha.id]);
    await setConversationProjects(third.id, [alpha.id, beta.id]);

    const pageOne = await invoke({ limit: "1" });
    const pageTwo = await invoke({ limit: "1", offset: "1" });
    const pageThree = await invoke({ limit: "1", offset: "2" });

    const byTitle = new Map(
      [
        ...pageOne.conversations,
        ...pageTwo.conversations,
        ...pageThree.conversations,
      ].map((conversation) => [conversation.title, conversation.projectIds]),
    );
    expect(byTitle.size).toBe(3);
    expect(byTitle.get("page-1-none")).toEqual([]);
    expect(byTitle.get("page-2-alpha")).toEqual([alpha.id]);
    expect(new Set(byTitle.get("page-3-both"))).toEqual(
      new Set([alpha.id, beta.id]),
    );
  });
});
