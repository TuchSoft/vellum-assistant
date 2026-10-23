/**
 * Conformance suite for the project store on Postgres: the entity CRUD, the
 * Inbox singleton, multi-project membership, schedule membership, cascade
 * deletes, the inherited set of a fork or subagent, and the per-project folder.
 *
 * Runs against the process's Postgres test schema, bootstrapped by
 * `src/__tests__/pg-test-db.ts` and migrated through the ordered steps here.
 * Gated on `VELLUM_PG_TEST_URL`; with it unset the suite skips.
 */

import { existsSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { beforeEach, expect, test } from "bun:test";

import { describePg } from "../../__tests__/pg-test-db.js";
import { getWorkspaceDir } from "../../util/platform.js";
import { requireMainDb } from "../db-facade.js";
import { initializePostgresDb } from "../pg-migrations/pg-db-init.js";
import {
  applyScheduleProjectScope,
  archiveProject,
  buildProjectTree,
  createProject,
  ensureProjectDirectoriesForExistingProjects,
  getConversationProjectIds,
  getProject,
  getScheduleProjectIds,
  INBOX_PROJECT_ID,
  listProjects,
  type ProjectErrorReason,
  ProjectStoreError,
  renameProject,
  resolveInheritedProjectIds,
  scheduleExists,
  setConversationProjects,
  setScheduleProjects,
} from "../project-store.js";

await initializePostgresDb();

const NOW = 1_760_000_000_000;

async function resetProjects(): Promise<void> {
  const db = requireMainDb();
  await db.exec("DELETE FROM cron_job_projects");
  await db.exec("DELETE FROM cron_jobs");
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

async function seedSchedule(id: string): Promise<void> {
  await requireMainDb().run(
    `INSERT INTO cron_jobs (id, name, message, next_run_at, created_by, created_at, updated_at)
     VALUES (?, ?, ?, ?, 'user', ?, ?)`,
    [id, `Schedule ${id}`, "do the thing", NOW, NOW, NOW],
  );
}

/** The folder the store hands a project, as a test asserts it on disk. */
function projectFolder(projectId: string): string {
  return join(getWorkspaceDir(), "data", "projects", projectId);
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

  test("stores a schedule's multi-project set", async () => {
    await seedSchedule("sched-1");
    const alpha = await createProject({ name: "Alpha" });
    const beta = await createProject({ name: "Beta" });

    expect(await scheduleExists("sched-1")).toBe(true);
    expect(await scheduleExists("missing")).toBe(false);
    expect(await setScheduleProjects("sched-1", [beta.id, alpha.id])).toEqual(
      [alpha.id, beta.id].sort(),
    );
    expect(await getScheduleProjectIds("sched-1")).toEqual(
      [alpha.id, beta.id].sort(),
    );

    expect(await setScheduleProjects("sched-1", [beta.id])).toEqual([beta.id]);
    expect(await setScheduleProjects("sched-1", [])).toEqual([]);
    expect(await getScheduleProjectIds("sched-1")).toEqual([]);
  });

  test("rejects an unknown schedule, an unknown project and an archived project", async () => {
    await seedSchedule("sched-1");
    const archived = await createProject({ name: "Old" });
    await archiveProject(archived.id);

    try {
      await setScheduleProjects("missing", []);
      throw new Error("expected an unknown schedule to reject");
    } catch (error) {
      expectStoreError(error, "not_found");
    }

    try {
      await setScheduleProjects("sched-1", ["missing"]);
      throw new Error("expected an unknown project to reject");
    } catch (error) {
      expectStoreError(error, "not_found");
    }

    try {
      await setScheduleProjects("sched-1", [archived.id]);
      throw new Error("expected an archived project to reject");
    } catch (error) {
      expectStoreError(error, "invalid");
    }
  });

  test("cascades schedule membership on schedule delete", async () => {
    await seedSchedule("sched-1");
    const project = await createProject({ name: "Alpha" });
    await setScheduleProjects("sched-1", [project.id]);

    await requireMainDb().run("DELETE FROM cron_jobs WHERE id = ?", [
      "sched-1",
    ]);
    const rows = await requireMainDb().all(
      "SELECT * FROM cron_job_projects WHERE project_id = ?",
      [project.id],
    );
    expect(rows).toEqual([]);
  });

  test("cascades schedule membership on project delete", async () => {
    await seedSchedule("sched-1");
    const project = await createProject({ name: "Alpha" });
    await setScheduleProjects("sched-1", [project.id]);

    await requireMainDb().run("DELETE FROM projects WHERE id = ?", [
      project.id,
    ]);
    const rows = await requireMainDb().all(
      "SELECT * FROM cron_job_projects WHERE cron_job_id = ?",
      ["sched-1"],
    );
    expect(rows).toEqual([]);
  });

  test("a run inherits its schedule's project set", async () => {
    await seedSchedule("sched-1");
    await seedConversation("run-1");
    const project = await createProject({ name: "Alpha" });
    await setScheduleProjects("sched-1", [project.id]);

    expect(await applyScheduleProjectScope("run-1", "sched-1")).toEqual([
      project.id,
    ]);
    expect(await getConversationProjectIds("run-1")).toEqual([project.id]);
  });

  test("an empty schedule set leaves the run's own set intact", async () => {
    await seedSchedule("sched-1");
    await seedConversation("run-1");
    const own = await createProject({ name: "Alpha" });
    await setConversationProjects("run-1", [own.id]);

    expect(await applyScheduleProjectScope("run-1", "sched-1")).toEqual([]);
    expect(await getConversationProjectIds("run-1")).toEqual([own.id]);
  });

  test("a project archived after it was attached does not break the run", async () => {
    await seedSchedule("sched-1");
    await seedConversation("run-1");
    const kept = await createProject({ name: "Alpha" });
    const dropped = await createProject({ name: "Beta" });
    await setScheduleProjects("sched-1", [kept.id, dropped.id]);
    await archiveProject(dropped.id);

    expect(await applyScheduleProjectScope("run-1", "sched-1")).toEqual([
      kept.id,
    ]);
    expect(await getConversationProjectIds("run-1")).toEqual([kept.id]);
  });

  test("creating a project creates its folder", async () => {
    const project = await createProject({ name: "Alpha" });
    expect(existsSync(projectFolder(project.id))).toBe(true);
  });

  test("the startup sweep creates the missing folders and keeps their content", async () => {
    const project = await createProject({ name: "Alpha" });
    const other = await createProject({ name: "Beta" });
    const archived = await createProject({ name: "Old" });
    await archiveProject(archived.id);
    // A project created by an older build has no folder; a system project can
    // only exist through the migration, so it is inserted directly.
    rmSync(projectFolder(other.id), { recursive: true, force: true });
    rmSync(projectFolder(archived.id), { recursive: true, force: true });
    await requireMainDb().run(
      `INSERT INTO projects (id, name, kind, sort_position, is_archived, created_at, updated_at)
       VALUES ('system:background', 'Background', 'system', 1, FALSE, ?, ?)
       ON CONFLICT (id) DO NOTHING`,
      [NOW, NOW],
    );
    mkdirSync(projectFolder(project.id), { recursive: true });
    writeFileSync(join(projectFolder(project.id), "instructions.md"), "keep");

    await ensureProjectDirectoriesForExistingProjects();

    expect(existsSync(projectFolder(other.id))).toBe(true);
    expect(existsSync(projectFolder(archived.id))).toBe(true);
    expect(existsSync(join(projectFolder(project.id), "instructions.md"))).toBe(
      true,
    );
    // A `system:` id is not a path segment, so it gets no folder.
    expect(existsSync(projectFolder("system:background"))).toBe(false);

    // A second pass is a no-op on an existing folder.
    await ensureProjectDirectoriesForExistingProjects();
    expect(existsSync(join(projectFolder(project.id), "instructions.md"))).toBe(
      true,
    );
  });
});
