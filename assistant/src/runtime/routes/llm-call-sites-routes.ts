import { z } from "zod";

import {
  isCallSiteDisabled,
  resolveEffectiveModel,
  shippedCallSiteModel,
} from "../../config/llm-resolver.js";
import { loadConfig } from "../../config/loader.js";
import {
  CALL_SITE_CATALOG,
  CALL_SITE_DOMAINS,
} from "../../config/schemas/call-site-catalog.js";
import type { LLMCallSite, LLMConfig } from "../../config/schemas/llm.js";
import { ACTOR_PRINCIPALS } from "../auth/route-policy.js";
import type { RouteDefinition } from "./types.js";

const callSiteDomainSchema = z.object({
  id: z.string(),
  displayName: z.string(),
});

const callSiteEntrySchema = z.object({
  id: z.string(),
  displayName: z.string(),
  description: z.string(),
  domain: z.string(),
  /** The alias the call site resolves to, absent when it is disabled. */
  model: z.string().optional(),
  /** The ladder rung that supplied the alias. */
  source: z.string().optional(),
  /** The code-owned alias default, independent of workspace pins. */
  shippedModel: z.string().optional(),
  /** Whether the call site is disabled. */
  enabled: z.boolean(),
});

const callSiteCatalogResponseSchema = z.object({
  domains: z.array(callSiteDomainSchema),
  callSites: z.array(callSiteEntrySchema),
});

export function buildCallSiteCatalog(llm: LLMConfig) {
  return CALL_SITE_CATALOG.map((entry) => {
    const id = entry.id as LLMCallSite;
    const effective = resolveEffectiveModel(id, llm);
    return {
      ...entry,
      enabled: !isCallSiteDisabled(id, llm),
      ...(effective != null ? { model: effective.model } : {}),
      ...(effective != null ? { source: effective.source } : {}),
      ...(shippedCallSiteModel(id) != null
        ? { shippedModel: shippedCallSiteModel(id) }
        : {}),
    };
  });
}

async function handleGetCallSites() {
  const { llm } = loadConfig();
  return {
    domains: CALL_SITE_DOMAINS,
    callSites: buildCallSiteCatalog(llm),
  };
}

export const ROUTES: RouteDefinition[] = [
  {
    operationId: "llm_call_sites_list",
    method: "GET",
    policy: {
      requiredScopes: ["settings.read"],
      allowedPrincipalTypes: ACTOR_PRINCIPALS,
    },
    endpoint: "config/llm/call-sites",
    handler: handleGetCallSites,
    summary: "List LLM call sites",
    description:
      "Returns the full catalog of LLM call sites with display names, descriptions, and domain groupings. Used by clients to render the per-call-site alias settings UI.",
    tags: ["config"],
    responseBody: callSiteCatalogResponseSchema,
  },
];
