/**
 * Conformance suite for the project store on Postgres: the entity CRUD, the
 * Inbox singleton, multi-project membership, cascade deletes, and the
 * inherited set of a fork or subagent.
 *
 * Runs against the process's Postgres test schema, bootstrapped by
 * `src/__tests__/pg-test-db.ts` and migrated through the ordered steps here.
 * Gated on `VELLUM_PG_TEST_URL`; with it unset the suite skips.
 */

import { beforeEach, expect, test } from "bun:test";

import { describePg } from "../../__tests__/pg-test-db.js";
import { requireMainDb } from "../db-facade.js";
import { initializePostgresDb } from "../pg-migrations/pg-db-init.js";
import {
  archiveProject,
  buildProjectTree,
  createProject,
  getConversationProjectIds,
  getProject,
  INBOX_PROJECT_ID,
  listProjects,
  type ProjectErrorReason,
  ProjectStoreError,
  renameProject,
  resolveInheritedProjectIds,
  setConversationProjects,
} from "../project-store.js";

await initializePostgresDb();

const NOW = 1_760_000_000_000;

async function resetProjects(): Promise<void> {
  const db = requireMainDb();
  await db.exec("DELETE FROM conversation_projects");
  await db.exec("DELETE FROM conversations");
  await db.exec("DELETE FROM projects WHERE kind <> 'inbox'");
  // The migration owns the Inbox row; re-assert it so a suite that ran `down`
  // cannot leave later tests without one.
  await db.run(
    `INSERT INTO projects (id, name, kind, sort_position, is_archived, created_at, updated_at)
     VALUES (?, 'Inbox', 'inbox', -1, FALSE, ?, ?)
     ON CONFLICT (id) DO NOTHING`,
    [INBOX_PROJECT_ID, NOW, NOW],
  );
}

async function seedConversation(
  id: string,
  parents: {
    forkParentConversationId?: string | null;
    parentConversationId?: string | null;
  } = {},
): Promise<void> {
  await requireMainDb().run(
    `INSERT INTO conversations (id, created_at, updated_at, fork_parent_conversation_id, parent_conversation_id)
     VALUES (?, ?, ?, ?, ?)`,
    [
      id,
      NOW,
      NOW,
      parents.forkParentConversationId ?? null,
      parents.parentConversationId ?? null,
    ],
  );
}

function expectStoreError(error: unknown, reason: ProjectErrorReason): void {
  expect(error).toBeInstanceOf(ProjectStoreError);
  expect((error as ProjectStoreError).reason).toBe(reason);
}

describePg("project-store (postgres)", () => {
  beforeEach(async () => {
    await resetProjects();
  });

  test("seeds the Inbox singleton and lists it as a root", async () => {
    const projects = await listProjects();
    expect(projects.map((project) => project.id)).toEqual([INBOX_PROJECT_ID]);
    expect(projects[0]?.kind).toBe("inbox");
    expect(projects[0]?.isArchived).toBe(false);

    const tree = buildProjectTree(projects);
    expect(tree.map((node) => node.id)).toEqual([INBOX_PROJECT_ID]);
    expect(tree[0]?.children).toEqual([]);
  });

  test("creates, reads, renames and archives a project", async () => {
    const created = await createProject({
      name: "Cliente X",
      description: "Lavoro sul cliente",
    });
    expect(created.kind).toBe("user");
    expect(created.isArchived).toBe(false);
    expect(created.sortPosition).toBe(0);

    expect((await getProject(created.id))?.name).toBe("Cliente X");

    const renamed = await renameProject(created.id, "Cliente X 2026");
    expect(renamed?.name).toBe("Cliente X 2026");

    const archived = await archiveProject(created.id);
    expect(archived?.isArchived).toBe(true);
    expect(archived?.archivedAt).not.toBeNull();

    expect((await listProjects()).map((project) => project.id)).toEqual([
      INBOX_PROJECT_ID,
    ]);
    expect(
      (await listProjects({ includeArchived: true })).map(
        (project) => project.id,
      ),
    ).toEqual([INBOX_PROJECT_ID, created.id]);
  });

  test("builds a parent/child tree", async () => {
    const parent = await createProject({ name: "Cliente X" });
    const child = await createProject({
      name: "Sito",
      parentId: parent.id,
    });

    const tree = buildProjectTree(await listProjects());
    const parentNode = tree.find((node) => node.id === parent.id);
    expect(parentNode?.children.map((node) => node.id)).toEqual([child.id]);
  });

  test("rejects archiving the Inbox", async () => {
    try {
      await archiveProject(INBOX_PROJECT_ID);
      throw new Error("expected archiveProject to reject");
    } catch (error) {
      expectStoreError(error, "forbidden");
    }
  });

  test("rejects a parent that does not exist", async () => {
    try {
      await createProject({ name: "Orphan", parentId: "missing" });
      throw new Error("expected createProject to reject");
    } catch (error) {
      expectStoreError(error, "not_found");
    }
  });

  test("stores a multi-project membership with no primary", async () => {
    await seedConversation("conv-1");
    const alpha = await createProject({ name: "Alpha" });
    const beta = await createProject({ name: "Beta" });

    expect(
      await setConversationProjects("conv-1", [beta.id, alpha.id]),
    ).toEqual([alpha.id, beta.id].sort());
    expect(await getConversationProjectIds("conv-1")).toEqual(
      [alpha.id, beta.id].sort(),
    );

    // Replace the whole set, then empty it.
    expect(await setConversationProjects("conv-1", [beta.id])).toEqual([
      beta.id,
    ]);
    expect(await setConversationProjects("conv-1", [])).toEqual([]);
    expect(await getConversationProjectIds("conv-1")).toEqual([]);
  });

  test("rejects unknown conversations, unknown projects and archived projects", async () => {
    await seedConversation("conv-1");
    const archived = await createProject({ name: "Old" });
    await archiveProject(archived.id);

    try {
      await setConversationProjects("missing", []);
      throw new Error("expected an unknown conversation to reject");
    } catch (error) {
      expectStoreError(error, "not_found");
    }

    try {
      await setConversationProjects("conv-1", ["missing"]);
      throw new Error("expected an unknown project to reject");
    } catch (error) {
      expectStoreError(error, "not_found");
    }

    try {
      await setConversationProjects("conv-1", [archived.id]);
      throw new Error("expected an archived project to reject");
    } catch (error) {
      expectStoreError(error, "invalid");
    }
  });

  test("cascades membership on conversation delete", async () => {
    await seedConversation("conv-1");
    const project = await createProject({ name: "Alpha" });
    await setConversationProjects("conv-1", [project.id]);

    await requireMainDb().run("DELETE FROM conversations WHERE id = ?", [
      "conv-1",
    ]);
    const rows = await requireMainDb().all(
      "SELECT * FROM conversation_projects WHERE conversation_id = ?",
      ["conv-1"],
    );
    expect(rows).toEqual([]);
  });

  test("cascades membership on project delete", async () => {
    await seedConversation("conv-1");
    const project = await createProject({ name: "Alpha" });
    await setConversationProjects("conv-1", [project.id]);

    await requireMainDb().run("DELETE FROM projects WHERE id = ?", [
      project.id,
    ]);
    const rows = await requireMainDb().all(
      "SELECT * FROM conversation_projects WHERE project_id = ?",
      [project.id],
    );
    expect(rows).toEqual([]);
  });

  test("inherits the set through a fork parent", async () => {
    await seedConversation("origin");
    const project = await createProject({ name: "Alpha" });
    await setConversationProjects("origin", [project.id]);

    await seedConversation("fork", { forkParentConversationId: "origin" });
    expect(await resolveInheritedProjectIds("fork")).toEqual([project.id]);
  });

  test("inherits the set through a subagent parent", async () => {
    await seedConversation("origin");
    const project = await createProject({ name: "Alpha" });
    await setConversationProjects("origin", [project.id]);

    await seedConversation("subagent", { parentConversationId: "origin" });
    expect(await resolveInheritedProjectIds("subagent")).toEqual([project.id]);
  });

  test("keeps an explicit set on the child", async () => {
    await seedConversation("origin");
    const inherited = await createProject({ name: "Alpha" });
    const own = await createProject({ name: "Beta" });
    await setConversationProjects("origin", [inherited.id]);

    await seedConversation("fork", { forkParentConversationId: "origin" });
    await setConversationProjects("fork", [own.id]);
    expect(await resolveInheritedProjectIds("fork")).toEqual([own.id]);
  });

  test("returns an empty set when no ancestor owns one", async () => {
    await seedConversation("root");
    expect(await resolveInheritedProjectIds("root")).toEqual([]);
    expect(await resolveInheritedProjectIds("missing")).toEqual([]);
  });
});
