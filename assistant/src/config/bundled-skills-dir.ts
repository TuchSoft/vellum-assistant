import { existsSync } from "node:fs";
import { dirname, join } from "node:path";

import { isBunVirtualPath } from "../util/bundled-asset.js";

/**
 * Resolve the directory that ships the bundled skills.
 *
 * Kept in its own module so security-sensitive consumers (capability
 * resolution) do not depend on the full skill catalog module, which many tests
 * mock with a partial surface.
 */
export function getBundledSkillsDir(): string {
  const dir = import.meta.dir;

  // In compiled Bun binaries, import.meta.dir points into the virtual
  // /$bunfs/ filesystem where non-JS assets don't exist. Fall back to the
  // macOS .app bundle Resources dir or next to the binary.
  if (isBunVirtualPath(dir)) {
    const execDir = dirname(process.execPath);
    // macOS .app bundle: binary is in Contents/MacOS/, resources in
    // Contents/Resources/.
    const resourcesPath = join(execDir, "..", "Resources", "bundled-skills");
    if (existsSync(resourcesPath)) {
      return resourcesPath;
    }
    // Next to the binary itself (non-app-bundle deployments).
    const execDirPath = join(execDir, "bundled-skills");
    if (existsSync(execDirPath)) {
      return execDirPath;
    }
  }

  return join(dir, "bundled-skills");
}
