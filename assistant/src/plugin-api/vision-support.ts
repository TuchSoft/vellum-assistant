/**
 * Vision-support resolution for plugin consumption.
 *
 * A plugin that gates image processing on vision capability (e.g. an
 * image-to-text fallback for text-only models) calls {@link doesSupportVision}
 * instead of hardcoding model names. Inputs may be a {@link ModelInfo}, a
 * gateway alias, or a fully resolved target.
 *
 * Resolution returns `false` when nothing resolves (rather than failing open):
 * a consumer gating an image to text fallback wants an unknown model treated
 * as "cannot show images" over silently shipping a raw image to a provider
 * that may reject it.
 */

import { effectiveCatalogEntry } from "../config/llm-resolver.js";
import { getConfig } from "../config/loader.js";
import type { ModelInfo } from "./types.js";

/** A fully resolved target: the alias and its capability policy. */
export interface ResolvedVisionTarget {
  readonly model: string;
  readonly inputModalities?: {
    readonly image?: boolean | "supported" | "unsupported";
  } | null;
}

/** Whether the given alias or model descriptor can process image input. */
export function doesSupportVision(
  modelOrInfo: ModelInfo | ResolvedVisionTarget | string,
): boolean {
  if (typeof modelOrInfo === "string") {
    return catalogVision(modelOrInfo) ?? false;
  }
  if ("alias" in modelOrInfo) {
    return modelOrInfo.supportsVision;
  }
  if (modelOrInfo.inputModalities?.image === true) {
    return true;
  }
  return catalogVision(modelOrInfo.model) ?? false;
}

function catalogVision(alias: string): boolean | undefined {
  const entry = effectiveCatalogEntry(getConfig().llm, alias);
  return entry?.supportsVision;
}
