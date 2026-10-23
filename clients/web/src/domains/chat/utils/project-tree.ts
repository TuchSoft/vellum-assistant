/**
 * Pure helpers for the projects sidebar: tree flattening, the Inbox rules,
 * and the membership set arithmetic.
 *
 * The membership set is the whole model: a conversation belongs to zero or
 * more projects, there is no primary project, and the write route replaces the
 * set. Every UI action is therefore "add one member" or "remove one member"
 * against a set the server last returned, which is what these helpers express.
 * Keeping them pure keeps the components testable without a daemon.
 */

import type { ProjectNode } from "@/domains/chat/components/projects/projects-api";

/** The Inbox id is stable across installs (the migration hardcodes it). */
export const INBOX_PROJECT_ID = "inbox";

export interface ProjectTreeRow {
  project: ProjectNode;
  /** Nesting level; the Inbox and user roots sit at 0. */
  depth: number;
  hasChildren: boolean;
}

export function isInboxProject(project: ProjectNode): boolean {
  return project.kind === "inbox";
}

/**
 * Only user projects can be archived; the server answers 403 for the Inbox and
 * the system buckets. The UI hides the action instead of offering a write that
 * is known to fail.
 */
export function canArchiveProject(project: ProjectNode): boolean {
  return project.kind === "user" && !project.isArchived;
}

/**
 * Flatten the tree into the rows the sidebar draws, in order, descending only
 * into expanded nodes. The Inbox and every user root are always drawn; a
 * collapsed node hides its whole subtree.
 */
export function visibleProjectRows(
  nodes: readonly ProjectNode[],
  isExpanded: (projectId: string) => boolean,
): ProjectTreeRow[] {
  const rows: ProjectTreeRow[] = [];

  const walk = (siblings: readonly ProjectNode[], depth: number): void => {
    for (const project of siblings) {
      const hasChildren = project.children.length > 0;
      rows.push({ project, depth, hasChildren });
      if (hasChildren && isExpanded(project.id)) {
        walk(project.children, depth + 1);
      }
    }
  };

  walk(nodes, 0);
  return rows;
}

/**
 * Every ancestor id of a project, nearest first. Used to open the path to a
 * project the UI is about to reveal (a freshly created child, for instance).
 */
export function projectAncestorIds(
  nodes: readonly ProjectNode[],
  projectId: string,
): string[] {
  const path: string[] = [];

  const walk = (siblings: readonly ProjectNode[], ancestors: string[]): boolean => {
    for (const project of siblings) {
      if (project.id === projectId) {
        path.push(...ancestors);
        return true;
      }
      if (walk(project.children, [...ancestors, project.id])) {
        return true;
      }
    }
    return false;
  };

  walk(nodes, []);
  return path;
}

/** Whether the set already places the conversation in the project. */
export function setIncludesProject(
  projectIds: readonly string[],
  projectId: string,
): boolean {
  return projectIds.includes(projectId);
}

/**
 * Add or remove one project from a set, without touching the other members.
 *
 * The result is sorted by id so two writes that end in the same membership
 * produce the same request body, and so a conversation in two projects keeps
 * both no matter which one the user toggles.
 */
export function toggleProjectMembership(
  projectIds: readonly string[],
  projectId: string,
): string[] {
  const next = new Set(projectIds);
  if (next.has(projectId)) {
    next.delete(projectId);
  } else {
    next.add(projectId);
  }
  return [...next].sort((a, b) => a.localeCompare(b));
}
