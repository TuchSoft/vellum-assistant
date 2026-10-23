/**
 * Tests for the per-project folder helpers: the path shape, creation,
 * idempotence, and the refusal to build a path from an unsafe id.
 *
 * These are filesystem-only: `getWorkspaceDir` resolves under the per-process
 * temp workspace installed by the shared test preload.
 */

import { existsSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { expect, test } from "bun:test";

import { getWorkspaceDir } from "../../util/platform.js";
import {
  ensureProjectDirectories,
  ensureProjectDirectory,
  getProjectDirectoryPath,
} from "../project-directory.js";

const SAFE_ID = "6f1d2a3b-8c4d-4e5f-9a0b-1c2d3e4f5a6b";

test("resolves the folder under data/projects", () => {
  expect(getProjectDirectoryPath(SAFE_ID)).toBe(
    join(getWorkspaceDir(), "data", "projects", SAFE_ID),
  );
  expect(getProjectDirectoryPath("inbox")).toBe(
    join(getWorkspaceDir(), "data", "projects", "inbox"),
  );
});

test("refuses an id that is not a path segment", async () => {
  for (const unsafe of ["../escape", "a/b", "", "a b", "a:b"]) {
    expect(getProjectDirectoryPath(unsafe)).toBeNull();
    expect(await ensureProjectDirectories([unsafe])).toBe(0);
  }
});

test("creates the folder and is idempotent", async () => {
  expect(await ensureProjectDirectory(SAFE_ID)).toBe(true);
  const directory = getProjectDirectoryPath(SAFE_ID)!;
  expect(statSync(directory).isDirectory()).toBe(true);

  // A second call leaves the folder and its content alone.
  writeFileSync(join(directory, "refs.yaml"), "refs: []\n");
  expect(await ensureProjectDirectory(SAFE_ID)).toBe(true);
  expect(existsSync(join(directory, "refs.yaml"))).toBe(true);
});

test("creates no default files", async () => {
  const id = "empty-project";
  await ensureProjectDirectory(id);
  const directory = getProjectDirectoryPath(id)!;
  expect(existsSync(join(directory, "refs.yaml"))).toBe(false);
  expect(existsSync(join(directory, "instructions.md"))).toBe(false);
});

test("ensures many folders, skipping the unsafe ones", async () => {
  const count = await ensureProjectDirectories(["p-one", "../escape", "p-two"]);
  expect(count).toBe(2);
  expect(existsSync(getProjectDirectoryPath("p-one")!)).toBe(true);
  expect(existsSync(getProjectDirectoryPath("p-two")!)).toBe(true);
});

test("de-duplicates the ids it is handed", async () => {
  expect(await ensureProjectDirectories(["p-dup", "p-dup"])).toBe(1);
});
