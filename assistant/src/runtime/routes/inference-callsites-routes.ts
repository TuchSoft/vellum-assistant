/**
 * Route definitions for read-only call-site resolution inspection.
 *
 * GET /v1/inference/callsites        — effective resolution for every call site
 * GET /v1/inference/callsites/:site  — resolution detail + chain for one site
 *
 * These expose what `resolveCallSite` computes so the assistant can inspect
 * which alias wins each call site without reading raw `llm.callSites.*`
 * config paths.
 */

import { z } from "zod";

import { CALL_SITE_DEFAULTS } from "../../config/call-site-defaults.js";
import {
  type ResolutionFallbackReason,
  resolveCallSite,
} from "../../config/llm-resolver.js";
import { getConfigReadOnly } from "../../config/loader.js";
import { type LLMCallSite, LLMCallSiteEnum } from "../../config/schemas/llm.js";
import {
  ConnectionResolutionError,
  preflightResolvedConfig,
} from "../../providers/connection-resolution.js";
import { resolveGatewayConnectionName } from "../../providers/gateway.js";
import { ACTOR_PRINCIPALS } from "../auth/route-policy.js";
import { BadRequestError } from "./errors.js";
import type { RouteDefinition, RouteHandlerArgs } from "./types.js";

const sourceEnum = z.enum([
  "pinned",
  "call_site",
  "chat",
  "default",
  "disabled",
]);

const callSiteSummarySchema = z
  .object({
    callSite: z.string(),
    model: z.string().nullable(),
    source: sourceEnum,
    /** Notable tuning: the resolved context-window input cap, when set. */
    maxInputTokens: z.number().optional(),
  })
  .meta({ id: "CallSiteResolutionSummary" });

const resolutionChainEntrySchema = z.object({
  requested: z.string(),
  reason: z.enum(["unknown_alias"]),
});

const callSiteDetailSchema = z
  .object({
    callSite: z.string(),
    winner: z.object({
      model: z.string().nullable(),
      source: sourceEnum,
    }),
    resolved: z
      .object({
        model: z.string(),
        maxInputTokens: z.number(),
        disableCache: z.boolean(),
      })
      .nullable(),
    /** Rungs the resolver considered and skipped, oldest-first. */
    resolutionChain: z.array(resolutionChainEntrySchema),
    /** The shipped default fragment for this call site (code-owned). */
    shippedDefault: z.record(z.string(), z.unknown()),
    /** The user's call-site override fragment, if any. */
    userPin: z.record(z.string(), z.unknown()).nullable(),
    /** Present when the preflight can statically prove dispatch would fail. */
    resolutionError: z
      .object({ reason: z.string(), message: z.string() })
      .optional(),
  })
  .meta({ id: "CallSiteResolutionDetail" });

function summarizeCallSite(
  callSite: LLMCallSite,
  llm: Parameters<typeof resolveCallSite>[1],
) {
  const resolution = resolveCallSite(callSite, llm, {});
  if (resolution.status === "disabled") {
    return { callSite, model: null, source: "disabled" as const };
  }
  const maxInputTokens = resolution.config.contextWindow.maxInputTokens;
  return {
    callSite,
    model: resolution.model,
    source: resolution.source,
    ...(typeof maxInputTokens === "number" ? { maxInputTokens } : {}),
  };
}

function handleListCallSites() {
  const llm = getConfigReadOnly().llm;
  const callSites = LLMCallSiteEnum.options.map((callSite) =>
    summarizeCallSite(callSite, llm),
  );
  return { callSites };
}

async function handleGetCallSite({ pathParams = {} }: RouteHandlerArgs) {
  const site = (pathParams.site ?? "").trim();
  const parsedSite = LLMCallSiteEnum.safeParse(site);
  if (!parsedSite.success) {
    throw new BadRequestError(
      `Unknown call site "${site}". Valid call sites: ${LLMCallSiteEnum.options.join(", ")}.`,
    );
  }
  const callSite = parsedSite.data;
  const llm = getConfigReadOnly().llm;

  const resolutionChain: {
    requested: string;
    reason: ResolutionFallbackReason;
  }[] = [];
  const resolution = resolveCallSite(callSite, llm, {
    onResolutionFallback: ({ requested, reason }) => {
      resolutionChain.push({ requested, reason });
    },
  });

  let resolutionError: { reason: string; message: string } | undefined;
  const connectionName = resolveGatewayConnectionName();
  if (resolution.status === "ok" && connectionName != null) {
    try {
      await preflightResolvedConfig({
        connectionName,
        model: resolution.model,
      });
    } catch (err) {
      if (err instanceof ConnectionResolutionError) {
        resolutionError = { reason: err.reason, message: err.message };
      } else {
        throw err;
      }
    }
  }

  return {
    callSite,
    winner: {
      model: resolution.status === "ok" ? resolution.model : null,
      source:
        resolution.status === "ok" ? resolution.source : ("disabled" as const),
    },
    resolved:
      resolution.status === "ok"
        ? {
            model: resolution.model,
            maxInputTokens: resolution.config.contextWindow.maxInputTokens,
            disableCache: resolution.config.disableCache,
          }
        : null,
    resolutionChain,
    shippedDefault: CALL_SITE_DEFAULTS[callSite] as Record<string, unknown>,
    userPin: (llm.callSites?.[callSite] ?? null) as Record<
      string,
      unknown
    > | null,
    ...(resolutionError ? { resolutionError } : {}),
  };
}

export const ROUTES: RouteDefinition[] = [
  {
    operationId: "inference_callsites_list",
    endpoint: "inference/callsites",
    method: "GET",
    policy: {
      requiredScopes: ["settings.read"],
      allowedPrincipalTypes: ACTOR_PRINCIPALS,
    },
    summary: "List call-site resolutions",
    description:
      "Return the effective alias for every LLM call site, its source rung, and the resolved input budget.",
    tags: ["inference"],
    responseBody: z.object({ callSites: z.array(callSiteSummarySchema) }),
    handler: handleListCallSites,
  },
  {
    operationId: "inference_callsites_get",
    endpoint: "inference/callsites/:site",
    method: "GET",
    policy: {
      requiredScopes: ["settings.read"],
      allowedPrincipalTypes: ACTOR_PRINCIPALS,
    },
    summary: "Get a call-site resolution detail",
    description:
      "Return the full resolution for one call site: the winner, the resolution chain, the shipped default fragment, the user's pin, and a preflight-derived error when dispatch would provably fail.",
    tags: ["inference"],
    pathParams: [{ name: "site", description: "LLM call-site id" }],
    responseBody: callSiteDetailSchema,
    additionalResponses: { "400": { description: "Unknown call site" } },
    handler: handleGetCallSite,
  },
];
