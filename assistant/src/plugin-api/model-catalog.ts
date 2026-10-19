import { listCatalogEntries } from "../config/llm-catalog.js";
import { effectiveCatalogEntry } from "../config/llm-resolver.js";
import { getConfig } from "../config/loader.js";
import type { ModelInfo } from "./types.js";

/**
 * List the gateway aliases a plugin can route to.
 *
 * Reads the live in-memory config and catalog, so the result reflects the
 * current alias set and default each time it is called. Only chat aliases are
 * returned: embeddings and speech modes are not conversation targets.
 */
export function getModelCatalog(): ModelInfo[] {
  const { llm } = getConfig();
  return listCatalogEntries("chat").map((entry) => {
    const effective = effectiveCatalogEntry(llm, entry.alias);
    return {
      alias: entry.alias,
      label: entry.label,
      ...(effective?.maxInputTokens != null
        ? { maxInputTokens: effective.maxInputTokens }
        : {}),
      ...(effective?.maxOutputTokens != null
        ? { maxOutputTokens: effective.maxOutputTokens }
        : {}),
      supportsVision: effective?.supportsVision ?? false,
      supportsTools: effective?.supportsTools ?? false,
      isDefault: entry.alias === llm.defaultModel,
    };
  });
}
