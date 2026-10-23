/**
 * Per-project folders under the workspace.
 *
 * A project carries no data, but it owns a folder: the agent writes the
 * briefing (`refs.yaml`) there and the human writes `instructions.md`. This
 * module is the only place that names and creates it, so the briefing reader
 * and the creation path agree on the location.
 *
 * Every function is idempotent and non-fatal. A folder that cannot be created
 * leaves the project fully usable (a project without a briefing), and the next
 * startup pass retries: no caller has to treat a filesystem failure as a
 * reason to fail a project operation.
 */

import { mkdir } from "node:fs/promises";
import { join } from "node:path";

import { getLogger } from "../util/logger.js";
import { getWorkspaceDir } from "../util/platform.js";

const log = getLogger("project-directory");

/** Folder holding one directory per project, relative to the workspace. */
const PROJECTS_DIR = join("data", "projects");

/**
 * Project ids are server-assigned UUIDs, the stable `inbox` id, and the two
 * `system:` buckets. Only the first two can name a folder: a colon is not
 * portable in a path segment, so a system bucket is skipped here (and the
 * briefing reader refuses the same ids).
 */
const SAFE_PROJECT_ID = /^[A-Za-z0-9_-]+$/;

/** The mode `data/memory` is created with. */
const PROJECT_DIR_MODE = 0o755;

/**
 * The folder of one project, or null when the id cannot be used as a path
 * segment. The caller never invents the path itself.
 */
export function getProjectDirectoryPath(projectId: string): string | null {
  if (!SAFE_PROJECT_ID.test(projectId)) {
    return null;
  }
  return join(getWorkspaceDir(), PROJECTS_DIR, projectId);
}

/**
 * Create one project folder. `recursive` makes the call a no-op when the folder
 * already exists, so creation and the startup sweep share it. Files inside are
 * never touched: this module creates no `refs.yaml` and no `instructions.md`.
 */
export async function ensureProjectDirectory(
  projectId: string,
): Promise<boolean> {
  const directory = getProjectDirectoryPath(projectId);
  if (directory === null) {
    log.warn(
      { projectId },
      "Refusing to create a project directory for an unsafe id",
    );
    return false;
  }
  try {
    await mkdir(directory, { recursive: true, mode: PROJECT_DIR_MODE });
    return true;
  } catch (err) {
    log.warn(
      { err, projectId },
      "Failed to create the project directory (non-fatal); the startup sweep retries",
    );
    return false;
  }
}

/** Create the missing folders of many projects. Returns how many were ensured. */
export async function ensureProjectDirectories(
  projectIds: readonly string[],
): Promise<number> {
  let ensured = 0;
  for (const projectId of new Set(projectIds)) {
    // Skip the ids that cannot be a path segment without a log line each: the
    // sweep runs on every boot and a permanent condition is not a warning.
    if (getProjectDirectoryPath(projectId) === null) {
      continue;
    }
    if (await ensureProjectDirectory(projectId)) {
      ensured += 1;
    }
  }
  return ensured;
}
