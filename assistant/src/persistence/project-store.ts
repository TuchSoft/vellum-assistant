/**
 * Project store: the `projects` entity, conversation membership, and the
 * inherited project set of a fork, subagent or scheduled run.
 *
 * A project owns no data. It carries a name and a briefing (kept in files by
 * the agent) and membership is a set per conversation, with no primary
 * project. Membership lives in `conversation_projects` rather than on the
 * conversation row because pinning rewrites `conversations.group_id`.
 *
 * Every function reads and writes the main Postgres database through the async
 * facade; the tables are created by the `0003_projects` migration step.
 */

import { and, asc, eq, inArray, ne } from "drizzle-orm";
import { v4 as uuid } from "uuid";

import { UserError } from "../util/errors.js";
import { requireMainDb } from "./db-facade.js";

/** The single catch-all project. Its id is stable across installs. */
export const INBOX_PROJECT_ID = "inbox";

/**
 * Guard against a malformed parent chain when walking ancestry. Fork depth is
 * small in practice, so this truncates a corrupted pointer chain instead of
 * walking unboundedly.
 */
export const PROJECT_INHERITANCE_MAX_DEPTH = 32;

export type ProjectKind = "user" | "system" | "inbox";

/**
 * Why a store call was refused. Routes map each reason onto an HTTP status so
 * the store stays free of transport concerns.
 */
export type ProjectErrorReason = "not_found" | "invalid" | "forbidden";

export class ProjectStoreError extends UserError {
  constructor(
    message: string,
    readonly reason: ProjectErrorReason,
  ) {
    super(message);
    this.name = "ProjectStoreError";
  }
}

export interface ProjectRow {
  id: string;
  name: string;
  description: string | null;
  parentId: string | null;
  kind: ProjectKind;
  sortPosition: number;
  isArchived: boolean;
  createdAt: number;
  updatedAt: number;
  archivedAt: number | null;
}

/** A project plus its children, as returned by the list route. */
export interface ProjectTreeNode extends ProjectRow {
  children: ProjectTreeNode[];
}

export interface ListProjectsOptions {
  /** Include archived projects. Default false. */
  includeArchived?: boolean;
  /** Include the `system` bucket projects. Default false. */
  includeSystem?: boolean;
}

export interface CreateProjectInput {
  name: string;
  description?: string | null;
  parentId?: string | null;
}

function toProjectRow(row: {
  id: string;
  name: string;
  description: string | null;
  parentId: string | null;
  kind: string;
  sortPosition: number;
  isArchived: boolean;
  createdAt: number;
  updatedAt: number;
  archivedAt: number | null;
}): ProjectRow {
  return {
    id: row.id,
    name: row.name,
    description: row.description,
    parentId: row.parentId,
    kind: row.kind as ProjectKind,
    sortPosition: Number(row.sortPosition),
    isArchived: Boolean(row.isArchived),
    createdAt: Number(row.createdAt),
    updatedAt: Number(row.updatedAt),
    archivedAt: row.archivedAt === null ? null : Number(row.archivedAt),
  };
}

function requireName(name: string): string {
  const trimmed = name.trim();
  if (trimmed.length === 0) {
    throw new ProjectStoreError("Project name is required", "invalid");
  }
  return trimmed;
}

// ---------------------------------------------------------------------------
// Projects
// ---------------------------------------------------------------------------

/** Every project matching the filters, ordered by sort position then name. */
export async function listProjects(
  options: ListProjectsOptions = {},
): Promise<ProjectRow[]> {
  const db = requireMainDb();
  const projects = db.schema.projects;
  const conditions = [];
  if (!options.includeArchived) {
    conditions.push(eq(projects.isArchived, false));
  }
  if (!options.includeSystem) {
    conditions.push(ne(projects.kind, "system"));
  }
  const rows = await db.orm
    .select()
    .from(projects)
    .where(conditions.length > 0 ? and(...conditions) : undefined)
    .orderBy(asc(projects.sortPosition), asc(projects.name));
  return rows.map(toProjectRow);
}

/**
 * Build the tree from a flat, ordered list. A row whose parent is not in the
 * list (for example an archived parent, excluded from the query) is rendered
 * as a root so it never disappears from the response.
 */
export function buildProjectTree(rows: ProjectRow[]): ProjectTreeNode[] {
  const nodes = new Map<string, ProjectTreeNode>();
  for (const row of rows) {
    nodes.set(row.id, { ...row, children: [] });
  }
  const roots: ProjectTreeNode[] = [];
  for (const row of rows) {
    const node = nodes.get(row.id);
    if (!node) {
      continue;
    }
    const parent = row.parentId ? nodes.get(row.parentId) : undefined;
    if (parent) {
      parent.children.push(node);
    } else {
      roots.push(node);
    }
  }
  return roots;
}

export async function getProject(id: string): Promise<ProjectRow | null> {
  const db = requireMainDb();
  const projects = db.schema.projects;
  const [row] = await db.orm.select().from(projects).where(eq(projects.id, id));
  return row ? toProjectRow(row) : null;
}

/**
 * Create a user project. The id is server-assigned; the sort position follows
 * the last user project so new projects land at the end of their level.
 */
export async function createProject(
  input: CreateProjectInput,
): Promise<ProjectRow> {
  const name = requireName(input.name);
  const db = requireMainDb();
  const projects = db.schema.projects;

  const parentId = input.parentId ?? null;
  if (parentId) {
    const parent = await getProject(parentId);
    if (!parent) {
      throw new ProjectStoreError(
        `Parent project not found: ${parentId}`,
        "not_found",
      );
    }
  }

  const maxRow = await db.get<{ max: number | null }>(
    "SELECT MAX(sort_position) AS max FROM projects WHERE kind = 'user'",
  );
  const sortPosition = Number(maxRow?.max ?? -1) + 1;
  const now = Date.now();
  const [row] = await db.orm
    .insert(projects)
    .values({
      id: uuid(),
      name,
      description: input.description ?? null,
      parentId,
      kind: "user",
      sortPosition,
      isArchived: false,
      createdAt: now,
      updatedAt: now,
      archivedAt: null,
    })
    .returning();
  return toProjectRow(row);
}

/** Rename a project. Returns null when the project does not exist. */
export async function renameProject(
  id: string,
  name: string,
): Promise<ProjectRow | null> {
  const trimmed = requireName(name);
  const db = requireMainDb();
  const projects = db.schema.projects;
  const [row] = await db.orm
    .update(projects)
    .set({ name: trimmed, updatedAt: Date.now() })
    .where(eq(projects.id, id))
    .returning();
  return row ? toProjectRow(row) : null;
}

/**
 * Archive a project. Only `user` projects are archivable: the Inbox and the
 * system buckets always exist. Archiving is idempotent.
 */
export async function archiveProject(id: string): Promise<ProjectRow | null> {
  const existing = await getProject(id);
  if (!existing) {
    return null;
  }
  if (existing.kind !== "user") {
    throw new ProjectStoreError(`Project ${id} is not archivable`, "forbidden");
  }
  if (existing.isArchived) {
    return existing;
  }
  const db = requireMainDb();
  const projects = db.schema.projects;
  const now = Date.now();
  const [row] = await db.orm
    .update(projects)
    .set({ isArchived: true, archivedAt: now, updatedAt: now })
    .where(eq(projects.id, id))
    .returning();
  return row ? toProjectRow(row) : null;
}

// ---------------------------------------------------------------------------
// Conversation membership
// ---------------------------------------------------------------------------

/** Whether a conversation row exists. */
export async function conversationExists(
  conversationId: string,
): Promise<boolean> {
  const db = requireMainDb();
  const row = await db.get<{ id: string }>(
    "SELECT id FROM conversations WHERE id = ?",
    [conversationId],
  );
  return row !== null;
}

/** The project set of a conversation, ordered by project id. */
export async function getConversationProjectIds(
  conversationId: string,
): Promise<string[]> {
  const db = requireMainDb();
  const membership = db.schema.conversationProjects;
  const rows = await db.orm
    .select({ projectId: membership.projectId })
    .from(membership)
    .where(eq(membership.conversationId, conversationId))
    .orderBy(asc(membership.projectId));
  return rows.map((row) => row.projectId);
}

/**
 * The project sets of many conversations, keyed by conversation id. A list
 * reading a page of rows resolves every row's projects with one query instead
 * of one per row. Conversations without projects are absent from the map.
 */
export async function getConversationProjectIdsForConversations(
  conversationIds: readonly string[],
): Promise<Map<string, string[]>> {
  const sets = new Map<string, string[]>();
  if (conversationIds.length === 0) {
    return sets;
  }

  const db = requireMainDb();
  const membership = db.schema.conversationProjects;
  const rows = await db.orm
    .select({
      conversationId: membership.conversationId,
      projectId: membership.projectId,
    })
    .from(membership)
    .where(inArray(membership.conversationId, [...conversationIds]))
    .orderBy(asc(membership.conversationId), asc(membership.projectId));

  for (const row of rows) {
    const existing = sets.get(row.conversationId);
    if (existing) {
      existing.push(row.projectId);
    } else {
      sets.set(row.conversationId, [row.projectId]);
    }
  }
  return sets;
}

/**
 * Replace a conversation's project set. Duplicates collapse; an empty array is
 * a valid set. Unknown and archived projects are rejected.
 */
export async function setConversationProjects(
  conversationId: string,
  projectIds: readonly string[],
): Promise<string[]> {
  const db = requireMainDb();
  if (!(await conversationExists(conversationId))) {
    throw new ProjectStoreError(
      `Conversation not found: ${conversationId}`,
      "not_found",
    );
  }

  const unique = [...new Set(projectIds)];
  if (unique.length > 0) {
    const projects = db.schema.projects;
    const rows = await db.orm
      .select({ id: projects.id, isArchived: projects.isArchived })
      .from(projects)
      .where(inArray(projects.id, unique));
    const found = new Map(rows.map((row) => [row.id, row]));
    const missing = unique.filter((id) => !found.has(id));
    if (missing.length > 0) {
      throw new ProjectStoreError(
        `Unknown project: ${missing.join(", ")}`,
        "not_found",
      );
    }
    const archived = unique.filter((id) => found.get(id)?.isArchived === true);
    if (archived.length > 0) {
      throw new ProjectStoreError(
        `Project is archived: ${archived.join(", ")}`,
        "invalid",
      );
    }
  }

  const membership = db.schema.conversationProjects;
  await db.transaction(async (tx) => {
    await tx.orm
      .delete(membership)
      .where(eq(membership.conversationId, conversationId));
    if (unique.length > 0) {
      await tx.orm
        .insert(membership)
        .values(unique.map((projectId) => ({ conversationId, projectId })));
    }
  });

  return [...unique].sort();
}

/**
 * The project set a conversation inherits from the conversation that spawned
 * it: a fork reads through `fork_parent_conversation_id`, a subagent through
 * `parent_conversation_id`. The nearest ancestor that owns a non-empty set
 * wins; a conversation with its own set keeps it.
 *
 * Scheduled runs inherit through `cron_job_projects`, which is out of scope
 * here.
 */
export async function resolveInheritedProjectIds(
  conversationId: string,
): Promise<string[]> {
  const db = requireMainDb();
  const visited = new Set<string>();
  let current: string | null = conversationId;

  for (
    let depth = 0;
    current !== null && depth < PROJECT_INHERITANCE_MAX_DEPTH;
    depth += 1
  ) {
    if (visited.has(current)) {
      break;
    }
    visited.add(current);

    const ids = await getConversationProjectIds(current);
    if (ids.length > 0) {
      return ids;
    }

    const row: {
      fork_parent_conversation_id: string | null;
      parent_conversation_id: string | null;
    } | null = await db.get<{
      fork_parent_conversation_id: string | null;
      parent_conversation_id: string | null;
    }>(
      "SELECT fork_parent_conversation_id, parent_conversation_id FROM conversations WHERE id = ?",
      [current],
    );
    if (!row) {
      break;
    }
    current =
      row.fork_parent_conversation_id ?? row.parent_conversation_id ?? null;
  }

  return [];
}
