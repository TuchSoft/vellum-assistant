import { afterEach, beforeEach, describe, expect, test } from "bun:test";

import {
  __setCatalogSnapshotForTests,
  type CatalogSnapshot,
} from "../llm-catalog.js";
import {
  contextWindowConfigFromEffective,
  resolveEffectiveContextWindow,
} from "../llm-context-resolution.js";
import { __resetDegradationLogForTests } from "../llm-resolver.js";
import {
  ContextWindowSchema,
  DEFAULT_CONTEXT_WINDOW_MAX_INPUT_TOKENS,
  type LLMConfig,
  LLMSchema,
} from "../schemas/llm.js";

const MILLION = 1_050_000;

const catalog: CatalogSnapshot = {
  fetchedAt: 1,
  source: "gateway",
  entries: [
    {
      alias: "main",
      label: "Main",
      maxInputTokens: MILLION,
      maxOutputTokens: 64000,
      supportsVision: false,
      supportsTools: true,
      mode: "chat",
    },
    {
      alias: "fast",
      label: "Fast",
      maxInputTokens: 32_000,
      maxOutputTokens: 16_000,
      supportsVision: false,
      supportsTools: true,
      mode: "chat",
    },
  ],
};

beforeEach(() => {
  __setCatalogSnapshotForTests(catalog);
  __resetDegradationLogForTests();
});

afterEach(() => {
  __setCatalogSnapshotForTests(undefined);
});

const llm = (input: unknown = {}): LLMConfig => LLMSchema.parse(input);

describe("resolveEffectiveContextWindow budget precedence", () => {
  test("uses the catalog window when the call site pins no cap", () => {
    const effective = resolveEffectiveContextWindow({
      llm: llm(),
      callSite: "mainAgent",
    });
    expect(effective?.maxInputTokens).toBe(MILLION);
  });

  test("an explicit call-site cap wins over the catalog window", () => {
    const effective = resolveEffectiveContextWindow({
      llm: llm({
        callSites: {
          mainAgent: { contextWindow: { maxInputTokens: 100_000 } },
        },
      }),
      callSite: "mainAgent",
    });
    expect(effective?.maxInputTokens).toBe(100_000);
  });

  test("the shipped call-site cap applies when the workspace declares none", () => {
    // memoryRouter ships a 1M cap in code; the catalog only knows 32k for the
    // `fast` alias it resolves to.
    const effective = resolveEffectiveContextWindow({
      llm: llm({ callSites: { memoryRouter: { model: "fast" } } }),
      callSite: "memoryRouter",
    });
    expect(effective?.maxInputTokens).toBe(1_000_000);
  });

  test("falls back to the conservative default when the catalog has no entry", () => {
    __setCatalogSnapshotForTests({
      entries: [],
      fetchedAt: 1,
      source: "gateway",
    });
    const effective = resolveEffectiveContextWindow({
      llm: llm(),
      callSite: "mainAgent",
    });
    expect(effective?.maxInputTokens).toBe(
      DEFAULT_CONTEXT_WINDOW_MAX_INPUT_TOKENS,
    );
  });

  test("a degraded alias budgets the alias that actually runs", () => {
    const effective = resolveEffectiveContextWindow({
      llm: llm({
        defaultModel: "fast",
        callSites: { conversationTitle: { model: "missing-alias" } },
      }),
      callSite: "conversationTitle",
    });
    expect(effective?.model).toBe("fast");
    expect(effective?.maxInputTokens).toBe(32_000);
  });

  test("a disabled call site resolves to null", () => {
    expect(
      resolveEffectiveContextWindow({
        llm: llm(),
        callSite: "replySuggestion",
      }),
    ).toBeNull();
  });
});

describe("contextWindowConfigFromEffective", () => {
  test("materializes the effective budget into the compaction config", () => {
    const effective = resolveEffectiveContextWindow({
      llm: llm(),
      callSite: "mainAgent",
    });
    if (effective == null) {
      throw new Error("mainAgent must resolve");
    }
    const config = contextWindowConfigFromEffective(
      ContextWindowSchema.parse({}),
      effective,
    );
    expect(config.maxInputTokens).toBe(MILLION);
  });
});
