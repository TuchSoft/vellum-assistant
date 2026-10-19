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
 * The budget is the smaller of the call site's configured cap and the alias's
 * catalog window. The call-site schema defaults the cap to 200k, so a catalog
 * entry that overstates a provider limit (LiteLLM estimates large windows for
 * families it does not know) cannot by itself inflate the prompt budget.
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
  const defaultInputTokens = Math.min(
    modelMaxInputTokens,
    DEFAULT_CONTEXT_WINDOW_MAX_INPUT_TOKENS,
  );
  const maxInputTokens = Math.min(
    resolved.contextWindow.maxInputTokens,
    modelMaxInputTokens,
  );

  return {
    provider: "llm-gateway",
    model: resolved.model,
    enabled: resolved.contextWindow.enabled,
    maxInputTokens,
    modelMaxInputTokens,
    defaultInputTokens,
    compactThreshold: resolved.contextWindow.compactThreshold,
    summaryBudgetRatio: resolved.contextWindow.summaryBudgetRatio,
    targetBudgetRatio: resolved.contextWindow.targetBudgetRatio,
    overflowRecovery: resolved.contextWindow.overflowRecovery,
    isLongContextEnabled: maxInputTokens > defaultInputTokens,
    ...(catalogEntry?.maxOutputTokens != null
      ? { maxOutputTokens: catalogEntry.maxOutputTokens }
      : {}),
  };
}

export function contextWindowConfigFromEffective(
  base: ContextWindowConfig,
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
