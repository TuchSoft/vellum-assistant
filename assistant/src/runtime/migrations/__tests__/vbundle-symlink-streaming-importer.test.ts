/**
 * Symlink-handling coverage for the streaming `streamCommitImport`.
 *
 * Scenarios:
 *   1. Round-trip class 1: a typeflag-2 manifest entry is recreated as a real
 *      symlink in the destination workspace. Reading through the link returns
 *      its sibling regular file's bytes.
 *   2. Defense-in-depth: a hand-built bundle whose manifest declares an
 *      absolute `link_target` is rejected at the streaming validator —
 *      `streamCommitImport` returns `validation_failed` and nothing lands on
 *      disk.
 *   3. Defense-in-depth: a hand-built bundle whose manifest declares a
 *      `..`-traversal `link_target` is rejected the same way.
 *   4. Buffer/streaming parity: build ONE fixture bundle and run it through
 *      both `commitImport` (workspace A) and `streamCommitImport`
 *      (workspace B). Compare on-disk states recursively — symlinks must
 *      survive both paths identically. Reports must agree on shape, action,
 *      paths (modulo workspace prefix), size, sha, and backup_path.
 */

import { createHash } from "node:crypto";
import {
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  readlinkSync,
  realpathSync,
  rmSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, relative } from "node:path";
import { Readable } from "node:stream";
import { gzipSync } from "node:zlib";
import { afterEach, beforeEach, describe, expect, test } from "bun:test";

import { buildVBundle } from "../vbundle-builder.js";
import { DefaultPathResolver } from "../vbundle-import-analyzer.js";
import { commitImport } from "../vbundle-importer.js";
import { streamCommitImport } from "../vbundle-streaming-importer.js";
import { buildTestManifest, defaultV1Options } from "./v1-test-helpers.js";

// ---------------------------------------------------------------------------
// Fixture helpers
// ---------------------------------------------------------------------------

function freshWorkspaceDir(prefix: string): string {
  // Wrap with realpathSync so macOS /var → /private/var canonicalization
  // matches the importer's internal `resolve(workspaceDir)`.
  const parent = realpathSync(mkdtempSync(join(tmpdir(), prefix)));
  return join(parent, "workspace");
}

function readableFrom(buf: Uint8Array): Readable {
  return Readable.from([Buffer.from(buf)]);
}

function sha256Hex(input: string | Uint8Array): string {
  return createHash("sha256").update(input).digest("hex");
}

/**
 * Build a minimal gzip-compressed tar containing a manifest plus a
 * tar-typeflag-2 symlink entry whose linkname matches the manifest's
 * declared `link_target`. Used for the defense-in-depth tests where we need
 * the streaming validator to actually parse the bundle and reject the
 * manifest's absolute / traversal target — `buildVBundle` won't help because
 * its tar emit's 100-byte ustar limit on linkname rejects long paths up
 * front (and we want the validator to be the one rejecting).
 */
function buildSymlinkOnlyBundle(input: {
  archivePath: string;
  linkTarget: string;
}): Uint8Array {
  const dbBody = new TextEncoder().encode("db-bytes");
  const manifest = buildTestManifest({
    contents: [
      {
        // Required by the manifest schema cross-field refine.
        path: "workspace/data/db/assistant.db",
        sha256: sha256Hex(dbBody),
        size_bytes: dbBody.length,
      },
      {
        path: input.archivePath,
        sha256: sha256Hex(input.linkTarget),
        size_bytes: 0,
        link_target: input.linkTarget,
      },
    ],
  });
  const manifestJson = JSON.stringify(manifest);
  const manifestBytes = new TextEncoder().encode(manifestJson);

  const manifestEntry = makeTarEntry({
    name: "manifest.json",
    body: manifestBytes,
    typeflag: "0",
  });
  const dbEntry = makeTarEntry({
    name: "workspace/data/db/assistant.db",
    body: dbBody,
    typeflag: "0",
  });
  const symlinkEntry = makeTarEntry({
    name: input.archivePath,
    body: new Uint8Array(0),
    typeflag: "2",
    linkname: input.linkTarget,
  });

  const trailer = new Uint8Array(1024);
  const tar = new Uint8Array(
    manifestEntry.length +
      dbEntry.length +
      symlinkEntry.length +
      trailer.length,
  );
  tar.set(manifestEntry, 0);
  tar.set(dbEntry, manifestEntry.length);
  tar.set(symlinkEntry, manifestEntry.length + dbEntry.length);
  tar.set(trailer, manifestEntry.length + dbEntry.length + symlinkEntry.length);
  return gzipSync(tar);
}

function makeTarEntry(input: {
  name: string;
  body: Uint8Array;
  typeflag: string;
  linkname?: string;
}): Uint8Array {
  const enc = new TextEncoder();
  const header = new Uint8Array(512);

  // Name (offset 0, 100 bytes).
  const nameBytes = enc.encode(input.name);
  header.set(nameBytes.subarray(0, Math.min(100, nameBytes.length)), 0);

  // Mode 0o644 (offset 100, 8 bytes, octal + null).
  header.set(enc.encode("0000644\0"), 100);
  // uid / gid (offset 108 / 116, 8 bytes each).
  header.set(enc.encode("0000000\0"), 108);
  header.set(enc.encode("0000000\0"), 116);

  // Size (offset 124, 12 bytes, octal + null).
  const size = input.body.length;
  const sizeStr = size.toString(8).padStart(11, "0") + "\0";
  header.set(enc.encode(sizeStr), 124);

  // Mtime (offset 136, 12 bytes).
  header.set(enc.encode("00000000000\0"), 136);

  // Checksum placeholder (offset 148, 8 bytes — fill with spaces for the sum).
  for (let i = 148; i < 156; i++) {
    header[i] = 0x20;
  }

  // Typeflag (offset 156, 1 byte).
  header[156] = input.typeflag.charCodeAt(0);

  // Linkname (offset 157, 100 bytes).
  if (input.linkname) {
    const linknameBytes = enc.encode(input.linkname);
    header.set(
      linknameBytes.subarray(0, Math.min(100, linknameBytes.length)),
      157,
    );
  }

  // Magic + version "ustar\0" + "00" (offset 257, 8 bytes total).
  header.set(enc.encode("ustar\x0000"), 257);

  // Compute checksum: sum every byte of the header with the checksum field
  // treated as spaces (which we already initialized).
  let sum = 0;
  for (let i = 0; i < 512; i++) {
    sum += header[i];
  }
  const cksum = sum.toString(8).padStart(6, "0") + "\0 ";
  header.set(enc.encode(cksum), 148);

  // Pad body to 512-byte boundary.
  const padded = new Uint8Array(Math.ceil(size / 512) * 512);
  padded.set(input.body, 0);

  const out = new Uint8Array(header.length + padded.length);
  out.set(header, 0);
  out.set(padded, header.length);
  return out;
}

// ---------------------------------------------------------------------------
// Workspace comparison helper (parity test)
// ---------------------------------------------------------------------------

/**
 * Recursively assert that two workspace dirs have the same structure and
 * content: every relative path appears in both with the same lstat type
 * (symlink/file/directory), same byte content for files, same readlink
 * target for symlinks.
 */
function compareWorkspaces(wsA: string, wsB: string): void {
  const seenA = new Set<string>();
  walkRel(wsA, "", seenA);
  const seenB = new Set<string>();
  walkRel(wsB, "", seenB);

  // Set equality.
  expect([...seenA].sort()).toEqual([...seenB].sort());

  for (const rel of seenA) {
    const aPath = join(wsA, rel);
    const bPath = join(wsB, rel);
    const aStat = lstatSync(aPath);
    const bStat = lstatSync(bPath);
    expect(aStat.isSymbolicLink()).toBe(bStat.isSymbolicLink());
    expect(aStat.isFile()).toBe(bStat.isFile());
    expect(aStat.isDirectory()).toBe(bStat.isDirectory());

    if (aStat.isSymbolicLink()) {
      expect(readlinkSync(aPath)).toBe(readlinkSync(bPath));
    } else if (aStat.isFile()) {
      const aBytes = readFileSync(aPath);
      const bBytes = readFileSync(bPath);
      expect(aBytes.equals(bBytes)).toBe(true);
    }
  }
}

function walkRel(root: string, sub: string, into: Set<string>): void {
  const dir = sub ? join(root, sub) : root;
  let entries;
  try {
    entries = readdirSync(dir);
  } catch {
    return;
  }
  for (const name of entries) {
    // Skip streaming-importer scratch artifacts. The streaming swap creates
    // a `.pre-import-<ts-uuid>` backup dir inside the workspace and removes
    // it via fire-and-forget rm() after success — so the dir may still be
    // on disk when the test inspects the workspace. Buffer importer never
    // produces these.
    if (
      !sub &&
      (name.startsWith(".import-") ||
        name.startsWith(".pre-import-") ||
        name === ".import-marker.json")
    ) {
      continue;
    }
    const rel = sub ? join(sub, name) : name;
    into.add(rel);
    const full = join(dir, name);
    let st;
    try {
      st = lstatSync(full);
    } catch {
      continue;
    }
    if (st.isDirectory()) {
      walkRel(root, rel, into);
    }
  }
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("streamCommitImport — symlinks", () => {
  let workspaceDir: string;
  beforeEach(() => {
    workspaceDir = freshWorkspaceDir("vbundle-stream-symlink-");
  });
  afterEach(() => {
    try {
      rmSync(join(workspaceDir, ".."), { recursive: true, force: true });
    } catch {
      // best-effort
    }
  });

  test("round-trip class 1: streams a typeflag-2 entry into a real symlink", async () => {
    const files = [
      {
        path: "workspace/data/db/assistant.db",
        data: new TextEncoder().encode("db-bytes"),
      },
      {
        path: "workspace/skills/bar.md",
        data: new TextEncoder().encode("hello bar"),
      },
      {
        path: "workspace/skills/foo.md",
        data: new Uint8Array(0),
        linkTarget: "bar.md",
      },
    ];
    const { archive } = buildVBundle({ files, ...defaultV1Options() });

    const result = await streamCommitImport({
      source: readableFrom(archive),
      pathResolver: new DefaultPathResolver(
        workspaceDir,
        undefined,
        () => null,
      ),
      workspaceDir,
    });

    expect(result.ok).toBe(true);
    if (!result.ok) {
      throw new Error("unreachable");
    }

    const fooPath = join(workspaceDir, "skills/foo.md");
    expect(lstatSync(fooPath).isSymbolicLink()).toBe(true);
    expect(readlinkSync(fooPath)).toBe("bar.md");
    expect(readFileSync(fooPath, "utf8")).toBe("hello bar");

    const fooReport = result.report.files.find(
      (f) => f.path === "workspace/skills/foo.md",
    );
    expect(fooReport).toBeDefined();
    expect(fooReport!.action).toBe("created");
    expect(fooReport!.size).toBe(0);
    expect(fooReport!.backup_path).toBeNull();
    expect(fooReport!.sha256).toBe(sha256Hex("bar.md"));
  });

  test("defense-in-depth: absolute link_target → validation_failed, nothing on disk", async () => {
    const archive = buildSymlinkOnlyBundle({
      archivePath: "workspace/skills/abs.md",
      linkTarget: "/etc/passwd",
    });

    const result = await streamCommitImport({
      source: readableFrom(archive),
      pathResolver: new DefaultPathResolver(
        workspaceDir,
        undefined,
        () => null,
      ),
      workspaceDir,
    });

    expect(result.ok).toBe(false);
    if (result.ok) {
      throw new Error("unreachable");
    }
    expect(result.reason).toBe("validation_failed");
    if (result.reason !== "validation_failed") {
      throw new Error("unreachable");
    }
    expect(
      result.errors.some((e) => e.code === "symlink_target_escapes_archive"),
    ).toBe(true);

    expect(() => lstatSync(join(workspaceDir, "skills/abs.md"))).toThrow();
  });

  test("legacy-format symlink entry survives streaming import (rename path)", async () => {
    // Regression: `promoteLegacyStagedFiles` previously fell back to
    // `copyFile` on EXDEV, which dereferences the source symlink and writes
    // the target's content as a regular file. We can't easily simulate
    // EXDEV in a unit test (it requires crossing real filesystems), but
    // exercising the rename path with a legacy-format symlink entry pins
    // the contract and proves the symlink survives the legacy promote.
    const files = [
      // Legacy `skills/*` entries (no `workspace/` prefix) route through
      // `legacyStaged` -> `promoteLegacyStagedFiles`. The `data/db/...`
      // entry (also legacy-format) satisfies the manifest schema's
      // cross-field refine and routes through the same legacy path.
      {
        path: "data/db/assistant.db",
        data: new TextEncoder().encode("db-bytes"),
      },
      {
        path: "skills/bar.md",
        data: new TextEncoder().encode("legacy bar"),
      },
      {
        path: "skills/foo.md",
        data: new Uint8Array(0),
        linkTarget: "bar.md",
      },
    ];
    const { archive } = buildVBundle({ files, ...defaultV1Options() });

    const result = await streamCommitImport({
      source: readableFrom(archive),
      pathResolver: new DefaultPathResolver(
        workspaceDir,
        undefined,
        () => null,
      ),
      workspaceDir,
    });

    expect(result.ok).toBe(true);
    if (!result.ok) {
      throw new Error("unreachable");
    }

    const fooPath = join(workspaceDir, "skills/foo.md");
    expect(lstatSync(fooPath).isSymbolicLink()).toBe(true);
    expect(readlinkSync(fooPath)).toBe("bar.md");
    expect(readFileSync(join(workspaceDir, "skills/bar.md"), "utf8")).toBe(
      "legacy bar",
    );
  });

  test("defense-in-depth: '..' traversal link_target → validation_failed", async () => {
    const archive = buildSymlinkOnlyBundle({
      archivePath: "workspace/skills/escape.md",
      linkTarget: "../../../tmp/escape",
    });

    const result = await streamCommitImport({
      source: readableFrom(archive),
      pathResolver: new DefaultPathResolver(
        workspaceDir,
        undefined,
        () => null,
      ),
      workspaceDir,
    });

    expect(result.ok).toBe(false);
    if (result.ok) {
      throw new Error("unreachable");
    }
    expect(result.reason).toBe("validation_failed");
    if (result.reason !== "validation_failed") {
      throw new Error("unreachable");
    }
    expect(
      result.errors.some((e) => e.code === "symlink_target_escapes_archive"),
    ).toBe(true);

    expect(() => lstatSync(join(workspaceDir, "skills/escape.md"))).toThrow();
  });
});

// ---------------------------------------------------------------------------
// Buffer/streaming parity test (PRIMARY): same fixture, both importers,
// identical on-disk state.
// ---------------------------------------------------------------------------

describe("streamCommitImport — buffer/streaming parity for symlinks", () => {
  let bufferWs: string;
  let streamWs: string;
  beforeEach(() => {
    bufferWs = freshWorkspaceDir("vbundle-parity-buffer-");
    streamWs = freshWorkspaceDir("vbundle-parity-stream-");
  });
  afterEach(() => {
    for (const ws of [bufferWs, streamWs]) {
      try {
        rmSync(join(ws, ".."), { recursive: true, force: true });
      } catch {
        // best-effort
      }
    }
  });

  test("commitImport and streamCommitImport produce identical workspaces for a symlink-bearing bundle", async () => {
    const files = [
      {
        path: "workspace/data/db/assistant.db",
        data: new TextEncoder().encode("db-bytes"),
      },
      {
        path: "workspace/skills/bar.md",
        data: new TextEncoder().encode("hello bar"),
      },
      {
        path: "workspace/skills/foo.md",
        data: new Uint8Array(0),
        linkTarget: "bar.md",
      },
    ];
    const { archive } = buildVBundle({ files, ...defaultV1Options() });

    // Buffer path.
    mkdirSync(bufferWs, { recursive: true });
    const bufferResult = await commitImport({
      archiveData: archive,
      pathResolver: new DefaultPathResolver(bufferWs, undefined, () => null),
      workspaceDir: bufferWs,
    });

    // Streaming path. `streamCommitImport` creates the workspace dir itself
    // when it doesn't exist.
    const streamResult = await streamCommitImport({
      source: readableFrom(archive),
      pathResolver: new DefaultPathResolver(streamWs, undefined, () => null),
      workspaceDir: streamWs,
    });

    expect(bufferResult.ok).toBe(true);
    expect(streamResult.ok).toBe(true);
    if (!bufferResult.ok || !streamResult.ok) {
      throw new Error("unreachable");
    }

    // On-disk parity: every path, type, content, and link target must match.
    compareWorkspaces(bufferWs, streamWs);

    // Symlink survived under both.
    const bufferLink = join(bufferWs, "skills/foo.md");
    const streamLink = join(streamWs, "skills/foo.md");
    expect(lstatSync(bufferLink).isSymbolicLink()).toBe(true);
    expect(lstatSync(streamLink).isSymbolicLink()).toBe(true);
    expect(readlinkSync(bufferLink)).toBe(readlinkSync(streamLink));
    expect(readlinkSync(streamLink)).toBe("bar.md");

    // Report parity: per-entry symlink metadata must agree, modulo the
    // workspace-dir prefix (which differs between bufferWs and streamWs).
    const bufferEntry = bufferResult.report.files.find(
      (f) => f.path === "workspace/skills/foo.md",
    );
    const streamEntry = streamResult.report.files.find(
      (f) => f.path === "workspace/skills/foo.md",
    );
    expect(bufferEntry).toBeDefined();
    expect(streamEntry).toBeDefined();
    expect(streamEntry!.action).toBe(bufferEntry!.action);
    expect(streamEntry!.size).toBe(bufferEntry!.size);
    expect(streamEntry!.sha256).toBe(bufferEntry!.sha256);
    expect(streamEntry!.backup_path).toBe(bufferEntry!.backup_path);
    expect(relative(bufferWs, bufferEntry!.disk_path)).toBe(
      relative(streamWs, streamEntry!.disk_path),
    );
  });
});
