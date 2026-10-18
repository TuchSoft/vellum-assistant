/**
 * Coverage for the `memory.substrate` schema and its tuning resolver. The
 * substrate is the only concept-page tuning surface: every field carries a
 * shipped default, so a parsed config always yields a complete tuning object.
 */

import { describe, expect, test } from "bun:test";

import { MemoryConfigSchema } from "../config/schemas/memory.js";
import { MemorySubstrateConfigSchema } from "../config/schemas/memory-substrate.js";
import { resolveSubstrateTuning } from "../plugins/defaults/memory/substrate/tuning.js";

const DEFAULTS = MemorySubstrateConfigSchema.parse({});

describe("memory.substrate schema", () => {
  test("shipped defaults", () => {
    expect(DEFAULTS).toEqual({
      sweep_enabled: false,
      dense_weight: 0.85,
      sparse_weight: 0.15,
      min_sparse_spread: undefined,
      full_sparse_spread: undefined,
      bm25_k1: 1.2,
      bm25_b: 0.4,
      consolidation_interval_hours: 8,
      consolidation_max_buffer_lines: 100,
      consolidation_max_entries_per_run: 150,
      max_page_chars: 5000,
      consolidation_prompt_path: null,
      spread_k: 0.5,
      spread_hops: 2,
      ann_candidate_limit: null,
    });
  });

  test("explicit values override the defaults", () => {
    const parsed = MemorySubstrateConfigSchema.parse({
      consolidation_interval_hours: 3,
      bm25_k1: 1.5,
      spread_k: 0.7,
      spread_hops: 4,
      ann_candidate_limit: 500,
    });

    expect(parsed.consolidation_interval_hours).toBe(3);
    expect(parsed.bm25_k1).toBe(1.5);
    expect(parsed.spread_k).toBe(0.7);
    expect(parsed.spread_hops).toBe(4);
    expect(parsed.ann_candidate_limit).toBe(500);
  });

  test("supports an explicit null on nullable keys", () => {
    const parsed = MemorySubstrateConfigSchema.parse({
      consolidation_max_buffer_lines: null,
      consolidation_max_entries_per_run: null,
      consolidation_prompt_path: null,
      ann_candidate_limit: null,
    });

    expect(parsed.consolidation_max_buffer_lines).toBeNull();
    expect(parsed.consolidation_max_entries_per_run).toBeNull();
    expect(parsed.consolidation_prompt_path).toBeNull();
    expect(parsed.ann_candidate_limit).toBeNull();
  });

  test("rejects hybrid weights that do not sum to 1.0", () => {
    expect(
      MemorySubstrateConfigSchema.safeParse({
        dense_weight: 0.9,
        sparse_weight: 0.15,
      }).success,
    ).toBe(false);
    expect(
      MemorySubstrateConfigSchema.safeParse({
        dense_weight: 0.7,
        sparse_weight: 0.3,
      }).success,
    ).toBe(true);
  });

  test("rejects out-of-range values", () => {
    expect(() =>
      MemorySubstrateConfigSchema.parse({ spread_hops: 1.5 }),
    ).toThrow();
    expect(() =>
      MemorySubstrateConfigSchema.parse({ consolidation_interval_hours: 0 }),
    ).toThrow();
    expect(() =>
      MemorySubstrateConfigSchema.parse({ max_page_chars: 0 }),
    ).toThrow();
  });
});

describe("memory.v2 is gone from the schema", () => {
  test("parsing a config carrying memory.v2 drops the unknown key", () => {
    const parsed = MemoryConfigSchema.parse({
      v2: { enabled: true, bm25_b: 0.75 },
      substrate: { bm25_b: 0.75 },
    });

    expect("v2" in parsed).toBe(false);
    expect(parsed.substrate.bm25_b).toBe(0.75);
  });

  test("an empty memory block parses to the substrate defaults", () => {
    const parsed = MemoryConfigSchema.parse({});
    expect(parsed.substrate).toEqual(DEFAULTS);
  });
});

describe("resolveSubstrateTuning", () => {
  test("resolves every field from memory.substrate", () => {
    const config = MemoryConfigSchema.parse({});
    expect(resolveSubstrateTuning(config)).toMatchObject(DEFAULTS);
  });

  test("honors explicit overrides", () => {
    const config = MemoryConfigSchema.parse({
      substrate: { bm25_b: 0.75, sweep_enabled: true },
    });
    const tuning = resolveSubstrateTuning(config);

    expect(tuning.bm25_b).toBe(0.75);
    expect(tuning.sweep_enabled).toBe(true);
  });

  test("an explicit null wins over the default", () => {
    const config = MemoryConfigSchema.parse({
      substrate: { consolidation_max_buffer_lines: null },
    });
    expect(
      resolveSubstrateTuning(config).consolidation_max_buffer_lines,
    ).toBeNull();
  });
});
