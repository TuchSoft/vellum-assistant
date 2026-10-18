import { describe, expect, test } from "bun:test";

import { memoryTier } from "./memory-tier.js";
import {
  isMemoryEnabled,
  isMemoryV1Active,
  isMemoryV3Live,
  isSkillImprovementActive,
  isV3TierActive,
  usesConceptPageMemory,
} from "./memory-v3-gate.js";
import type { AssistantConfig } from "./schema.js";

describe("usesConceptPageMemory", () => {
  test("tracks the memory master switch", () => {
    expect(usesConceptPageMemory({ enabled: false })).toBe(false);
    expect(usesConceptPageMemory({ enabled: true })).toBe(true);
    expect(usesConceptPageMemory({})).toBe(true);
  });

  test("treats missing config as memory on (schema default)", () => {
    expect(usesConceptPageMemory(undefined)).toBe(true);
  });
});

type TriState = boolean | undefined;

function makeConfig(
  enabled: TriState,
  v3Live: TriState,
  skillImprovement?: boolean,
): AssistantConfig {
  return {
    memory: {
      ...(enabled === undefined ? {} : { enabled }),
      ...(v3Live === undefined ? {} : { v3: { live: v3Live } }),
      ...(skillImprovement === undefined
        ? {}
        : { retrospective: { skillImprovement } }),
    },
  } as AssistantConfig;
}

describe("tier predicate truth table", () => {
  // Rows: [enabled, v3.live] → expected
  // [isMemoryEnabled, isMemoryV1Active, isV3TierActive].
  // undefined = key unset.
  const rows: Array<{
    inputs: [TriState, TriState];
    expected: [boolean, boolean, boolean];
  }> = [
    { inputs: [undefined, undefined], expected: [true, false, false] },
    { inputs: [undefined, true], expected: [true, false, true] },
    { inputs: [undefined, false], expected: [true, false, false] },
    { inputs: [true, undefined], expected: [true, false, false] },
    { inputs: [true, true], expected: [true, false, true] },
    { inputs: [true, false], expected: [true, false, false] },
    { inputs: [false, undefined], expected: [false, false, false] },
    { inputs: [false, true], expected: [false, false, false] },
    { inputs: [false, false], expected: [false, false, false] },
  ];

  const show = (v: TriState) => (v === undefined ? "unset" : String(v));

  for (const { inputs, expected } of rows) {
    const [enabled, v3Live] = inputs;
    const [expEnabled, expV1, expV3Tier] = expected;
    test(`enabled=${show(enabled)} v3.live=${show(v3Live)}`, () => {
      const config = makeConfig(enabled, v3Live);
      expect(isMemoryEnabled(config)).toBe(expEnabled);
      // The concept-page substrate is active whenever memory is on, so v1 is
      // never the live tier.
      expect(isMemoryV1Active(config)).toBe(expV1);
      expect(isV3TierActive(config)).toBe(expV3Tier);
      // The predicates and memoryTier() share one implementation; assert every
      // tier bucket agrees with the predicates on every combination.
      expect(isMemoryEnabled(config)).toBe(memoryTier(config) !== "off");
      expect(memoryTier(config)).not.toBe("v2");
      expect(isV3TierActive(config)).toBe(memoryTier(config) === "v3");
      expect(isV3TierActive(config)).toBe(
        isMemoryV3Live(config) && isMemoryEnabled(config),
      );
    });
  }

  test("empty config: memory on, no v3 tier", () => {
    const config = {} as AssistantConfig;
    expect(isMemoryEnabled(config)).toBe(true);
    expect(isMemoryV1Active(config)).toBe(false);
    expect(isV3TierActive(config)).toBe(false);
    expect(memoryTier(config)).toBe("v1");
  });
});

describe("skill improvement gate", () => {
  test("defaults on for a live v3 tier", () => {
    expect(isSkillImprovementActive(makeConfig(true, true))).toBe(true);
    expect(isSkillImprovementActive(makeConfig(undefined, true))).toBe(true);
  });

  test("explicit opt-out disables skill improvement without disabling v3", () => {
    const config = makeConfig(true, true, false);

    expect(isV3TierActive(config)).toBe(true);
    expect(isSkillImprovementActive(config)).toBe(false);
  });

  test("requires the live v3 tier even when explicitly enabled", () => {
    expect(isSkillImprovementActive(makeConfig(true, false, true))).toBe(false);
    expect(isSkillImprovementActive(makeConfig(false, true, true))).toBe(false);
  });
});

describe("v3 tier is one condition", () => {
  test("memory off suppresses the v3 tier even with memory.v3.live set", () => {
    const config = makeConfig(false, true);
    // The raw key is still set — only the tier predicate accounts for the
    // opt-out, which is why feature gates must not read `isMemoryV3Live`.
    expect(isMemoryV3Live(config)).toBe(true);
    expect(isV3TierActive(config)).toBe(false);
  });

  test("v3 live with memory on is the v3 tier", () => {
    expect(isV3TierActive(makeConfig(true, true))).toBe(true);
    expect(isV3TierActive(makeConfig(undefined, true))).toBe(true);
  });

  test("false when v3 is not live, and on an empty config", () => {
    expect(isV3TierActive(makeConfig(undefined, false))).toBe(false);
    expect(isV3TierActive({} as AssistantConfig)).toBe(false);
  });
});
