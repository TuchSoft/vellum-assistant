/**
 * Tests for the task_progress hint in the 01-progress-surface workspace
 * system prompt section.
 *
 * Verifies that the task_progress guidance renders unconditionally in the
 * system prompt — no `enabled` frontmatter gating, no options dependency.
 */

import { beforeEach, describe, expect, mock, test } from "bun:test";

const noopLogger: Record<string, unknown> = new Proxy(
  {} as Record<string, unknown>,
  {
    get: (_target, prop) => (prop === "child" ? () => noopLogger : () => {}),
  },
);

// eslint-disable-next-line @typescript-eslint/no-require-imports
const realLogger = require("../../util/logger.js");
mock.module("../../util/logger.js", () => ({
  ...realLogger,
  getLogger: () => noopLogger,
  getCliLogger: () => noopLogger,
  truncateForLog: (v: string) => v,
  initLogger: () => {},
  pruneOldLogFiles: () => 0,
}));

const { buildSystemPrompt, ensurePromptFiles } =
  await import("../system-prompt.js");

describe("task_progress hint in progress-surface section", () => {
  beforeEach(async () => {
    await ensurePromptFiles();
  });

  test("await buildSystemPrompt() includes task_progress guidance", async () => {
    const result = await buildSystemPrompt();
    expect(result).toContain("task_progress");
    expect(result).toContain("Show Progress on Long Turns");
  });

  test("renders unconditionally — no options required", async () => {
    const result = await buildSystemPrompt(undefined);
    expect(result).toContain("task_progress");
  });

  test("renders regardless of options passed", async () => {
    const withClientFlag = await buildSystemPrompt({ hasNoClient: true });
    const withoutClientFlag = await buildSystemPrompt({ hasNoClient: false });
    const withExcludePrefix = await buildSystemPrompt({
      excludeCustomPrefix: true,
    });

    expect(withClientFlag).toContain("task_progress");
    expect(withoutClientFlag).toContain("task_progress");
    expect(withExcludePrefix).toContain("task_progress");
  });
});
