import { resolveCallSite } from "./llm-resolver.js";
import { effectiveCatalogEntry } from "./llm-resolver.js";
import {
  type ContextWindow,
  DEFAULT_CONTEXT_WINDOW_MAX_INPUT_TOKENS,
  type LLMCallSite,
  type LLMConfig,
} from "./schemas/llm.js";
import type { ContextWindowConfig } from "./types.js";

export interface EffectiveContextWindow {
  provider: string;
  model: string;
  enabled: boolean;
  maxInputTokens: number;
  modelMaxInputTokens: number;
  defaultInputTokens: number;
  compactThreshold: number;
  summaryBudgetRatio: number;
  targetBudgetRatio: number;
  overflowRecovery: ContextWindow["overflowRecovery"];
  isLongContextEnabled: boolean;
  maxOutputTokens?: number;
}

/**
 * Resolve the input budget for a call site.
 *
 * Precedence, high to low:
 *   1. an explicit `contextWindow.maxInputTokens` on the call site,
 *   2. the alias's `maxInputTokens` in the gateway catalog,
 *   3. the code-owned conservative default (200k) when the catalog has no
 *      window for the alias.
 *
 * The catalog is the only source of model capabilities: an alias that
 * advertises a 1M window gets a 1M budget unless the call site deliberately
 * caps it lower (or higher).
 *
 * Returns null for a disabled call site: nothing downstream should build a
 * request for it.
 */
export function resolveEffectiveContextWindow({
  llm,
  callSite,
  model,
  conversationModel,
}: {
  llm: LLMConfig;
  callSite: LLMCallSite;
  /** Explicit alias pin, same semantics as the resolver's `model`. */
  model?: string;
  /** Interactive conversation selection. */
  conversationModel?: string;
}): EffectiveContextWindow | null {
  const resolution = resolveCallSite(callSite, llm, {
    model,
    conversationModel,
  });
  if (resolution.status === "disabled") {
    return null;
  }
  const resolved = resolution.config;
  const catalogEntry = effectiveCatalogEntry(llm, resolved.model);
  const modelMaxInputTokens =
    catalogEntry?.maxInputTokens ?? DEFAULT_CONTEXT_WINDOW_MAX_INPUT_TOKENS;
  // The alias window is the budget when the call site does not pin one. The
  // conservative default only applies when the catalog knows nothing about
  // the alias.
  const maxInputTokens =
    resolved.contextWindow.maxInputTokens ?? modelMaxInputTokens;

  return {
    provider: "llm-gateway",
    model: resolved.model,
    enabled: resolved.contextWindow.enabled,
    maxInputTokens,
    modelMaxInputTokens,
    defaultInputTokens: modelMaxInputTokens,
    compactThreshold: resolved.contextWindow.compactThreshold,
    summaryBudgetRatio: resolved.contextWindow.summaryBudgetRatio,
    targetBudgetRatio: resolved.contextWindow.targetBudgetRatio,
    overflowRecovery: resolved.contextWindow.overflowRecovery,
    isLongContextEnabled: maxInputTokens > modelMaxInputTokens,
    ...(catalogEntry?.maxOutputTokens != null
      ? { maxOutputTokens: catalogEntry.maxOutputTokens }
      : {}),
  };
}

export function contextWindowConfigFromEffective(
  base: ContextWindow,
  effective: EffectiveContextWindow,
): ContextWindowConfig {
  return {
    ...base,
    enabled: effective.enabled,
    maxInputTokens: effective.maxInputTokens,
    targetBudgetRatio: effective.targetBudgetRatio,
    compactThreshold: effective.compactThreshold,
    summaryBudgetRatio: effective.summaryBudgetRatio,
    overflowRecovery: effective.overflowRecovery,
  };
}
