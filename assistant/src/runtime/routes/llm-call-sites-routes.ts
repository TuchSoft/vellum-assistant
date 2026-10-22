import { z } from "zod";

import {
  knownAliases,
  resolveCallSiteOutcome,
  shippedCallSiteModel,
} from "../../config/llm-resolver.js";
import { loadConfig, loadRawConfig } from "../../config/loader.js";
import {
  CALL_SITE_CATALOG,
  CALL_SITE_DOMAINS,
} from "../../config/schemas/call-site-catalog.js";
import {
  type LLMCallSite,
  LLMCallSiteEnum,
  type LLMConfig,
  LLMSchema,
} from "../../config/schemas/llm.js";
import { ACTOR_PRINCIPALS } from "../auth/route-policy.js";
import { commitConfigWrite } from "./conversation-query-routes.js";
import { BadRequestError } from "./errors.js";
import type { RouteDefinition, RouteHandlerArgs } from "./types.js";

const callSiteDomainSchema = z.object({
  id: z.string(),
  displayName: z.string(),
});

const degradationReasonSchema = z.enum([
  "call_site_alias_missing",
  "catalog_empty",
]);

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
  /** The workspace pin, or null when the call site inherits. */
  configuredModel: z.string().nullable(),
  /** The alias that will actually be sent, or null when disabled. */
  effectiveModel: z.string().nullable(),
  /** True when the configured alias is missing and a fallback won. */
  degraded: z.boolean(),
  /** Why the configured alias could not be used; null when not degraded. */
  reason: degradationReasonSchema.nullable(),
});

const callSiteCatalogResponseSchema = z.object({
  domains: z.array(callSiteDomainSchema),
  callSites: z.array(callSiteEntrySchema),
  /** Whether the gateway catalog currently knows any alias at all. */
  catalogAvailable: z.boolean(),
});

const callSiteUpdateSchema = z
  .object({
    /** Gateway alias, or null to inherit the default. */
    model: z.string().min(1).nullable().optional(),
    enabled: z.boolean().optional(),
  })
  .strict()
  .refine((value) => value.model !== undefined || value.enabled !== undefined, {
    message: "At least one of `model` or `enabled` is required",
  });

export type CallSiteUpdate = z.infer<typeof callSiteUpdateSchema>;

export function buildCallSiteCatalog(llm: LLMConfig) {
  return CALL_SITE_CATALOG.map((entry) => {
    const id = entry.id as LLMCallSite;
    const outcome = resolveCallSiteOutcome(id, llm);
    const shipped = shippedCallSiteModel(id);
    return {
      ...entry,
      enabled: outcome.enabled,
      configuredModel: outcome.configuredModel,
      effectiveModel: outcome.effectiveModel,
      degraded: outcome.degraded,
      reason: outcome.reason,
      ...(outcome.effectiveModel != null
        ? { model: outcome.effectiveModel }
        : {}),
      ...(outcome.source !== "disabled" ? { source: outcome.source } : {}),
      ...(shipped != null ? { shippedModel: shipped } : {}),
    };
  });
}

function catalogResponse(llm: LLMConfig) {
  return {
    domains: CALL_SITE_DOMAINS,
    callSites: buildCallSiteCatalog(llm),
    catalogAvailable: knownAliases(llm).length > 0,
  };
}

async function handleGetCallSites() {
  return catalogResponse(loadConfig().llm);
}

/**
 * Validate and apply a call-site patch to a raw config object in place.
 *
 * Kept separate from the handler so the rules can be exercised without
 * touching the workspace config or reinitializing providers. The write is
 * deliberately strict about unknown aliases: an alias that is not in the
 * catalog today would degrade on the next request, so a deliberate write is
 * rejected with the available list instead of silently accepted. Degradation
 * covers aliases that disappear after the fact, not typos at write time.
 */
export function applyCallSitePatch(params: {
  raw: Record<string, unknown>;
  site: LLMCallSite;
  patch: CallSiteUpdate;
  availableAliases: readonly string[];
}): void {
  const { raw, site, patch, availableAliases } = params;

  const rawLlm =
    raw.llm != null && typeof raw.llm === "object" && !Array.isArray(raw.llm)
      ? (raw.llm as Record<string, unknown>)
      : {};
  const rawCallSites =
    rawLlm.callSites != null &&
    typeof rawLlm.callSites === "object" &&
    !Array.isArray(rawLlm.callSites)
      ? (rawLlm.callSites as Record<string, unknown>)
      : {};
  const current =
    rawCallSites[site] != null &&
    typeof rawCallSites[site] === "object" &&
    !Array.isArray(rawCallSites[site])
      ? { ...(rawCallSites[site] as Record<string, unknown>) }
      : {};

  if (
    patch.model != null &&
    availableAliases.length > 0 &&
    !availableAliases.includes(patch.model)
  ) {
    throw new BadRequestError(
      `Unknown gateway alias "${patch.model}". Available aliases: ${availableAliases.join(", ")}.`,
    );
  }

  if (patch.model !== undefined) {
    if (patch.model === null) {
      delete current.model;
    } else {
      current.model = patch.model;
    }
  }
  if (patch.enabled !== undefined) {
    current.enabled = patch.enabled;
  }

  const nextCallSites = { ...rawCallSites };
  if (Object.keys(current).length === 0) {
    delete nextCallSites[site];
  } else {
    nextCallSites[site] = current;
  }
  const nextLlm = { ...rawLlm, callSites: nextCallSites };
  // Validate only the call-site constraints, so an unrelated stale field in
  // the workspace config cannot block an edit to this one.
  const validated = LLMSchema.safeParse({ callSites: nextCallSites });
  if (!validated.success) {
    const issue = validated.error.issues[0];
    throw new BadRequestError(
      issue?.message ?? "Invalid LLM call-site configuration",
    );
  }

  raw.llm = nextLlm;
}

async function handleUpdateCallSite({
  pathParams = {},
  body,
}: RouteHandlerArgs) {
  const parsedSite = LLMCallSiteEnum.safeParse((pathParams.site ?? "").trim());
  if (!parsedSite.success) {
    throw new BadRequestError(
      `Unknown call site "${pathParams.site ?? ""}". Valid call sites: ${LLMCallSiteEnum.options.join(", ")}.`,
    );
  }

  const parsedPatch = callSiteUpdateSchema.safeParse(body ?? {});
  if (!parsedPatch.success) {
    throw new BadRequestError(parsedPatch.error.message);
  }

  const raw = loadRawConfig();
  applyCallSitePatch({
    raw,
    site: parsedSite.data,
    patch: parsedPatch.data,
    availableAliases: knownAliases(loadConfig().llm),
  });

  await commitConfigWrite(raw, "update call site");
  return catalogResponse(loadConfig().llm);
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
      "Returns the full catalog of LLM call sites with display names, descriptions, domain groupings, the configured alias, the effective alias and whether resolution had to degrade because the configured alias is missing from the gateway catalog. Used by clients to render the per-call-site alias settings UI.",
    tags: ["config"],
    responseBody: callSiteCatalogResponseSchema,
  },
  {
    operationId: "llm_call_sites_update",
    method: "PATCH",
    policy: {
      requiredScopes: ["settings.write"],
      allowedPrincipalTypes: ACTOR_PRINCIPALS,
    },
    endpoint: "config/llm/call-sites/:site",
    handler: handleUpdateCallSite,
    summary: "Update an LLM call site",
    description:
      "Set a call site's gateway alias (`model`, or null to inherit) and whether it is enabled. The alias must be present in the gateway catalog. Returns the refreshed call-site catalog.",
    tags: ["config"],
    pathParams: [
      { name: "site", description: "LLM call-site id", type: "string" },
    ],
    requestBody: callSiteUpdateSchema,
    responseBody: callSiteCatalogResponseSchema,
    additionalResponses: {
      "400": {
        description:
          "Unknown call site, unknown alias, or a combination the LLM schema rejects",
      },
    },
  },
];
