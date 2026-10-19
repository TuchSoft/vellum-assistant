import { resolveEffectiveContextWindow } from "../config/llm-context-resolution.js";
import type { ResolveCallSiteOpts } from "../config/llm-resolver.js";
import { getConfig } from "../config/loader.js";
import type { LLMCallSite } from "../config/schemas/llm.js";

export interface EffectiveContextWindowInfo {
  provider: string;
  model: string;
  maxInputTokens: number;
}

export type EffectiveContextWindowOptions = Pick<
  ResolveCallSiteOpts,
  "model" | "conversationModel"
>;

/**
 * Resolve the alias and effective input limit for one configured call site.
 * Throws when the call site is disabled: a disabled site has no context window
 * to size a request against.
 */
export function getEffectiveContextWindow(
  callSite: LLMCallSite,
  options: EffectiveContextWindowOptions = {},
): EffectiveContextWindowInfo {
  const resolved = resolveEffectiveContextWindow({
    llm: getConfig().llm,
    callSite,
    ...options,
  });
  if (resolved == null) {
    throw new Error(`Call site "${callSite}" is disabled.`);
  }
  return {
    provider: resolved.provider,
    model: resolved.model,
    maxInputTokens: resolved.maxInputTokens,
  };
}
