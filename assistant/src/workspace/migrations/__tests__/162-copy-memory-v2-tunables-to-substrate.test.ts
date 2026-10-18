import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, test } from "bun:test";

import { MemoryConfigSchema } from "../../../config/schemas/memory.js";
import { resolveSubstrateTuning } from "../../../plugins/defaults/memory/substrate/tuning.js";
import { copyMemoryV2TunablesToSubstrateMigration as MIG } from "../162-copy-memory-v2-tunables-to-substrate.js";

let workspaceDir: string;
let configPath: string;

function write(obj: unknown): void {
  writeFileSync(configPath, JSON.stringify(obj, null, 2) + "\n");
}
function read(): Record<string, unknown> {
  return JSON.parse(readFileSync(configPath, "utf-8"));
}
function memory(): Record<string, unknown> {
  return read().memory as Record<string, unknown>;
}

beforeEach(() => {
  workspaceDir = mkdtempSync(join(tmpdir(), "copy-v2-tunables-"));
  configPath = join(workspaceDir, "config.json");
});
afterEach(() => {
  rmSync(workspaceDir, { recursive: true, force: true });
});

describe("162-copy-memory-v2-tunables-to-substrate", () => {
  test("has the expected id", () => {
    expect(MIG.id).toBe("162-copy-memory-v2-tunables-to-substrate");
  });

  test("no-ops without a memory.v2 subtree", () => {
    write({ memory: { substrate: { bm25_b: 0.3 } } });
    const before = readFileSync(configPath, "utf-8");

    MIG.run(workspaceDir);

    expect(readFileSync(configPath, "utf-8")).toBe(before);
  });

  test("copies every present v2 tunable, including values equal to shipped defaults", () => {
    write({
      memory: {
        v2: {
          enabled: true,
          sweep_enabled: false,
          dense_weight: 0.85,
          sparse_weight: 0.15,
          bm25_b: 0.75,
          consolidation_interval_hours: 8,
          consolidation_max_buffer_lines: null,
          k: 0.5,
          hops: 2,
          ann_candidate_limit: null,
        },
      },
    });

    MIG.run(workspaceDir);

    expect(memory().substrate).toEqual({
      sweep_enabled: false,
      dense_weight: 0.85,
      sparse_weight: 0.15,
      bm25_b: 0.75,
      consolidation_interval_hours: 8,
      consolidation_max_buffer_lines: null,
      spread_k: 0.5,
      spread_hops: 2,
      ann_candidate_limit: null,
    });
    // memory.v2 is left untouched; the current schema simply ignores it.
    expect(memory().v2).toMatchObject({ bm25_b: 0.75, k: 0.5, hops: 2 });
  });

  test("preserves the effective tuning after the schema drops memory.v2", () => {
    write({
      memory: {
        v2: {
          bm25_b: 0.75,
          consolidation_interval_hours: 6,
          max_page_chars: 9000,
          k: 0.4,
          hops: 3,
        },
      },
    });

    MIG.run(workspaceDir);

    const tuning = resolveSubstrateTuning(MemoryConfigSchema.parse(memory()));
    expect(tuning.bm25_b).toBe(0.75);
    expect(tuning.consolidation_interval_hours).toBe(6);
    expect(tuning.max_page_chars).toBe(9000);
    expect(tuning.spread_k).toBe(0.4);
    expect(tuning.spread_hops).toBe(3);
  });

  test("never clobbers an existing substrate key", () => {
    write({
      memory: {
        v2: { bm25_b: 0.6, max_page_chars: 9000 },
        substrate: { bm25_b: 0.3 },
      },
    });

    MIG.run(workspaceDir);

    expect(memory().substrate).toEqual({ bm25_b: 0.3, max_page_chars: 9000 });
  });

  test("is idempotent", () => {
    write({ memory: { v2: { bm25_b: 0.75 } } });

    MIG.run(workspaceDir);
    const once = readFileSync(configPath, "utf-8");
    MIG.run(workspaceDir);

    expect(readFileSync(configPath, "utf-8")).toBe(once);
  });

  test("leaves malformed JSON untouched", () => {
    writeFileSync(configPath, "{not json");

    MIG.run(workspaceDir);

    expect(readFileSync(configPath, "utf-8")).toBe("{not json");
  });
});
