/**
 * Tests for the project route handlers: the tree list, create, rename,
 * archive, and the conversation project set.
 *
 * Handlers are invoked directly with the same argument shape the HTTP and IPC
 * adapters build, against the process's Postgres test schema.
 * Gated on `VELLUM_PG_TEST_URL`; with it unset the suite skips.
 */

import { beforeEach, expect, test } from "bun:test";

import { describePg } from "../../../__tests__/pg-test-db.js";
import { requireMainDb } from "../../../persistence/db-facade.js";
import { initializePostgresDb } from "../../../persistence/pg-migrations/pg-db-init.js";
import { INBOX_PROJECT_ID } from "../../../persistence/project-store.js";
import { BadRequestError, ForbiddenError, NotFoundError } from "../errors.js";
import { ROUTES } from "../project-routes.js";
import type { RouteDefinition, RouteHandlerArgs } from "../types.js";

await initializePostgresDb();

const NOW = 1_760_000_000_000;

function handler(operationId: string): RouteDefinition["handler"] {
  const route = ROUTES.find((entry) => entry.operationId === operationId);
  if (!route) {
    throw new Error(`Route ${operationId} not found`);
  }
  return route.handler;
}

const list = handler("projects_list");
const create = handler("projects_create");
const rename = handler("projects_rename");
const archive = handler("projects_archive");
const getConversationProjects = handler("conversation_projects_list");
const setConversationProjects = handler("conversation_projects_replace");

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

async function seedConversation(id: string): Promise<void> {
  await requireMainDb().run(
    "INSERT INTO conversations (id, created_at, updated_at) VALUES (?, ?, ?)",
    [id, NOW, NOW],
  );
}

function expectHttpError(error: unknown, type: unknown): void {
  expect(error).toBeInstanceOf(type as new (...args: never[]) => Error);
}

interface ProjectResponse {
  id: string;
  name: string;
  kind: string;
  isArchived: boolean;
}

interface TreeResponse {
  projects: Array<{ id: string; children: Array<{ id: string }> }>;
}

describePg("project routes (postgres)", () => {
  beforeEach(async () => {
    await resetProjects();
  });

  test("lists the Inbox as the only root by default", async () => {
    const result = (await list({ queryParams: {} } as RouteHandlerArgs)) as
      | TreeResponse
      | undefined;
    expect(result?.projects.map((node) => node.id)).toEqual([INBOX_PROJECT_ID]);
  });

  test("creates, renames and archives a project", async () => {
    const created = (await create({
      body: { name: "Cliente X", description: "Lavoro" },
    } as RouteHandlerArgs)) as ProjectResponse;
    expect(created.kind).toBe("user");
    expect(created.isArchived).toBe(false);

    const renamed = (await rename({
      pathParams: { projectId: created.id },
      body: { name: "Cliente X 2026" },
    } as RouteHandlerArgs)) as ProjectResponse;
    expect(renamed.name).toBe("Cliente X 2026");

    const archived = (await archive({
      pathParams: { projectId: created.id },
    } as RouteHandlerArgs)) as ProjectResponse;
    expect(archived.isArchived).toBe(true);

    const after = (await list({ queryParams: {} } as RouteHandlerArgs)) as
      | TreeResponse
      | undefined;
    expect(after?.projects.map((node) => node.id)).toEqual([INBOX_PROJECT_ID]);

    const withArchived = (await list({
      queryParams: { includeArchived: "1" },
    } as RouteHandlerArgs)) as TreeResponse | undefined;
    expect(withArchived?.projects.map((node) => node.id)).toContain(created.id);
  });

  test("nests children in the tree", async () => {
    const parent = (await create({
      body: { name: "Cliente X" },
    } as RouteHandlerArgs)) as ProjectResponse;
    const child = (await create({
      body: { name: "Sito", parentId: parent.id },
    } as RouteHandlerArgs)) as ProjectResponse;

    const result = (await list({ queryParams: {} } as RouteHandlerArgs)) as
      | TreeResponse
      | undefined;
    const parentNode = result?.projects.find((node) => node.id === parent.id);
    expect(parentNode?.children.map((node) => node.id)).toEqual([child.id]);
  });

  test("refuses to archive the Inbox", async () => {
    try {
      await archive({
        pathParams: { projectId: INBOX_PROJECT_ID },
      } as RouteHandlerArgs);
      throw new Error("expected archive to reject");
    } catch (error) {
      expectHttpError(error, ForbiddenError);
    }
  });

  test("returns 404 for an unknown project", async () => {
    try {
      await rename({
        pathParams: { projectId: "missing" },
        body: { name: "X" },
      } as RouteHandlerArgs);
      throw new Error("expected rename to reject");
    } catch (error) {
      expectHttpError(error, NotFoundError);
    }
  });

  test("rejects an invalid create body", async () => {
    try {
      await create({ body: {} } as RouteHandlerArgs);
      throw new Error("expected create to reject");
    } catch (error) {
      expectHttpError(error, BadRequestError);
    }
  });

  test("reads and replaces the conversation project set", async () => {
    await seedConversation("conv-1");
    const alpha = (await create({
      body: { name: "Alpha" },
    } as RouteHandlerArgs)) as ProjectResponse;
    const beta = (await create({
      body: { name: "Beta" },
    } as RouteHandlerArgs)) as ProjectResponse;

    const replaced = (await setConversationProjects({
      pathParams: { conversationId: "conv-1" },
      body: { projectIds: [beta.id, alpha.id] },
    } as RouteHandlerArgs)) as { projectIds: string[] };
    expect(replaced.projectIds).toEqual([alpha.id, beta.id].sort());

    const read = (await getConversationProjects({
      pathParams: { conversationId: "conv-1" },
    } as RouteHandlerArgs)) as { projectIds: string[] };
    expect(read.projectIds).toEqual([alpha.id, beta.id].sort());
  });

  test("returns 404 for an unknown conversation", async () => {
    try {
      await setConversationProjects({
        pathParams: { conversationId: "missing" },
        body: { projectIds: [] },
      } as RouteHandlerArgs);
      throw new Error("expected the set write to reject");
    } catch (error) {
      expectHttpError(error, NotFoundError);
    }
  });

  test("returns 404 when reading an unknown conversation", async () => {
    try {
      await getConversationProjects({
        pathParams: { conversationId: "missing" },
      } as RouteHandlerArgs);
      throw new Error("expected the set read to reject");
    } catch (error) {
      expectHttpError(error, NotFoundError);
    }
  });

  test("returns 404 for an unknown project in the set", async () => {
    await seedConversation("conv-1");
    try {
      await setConversationProjects({
        pathParams: { conversationId: "conv-1" },
        body: { projectIds: ["missing"] },
      } as RouteHandlerArgs);
      throw new Error("expected the set write to reject");
    } catch (error) {
      expectHttpError(error, NotFoundError);
    }
  });
});
