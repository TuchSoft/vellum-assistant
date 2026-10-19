/**
 * Route definition for one-shot inference (LLM send).
 *
 * POST /v1/inference/send — send a user message to the configured LLM and
 *                           return the model response.
 */

import { z } from "zod";

import { resolveCallSite } from "../../config/llm-resolver.js";
import { getConfigReadOnly } from "../../config/loader.js";
import {
  extractAllText,
  getConfiguredProvider,
  userMessage,
} from "../../providers/provider-send-message.js";
import type { ProviderRequestDiagnostics } from "../../providers/request-diagnostics.js";
import { runWithProviderRequestDiagnostics } from "../../providers/request-diagnostics.js";
import { LOCAL_PRINCIPALS } from "../auth/route-policy.js";
import { BadRequestError, UpstreamProviderError } from "./errors.js";
import type { RouteDefinition, RouteHandlerArgs } from "./types.js";

// ---------------------------------------------------------------------------
// Handler
// ---------------------------------------------------------------------------

async function handleInferenceSend({ body = {} }: RouteHandlerArgs) {
  const message = body.message;
  if (typeof message !== "string" || !message.trim()) {
    throw new BadRequestError("message must be a non-empty string");
  }

  const systemPrompt = body.systemPrompt as string | undefined;
  const model = body.model as string | undefined;
  const maxTokens = body.maxTokens as number | undefined;

  if (model !== undefined) {
    try {
      resolveCallSite("inference", getConfigReadOnly().llm, { model });
    } catch (err) {
      throw new BadRequestError(
        err instanceof Error ? err.message : String(err),
      );
    }
  }

  // Diagnostics are collected around the send, not inside it, so the failure
  // path carries the same evidence as the success path: a probe of a broken
  // profile must report the URL that was actually requested and the verbatim
  // upstream body, rather than only the message the SDK managed to extract.
  // Provider resolution runs inside the same scope because that is where the
  // connection backing the request is chosen.
  const attempt = await runWithProviderRequestDiagnostics(async () => {
    const provider = await getConfiguredProvider("inference", {
      ...(model !== undefined ? { model } : {}),
    });
    if (!provider) {
      throw new BadRequestError(
        "No LLM gateway connection is configured. Add an openai-compatible connection for the gateway.",
      );
    }
    return provider.sendMessage([userMessage(message)], {
      systemPrompt,
      config: {
        callSite: "inference",
        max_tokens: maxTokens,
        ...(model !== undefined ? { model } : {}),
      },
    });
  });

  if (!attempt.ok) {
    throw upstreamFailure(attempt.error, attempt.diagnostics);
  }

  const response = attempt.value;
  const text = extractAllText(response);

  return {
    response: text,
    model: response.model,
    usage: {
      inputTokens: response.usage.inputTokens,
      outputTokens: response.usage.outputTokens,
    },
    // Runtime-observed diagnostics. `resolved_endpoint` is the base URL the
    // provider's live HTTP client actually targeted for this request, so a
    // caller can confirm routing from evidence instead of inferring it. The
    // provider adapter is the shared cached instance other call sites reuse for
    // the same connection/provider/model, so this reflects the endpoint those
    // call sites resolve to for the requested profile — not a config re-read.
    // A caller comparing against a different profile should not assume a match.
    // Omitted when the provider does not surface an endpoint.
    ...evidencePayload(response.resolvedEndpoint, attempt.diagnostics),
  };
}

/**
 * Merge the endpoint the provider adapter reports with the per-request
 * diagnostics observed on the wire, omitting the key entirely when nothing was
 * observed so consumers can distinguish "no evidence" from "empty evidence".
 */
function evidencePayload(
  resolvedEndpoint: string | undefined,
  diagnostics: ProviderRequestDiagnostics,
): { evidence?: Record<string, unknown> } {
  const evidence = {
    ...(resolvedEndpoint !== undefined
      ? { resolved_endpoint: resolvedEndpoint }
      : {}),
    ...diagnostics,
  };
  return Object.keys(evidence).length > 0 ? { evidence } : {};
}

/**
 * Wrap a failed send so the evidence survives the error path. `RouteError`
 * details are mirrored into the HTTP error envelope and the IPC response, so
 * the CLI (and Doctor through it) sees the same fields a successful probe
 * returns.
 */
function upstreamFailure(
  error: unknown,
  diagnostics: ProviderRequestDiagnostics,
): Error {
  if (error instanceof BadRequestError) {
    return error;
  }
  const message = error instanceof Error ? error.message : String(error);
  return new UpstreamProviderError(message, {
    error_class: error instanceof Error ? error.name : "UnknownError",
    ...(error instanceof Error && error.stack
      ? { error_stack_head: error.stack.split("\n").slice(0, 5).join("\n") }
      : {}),
    evidence: evidencePayload(undefined, diagnostics).evidence ?? {},
  });
}

// ---------------------------------------------------------------------------
// Route definition
// ---------------------------------------------------------------------------

export const ROUTES: RouteDefinition[] = [
  {
    operationId: "inference_send",
    endpoint: "inference/send",
    method: "POST",
    policy: {
      requiredScopes: ["chat.write"],
      allowedPrincipalTypes: LOCAL_PRINCIPALS,
    },
    summary: "Send a message to the configured LLM",
    description:
      "Send a user message to the configured LLM provider and return the model response. " +
      "Optionally specify a system prompt, model alias, or max tokens.",
    tags: ["inference"],
    requestBody: z.object({
      message: z.string().min(1),
      systemPrompt: z.string().optional(),
      model: z.string().optional(),
      maxTokens: z.number().int().positive().optional(),
    }),
    responseBody: z.object({
      response: z.string(),
      model: z.string(),
      usage: z.object({
        inputTokens: z.number(),
        outputTokens: z.number(),
      }),
      evidence: z
        .object({
          resolved_endpoint: z.string().optional(),
          resolved_url: z.string().optional(),
          model_id: z.string().optional(),
          connection_name: z.string().optional(),
          http_status: z.number().optional(),
          upstream_error_body: z.string().optional(),
          upstream_error_body_state: z
            .enum(["captured", "empty", "truncated", "unavailable"])
            .optional(),
          upstream_error_body_bytes: z.number().optional(),
        })
        .optional(),
    }),
    handler: handleInferenceSend,
  },
];
