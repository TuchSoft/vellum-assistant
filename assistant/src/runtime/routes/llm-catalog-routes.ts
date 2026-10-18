/**
 * GET /v1/llm/catalog — the gateway alias catalog.
 *
 * Reads the cached gateway catalog and refreshes it when the cache is stale.
 * Clients use this to populate alias pickers and to read capabilities without
 * hardcoding model ids.
 */

import { z } from "zod";

import {
  getCatalogSnapshot,
  refreshCatalog,
} from "../../config/llm-catalog.js";
import { ACTOR_PRINCIPALS } from "../auth/route-policy.js";
import type { RouteDefinition } from "./types.js";

const catalogEntrySchema = z.object({
  alias: z.string(),
  label: z.string(),
  maxInputTokens: z.number().optional(),
  maxOutputTokens: z.number().optional(),
  supportsVision: z.boolean(),
  supportsTools: z.boolean(),
  supportsReasoning: z.boolean().optional(),
  mode: z.enum([
    "chat",
    "embedding",
    "audio_transcription",
    "audio_speech",
    "image_generation",
  ]),
});

const catalogResponseSchema = z.object({
  models: z.array(catalogEntrySchema),
  source: z.enum(["gateway", "disk", "fallback"]),
  fetchedAt: z.number(),
});

async function handleGetCatalog() {
  await refreshCatalog();
  const snapshot = getCatalogSnapshot();
  return {
    models: snapshot.entries,
    source: snapshot.source,
    fetchedAt: snapshot.fetchedAt,
  };
}

export const ROUTES: RouteDefinition[] = [
  {
    operationId: "llm_catalog_get",
    method: "GET",
    policy: {
      requiredScopes: ["settings.read"],
      allowedPrincipalTypes: ACTOR_PRINCIPALS,
    },
    endpoint: "llm/catalog",
    handler: handleGetCatalog,
    summary: "Get the gateway model catalog",
    description:
      "Returns the aliases the LLM gateway advertises, with context windows, capabilities and mode. The catalog is cached in memory and on disk; a stale cache is refreshed in the background before the response is built.",
    tags: ["config", "inference"],
    responseBody: catalogResponseSchema,
  },
];
