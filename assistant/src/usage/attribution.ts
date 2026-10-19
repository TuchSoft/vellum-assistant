import {
  resolveCallSite,
  resolveCallSiteConfig,
} from "../config/llm-resolver.js";
import { getConfig } from "../config/loader.js";
import type { LLMCallSite } from "../config/schemas/llm.js";
import { safeStringSlice } from "../util/unicode.js";

const MAX_METADATA_VALUE_LENGTH = 128;

export type UsageModelSource =
  | "pinned"
  | "call_site"
  | "chat"
  | "default"
  | "unknown";

export interface UsageAttributionInput {
  callSite: LLMCallSite | null;
  /**
   * Call site used to resolve the model. Defaults to {@link callSite}.
   * Compaction invokes the provider as `mainAgent` (prefix cache) but tags
   * the usage row as `compactionAgent`; pass `mainAgent` here so the
   * attribution matches the request that ran.
   */
  modelResolutionCallSite?: LLMCallSite | null;
  /** Explicit alias pin for this request. */
  model?: string | null;
  /** Interactive conversation selection. */
  conversationModel?: string | null;
}

export interface UsageAttributionSnapshot {
  callSite: LLMCallSite | null;
  /** The alias the request ran on. */
  model: string | null;
  modelSource: UsageModelSource;
  resolvedProvider: string;
  resolvedModel: string;
}

/**
 * The nullable attribution columns shared by telemetry events
 * (`tool_invocations` rows, `skill_loaded` outbox payloads).
 */
export interface UsageAttributionColumns {
  provider: string | null;
  model: string | null;
  modelSource: UsageModelSource | null;
}

/**
 * Maps an attribution snapshot to the shared telemetry columns. Accepts a
 * missing snapshot so producers that resolve attribution best-effort can pass
 * it through as-is.
 */
export function toAttributionColumns(
  snapshot: UsageAttributionSnapshot | null | undefined,
): UsageAttributionColumns {
  return {
    provider: snapshot?.resolvedProvider ?? null,
    model: snapshot?.resolvedModel ?? null,
    modelSource: snapshot?.modelSource ?? null,
  };
}

/** Sanitizes values before they are copied into external metadata surfaces. */
export function sanitizeUsageMetadataValue(value: unknown): string | null {
  if (typeof value !== "string") {
    return null;
  }
  const trimmed = value.trim();
  if (trimmed.length === 0) {
    return null;
  }
  if (containsControlCharacter(trimmed)) {
    return null;
  }
  return safeStringSlice(trimmed, 0, MAX_METADATA_VALUE_LENGTH);
}

export function resolveUsageAttribution(
  input: UsageAttributionInput,
): UsageAttributionSnapshot {
  const llm = getConfig().llm;
  const callSite = input.callSite;
  const resolutionCallSite = input.modelResolutionCallSite ?? callSite;
  const model = normalizeModel(input.model);
  const conversationModel = normalizeModel(input.conversationModel);

  try {
    if (resolutionCallSite == null) {
      const resolved = resolveCallSiteConfig("mainAgent", llm, {
        ...(conversationModel != null ? { conversationModel } : {}),
      });
      return {
        callSite: null,
        model: resolved.model,
        modelSource: "unknown",
        resolvedProvider: "llm-gateway",
        resolvedModel: resolved.model,
      };
    }

    const resolution = resolveCallSite(resolutionCallSite, llm, {
      ...(model != null ? { model } : {}),
      ...(conversationModel != null ? { conversationModel } : {}),
    });
    if (resolution.status === "disabled") {
      return {
        callSite,
        model: null,
        modelSource: "unknown",
        resolvedProvider: "llm-gateway",
        resolvedModel: "",
      };
    }
    return {
      callSite,
      model: resolution.model,
      modelSource: resolution.source,
      resolvedProvider: "llm-gateway",
      resolvedModel: resolution.model,
    };
  } catch {
    return {
      callSite,
      model: model ?? conversationModel ?? null,
      modelSource: "unknown",
      resolvedProvider: "llm-gateway",
      resolvedModel: model ?? conversationModel ?? "",
    };
  }
}

function normalizeModel(value: string | null | undefined): string | null {
  const trimmed = value?.trim();
  return trimmed != null && trimmed.length > 0 ? trimmed : null;
}

function containsControlCharacter(value: string): boolean {
  for (let i = 0; i < value.length; i++) {
    const code = value.charCodeAt(i);
    if (code < 0x20 || (code >= 0x7f && code <= 0x9f)) {
      return true;
    }
  }
  return false;
}
