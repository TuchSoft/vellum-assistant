import { existsSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { getLogger } from "../../util/logger.js";
import type { WorkspaceMigration } from "./types.js";

const log = getLogger("workspace-migration-162");

/**
 * The substrate tunables carried over from the retired `memory.v2` namespace,
 * paired with their `memory.substrate` names. `k` / `hops` were renamed to
 * `spread_k` / `spread_hops`; every other key kept its name.
 */
const SUBSTRATE_KEY_PAIRS: ReadonlyArray<{
  v2Key: string;
  substrateKey: string;
}> = [
  { v2Key: "sweep_enabled", substrateKey: "sweep_enabled" },
  { v2Key: "dense_weight", substrateKey: "dense_weight" },
  { v2Key: "sparse_weight", substrateKey: "sparse_weight" },
  { v2Key: "min_sparse_spread", substrateKey: "min_sparse_spread" },
  { v2Key: "full_sparse_spread", substrateKey: "full_sparse_spread" },
  { v2Key: "bm25_k1", substrateKey: "bm25_k1" },
  { v2Key: "bm25_b", substrateKey: "bm25_b" },
  {
    v2Key: "consolidation_interval_hours",
    substrateKey: "consolidation_interval_hours",
  },
  {
    v2Key: "consolidation_max_buffer_lines",
    substrateKey: "consolidation_max_buffer_lines",
  },
  {
    v2Key: "consolidation_max_entries_per_run",
    substrateKey: "consolidation_max_entries_per_run",
  },
  { v2Key: "max_page_chars", substrateKey: "max_page_chars" },
  {
    v2Key: "consolidation_prompt_path",
    substrateKey: "consolidation_prompt_path",
  },
  { v2Key: "k", substrateKey: "spread_k" },
  { v2Key: "hops", substrateKey: "spread_hops" },
  { v2Key: "ann_candidate_limit", substrateKey: "ann_candidate_limit" },
];

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return value != null && typeof value === "object" && !Array.isArray(value);
}

/**
 * Copy every `memory.v2` substrate tunable into its `memory.substrate` twin
 * wherever the substrate key is absent.
 *
 * `memory.substrate` is now the only substrate config surface; the old
 * resolver fallback to `memory.v2` is gone. Migration 135 copied non-default
 * values, which left two gaps that would silently retune on upgrade: a
 * persisted value equal to a shipped default (including the retired
 * `bm25_b: 0.75`), and any value on a workspace where 135 had not run yet.
 * This sweep is value-blind on purpose: it copies every present `memory.v2`
 * key that is absent under `memory.substrate`, so the resolved effective value
 * after the upgrade equals the value before it.
 *
 * Idempotent: an already-present substrate key is never clobbered, and no
 * write happens when nothing copies. `memory.v2` is left untouched (it is
 * simply ignored by the current schema).
 */
export const copyMemoryV2TunablesToSubstrateMigration: WorkspaceMigration = {
  id: "162-copy-memory-v2-tunables-to-substrate",
  description:
    "Copy every memory.v2 substrate tunable into memory.substrate where absent, so removing the v2 fallback never retunes an assistant",
  retryFailedCheckpoint: true,

  run(workspaceDir: string): void {
    const configPath = join(workspaceDir, "config.json");
    if (!existsSync(configPath)) {
      return;
    }

    // A filesystem read failure propagates so the failed checkpoint retries on
    // the next boot; only malformed JSON is a permanent no-op.
    const rawText = readFileSync(configPath, "utf-8");
    let config: Record<string, unknown>;
    try {
      const raw = JSON.parse(rawText);
      if (!isPlainObject(raw)) {
        return;
      }
      config = raw;
    } catch {
      return;
    }

    const memory = config.memory;
    if (!isPlainObject(memory)) {
      return;
    }
    const v2 = memory.v2;
    if (!isPlainObject(v2)) {
      return;
    }
    // A malformed (non-object) persisted memory.substrate is left alone — the
    // config loader surfaces that error; this migration must not clobber it.
    if (memory.substrate !== undefined && !isPlainObject(memory.substrate)) {
      return;
    }

    const substrate: Record<string, unknown> = isPlainObject(memory.substrate)
      ? memory.substrate
      : {};

    let copied = false;
    for (const { v2Key, substrateKey } of SUBSTRATE_KEY_PAIRS) {
      if (!(v2Key in v2) || substrateKey in substrate) {
        continue;
      }
      substrate[substrateKey] = v2[v2Key];
      copied = true;
    }
    if (!copied) {
      return;
    }
    memory.substrate = substrate;

    // Write-then-rename keeps the migration rerunnable: a crash mid-write must
    // not leave a truncated config.json that a retry reads as malformed and
    // "completes" past.
    const tmpPath = `${configPath}.tmp`;
    writeFileSync(tmpPath, JSON.stringify(config, null, 2) + "\n");
    renameSync(tmpPath, configPath);
    log.info(
      "Copied memory.v2 substrate tunables to memory.substrate before the v2 fallback removal",
    );
  },

  down(_workspaceDir: string): void {
    // Forward-only: a copied value is indistinguishable from one the user set
    // under memory.substrate directly, so removal could destroy deliberate
    // overrides. The copy is also behavior-preserving.
  },
};
