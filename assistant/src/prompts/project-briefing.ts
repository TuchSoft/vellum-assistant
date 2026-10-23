/**
 * Project briefing for the stable context prefix.
 *
 * A project carries no data. It contributes a name and a briefing kept by the
 * agent in `/workspace/data/projects/<id>/refs.yaml`, and a conversation sees
 * the union of its inherited project set (see `resolveInheritedProjectIds`).
 *
 * This module turns that set into a compact, deterministic text block that the
 * `10b-project-briefing` system-prompt section renders inside the cached
 * prefix. The same set and the same files always produce the same bytes, so a
 * rebuild only changes the prompt when membership or a `refs.yaml` changed.
 *
 * Every failure mode (no database, unreadable file, malformed YAML, missing
 * fields) degrades to less content, never to an error: a project without a
 * usable briefing still appears with its name, and the turn continues.
 */

import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

import { parse as parseYaml } from "yaml";
import { z } from "zod";

import {
  getProject,
  INBOX_PROJECT_ID,
  type ProjectRow,
  resolveInheritedProjectIds,
} from "../persistence/project-store.js";
import { getLogger } from "../util/logger.js";
import { getWorkspaceDir } from "../util/platform.js";

const log = getLogger("project-briefing");

/** Directory holding one briefing per project, relative to the workspace. */
const PROJECTS_DIR = join("data", "projects");

/**
 * Project ids are server-assigned UUIDs plus the stable `inbox` id. Reject
 * anything else before it reaches a filesystem path.
 */
const SAFE_PROJECT_ID = /^[A-Za-z0-9_-]+$/;

/**
 * One briefing entry. `name`, `where` and `what` are mandatory per the design;
 * `access` is optional. Any other field (`exclusive`, `tags`, `credentials`,
 * or a field the agent invents later) is tolerated and ignored here.
 */
const ProjectRefSchema = z
  .object({
    name: z.string(),
    where: z.string(),
    what: z.string(),
    access: z.string().optional(),
  })
  .passthrough();

const RefsFileSchema = z
  .object({
    refs: z.array(z.unknown()).optional(),
  })
  .passthrough();

export interface ProjectBriefingRef {
  name: string;
  where: string;
  what: string;
  access: string | null;
}

export interface ProjectBriefingEntry {
  project: ProjectRow;
  refs: ProjectBriefingRef[];
}

/**
 * Collapse a free-text field to one line so the block stays line-oriented, and
 * neutralize the field separator so a value cannot forge an extra column.
 */
function sanitizeField(value: string): string {
  return value.replace(/\s+/g, " ").replace(/\|/g, "/").trim();
}

/** Read and validate one project's `refs.yaml`. Any problem yields no refs. */
function readProjectRefs(
  workspaceDir: string,
  projectId: string,
): ProjectBriefingRef[] {
  if (!SAFE_PROJECT_ID.test(projectId)) {
    return [];
  }
  const filePath = join(workspaceDir, PROJECTS_DIR, projectId, "refs.yaml");
  if (!existsSync(filePath)) {
    return [];
  }

  let raw: string;
  try {
    raw = readFileSync(filePath, "utf-8");
  } catch (err) {
    log.warn(
      { err, projectId },
      "Failed to read project refs.yaml (non-fatal): project renders without a briefing",
    );
    return [];
  }

  let parsed: unknown;
  try {
    parsed = parseYaml(raw);
  } catch (err) {
    log.warn(
      { err, projectId },
      "Malformed project refs.yaml (non-fatal): project renders without a briefing",
    );
    return [];
  }

  const file = RefsFileSchema.safeParse(parsed);
  if (!file.success) {
    return [];
  }

  const refs: ProjectBriefingRef[] = [];
  for (const item of file.data.refs ?? []) {
    const ref = ProjectRefSchema.safeParse(item);
    if (!ref.success) {
      continue;
    }
    const name = sanitizeField(ref.data.name);
    const where = sanitizeField(ref.data.where);
    const what = sanitizeField(ref.data.what);
    if (name.length === 0 || where.length === 0 || what.length === 0) {
      continue;
    }
    const access = ref.data.access ? sanitizeField(ref.data.access) : "";
    refs.push({ name, where, what, access: access.length > 0 ? access : null });
  }
  return refs;
}

/**
 * Render the block. Entries are ordered by project name then id, independent of
 * the database's ordering, so two builds over the same inputs are identical.
 * Returns null when there is nothing to inject.
 */
export function renderProjectBriefingBlock(
  entries: readonly ProjectBriefingEntry[],
): string | null {
  const ordered = [...entries].sort((a, b) => {
    if (a.project.name !== b.project.name) {
      return a.project.name < b.project.name ? -1 : 1;
    }
    if (a.project.id === b.project.id) {
      return 0;
    }
    return a.project.id < b.project.id ? -1 : 1;
  });

  const lines: string[] = [];
  for (const { project, refs } of ordered) {
    const name = sanitizeField(project.name);
    if (name.length === 0) {
      continue;
    }
    lines.push(`## ${name}`);
    for (const ref of refs) {
      const parts = [
        sanitizeField(ref.name),
        sanitizeField(ref.where),
        sanitizeField(ref.what),
      ];
      if (ref.access) {
        const access = sanitizeField(ref.access);
        if (access.length > 0) {
          parts.push(access);
        }
      }
      lines.push(`- ${parts.join(" | ")}`);
    }
  }

  if (lines.length === 0) {
    return null;
  }
  return ["<projects>", ...lines, "</projects>"].join("\n");
}

/**
 * Resolve the inherited project set of a conversation and render its briefing.
 *
 * The Inbox never contributes a block. A system project contributes only when
 * it has a usable `refs.yaml`; a user project always contributes, with its name
 * alone when the file is absent, empty or malformed.
 */
export async function resolveProjectBriefingBlock(
  conversationId: string | undefined,
): Promise<string | null> {
  if (!conversationId) {
    return null;
  }

  try {
    const projectIds = await resolveInheritedProjectIds(conversationId);
    if (projectIds.length === 0) {
      return null;
    }

    const workspaceDir = getWorkspaceDir();
    const entries: ProjectBriefingEntry[] = [];
    for (const projectId of projectIds) {
      const project = await getProject(projectId);
      if (!project) {
        continue;
      }
      if (project.kind === "inbox" || project.id === INBOX_PROJECT_ID) {
        continue;
      }
      const refs = readProjectRefs(workspaceDir, project.id);
      if (project.kind === "system" && refs.length === 0) {
        continue;
      }
      entries.push({ project, refs });
    }

    return renderProjectBriefingBlock(entries);
  } catch (err) {
    log.warn(
      { err, conversationId },
      "Project briefing resolution failed (non-fatal): no block this turn",
    );
    return null;
  }
}
