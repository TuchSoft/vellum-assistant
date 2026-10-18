// ---------------------------------------------------------------------------
// Memory substrate — Config tuning resolver
// ---------------------------------------------------------------------------

import type { MemoryConfig } from "../../../../config/types.js";

/**
 * Effective substrate tunables. Key names match the `memory.substrate` schema;
 * `spread_k` / `spread_hops` are the substrate names for the spreading
 * activation knobs.
 */
export type SubstrateTuning = {
  sweep_enabled: boolean;
  dense_weight: number;
  sparse_weight: number;
  min_sparse_spread: number | undefined;
  full_sparse_spread: number | undefined;
  bm25_k1: number;
  bm25_b: number;
  consolidation_interval_hours: number;
  consolidation_max_buffer_lines: number | null;
  consolidation_max_entries_per_run: number | null;
  max_page_chars: number;
  consolidation_prompt_path: string | null;
  spread_k: number;
  spread_hops: number;
  ann_candidate_limit: number | null;
};

/**
 * Single choke point for substrate tunables. The schema supplies the shipped
 * defaults, so a parsed config carries every value.
 */
export function resolveSubstrateTuning(memory: MemoryConfig): SubstrateTuning {
  const substrate = memory.substrate;
  return {
    sweep_enabled: substrate.sweep_enabled,
    dense_weight: substrate.dense_weight,
    sparse_weight: substrate.sparse_weight,
    min_sparse_spread: substrate.min_sparse_spread,
    full_sparse_spread: substrate.full_sparse_spread,
    bm25_k1: substrate.bm25_k1,
    bm25_b: substrate.bm25_b,
    consolidation_interval_hours: substrate.consolidation_interval_hours,
    consolidation_max_buffer_lines: substrate.consolidation_max_buffer_lines,
    consolidation_max_entries_per_run:
      substrate.consolidation_max_entries_per_run,
    max_page_chars: substrate.max_page_chars,
    consolidation_prompt_path: substrate.consolidation_prompt_path,
    spread_k: substrate.spread_k,
    spread_hops: substrate.spread_hops,
    ann_candidate_limit: substrate.ann_candidate_limit,
  };
}
