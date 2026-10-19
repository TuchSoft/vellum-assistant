/**
 * Handler tests for the `inference_send` route's runtime-observed evidence.
 *
 * The route surfaces `evidence.resolved_endpoint` so callers (e.g. Doctor's
 * `probe_symptom`) can confirm the endpoint the inference client actually
 * resolved to. The field is threaded straight from
 * `ProviderResponse.resolvedEndpoint` and must be omitted — not guessed —
 * when the provider does not surface one.
 */

import { beforeEach, describe, expect, mock, test } from "bun:test";

import { LLMSchema } from "../../../config/schemas/llm.js";
import type { ConfiguredProviderOptions } from "../../../providers/provider-send-message.js";
import type {
  ProviderResponse,
  SendMessageOptions,
} from "../../../providers/types.js";

// ---------------------------------------------------------------------------
// Mock: the handler resolves a provider and sends one message. We stub the
// provider layer so no real LLM call is made and the returned
// ProviderResponse (including resolvedEndpoint) is fully controlled.
// ---------------------------------------------------------------------------

let nextResponse: ProviderResponse;
let sendMessageImpl: (() => Promise<ProviderResponse>) | undefined;
// Connection the stubbed resolution reports, mirroring the real resolver:
// the connection is chosen while resolving the provider, not while sending.
let resolutionConnectionName: string | undefined;

mock.module("../../../providers/provider-send-message.js", () => ({
  getConfiguredProvider: async (
    _callSite: string,
    _options: ConfiguredProviderOptions,
  ) => {
    if (resolutionConnectionName) {
      recordProviderRequestDiagnostics({
        connection_name: resolutionConnectionName,
      });
    }
    return {
      name: "stub",
      sendMessage: async (_messages: unknown, _options: SendMessageOptions) => {
        return sendMessageImpl ? sendMessageImpl() : nextResponse;
      },
    };
  },
  extractAllText: (response: ProviderResponse) =>
    response.content.map((b) => (b.type === "text" ? b.text : "")).join(""),
  userMessage: (text: string) => ({
    role: "user",
    content: [{ type: "text", text }],
  }),
}));

// The route reads `llm` for the profile checks only; drive it from the test so
// a case can present an unusable profile without touching the workspace config.
let configuredLlm = LLMSchema.parse({});
mock.module("../../../config/loader.js", () => ({
  getConfigReadOnly: () => ({ llm: configuredLlm }),
  getConfig: () => ({ llm: configuredLlm }),
}));

const { ROUTES } = await import("../inference-send-routes.js");
const { UpstreamProviderError } = await import("../errors.js");
const { recordProviderRequestDiagnostics } =
  await import("../../../providers/request-diagnostics.js");

function inferenceSendHandler() {
  const route = ROUTES.find((r) => r.operationId === "inference_send");
  if (!route) {
    throw new Error("inference_send route not registered");
  }
  return route.handler;
}

function baseResponse(overrides: Partial<ProviderResponse>): ProviderResponse {
  return {
    content: [{ type: "text", text: "hello" }],
    model: "test-model",
    usage: { inputTokens: 1, outputTokens: 2 },
    stopReason: "stop",
    ...overrides,
  };
}

beforeEach(() => {
  configuredLlm = LLMSchema.parse({});
  nextResponse = baseResponse({});
  sendMessageImpl = undefined;
  resolutionConnectionName = undefined;
});

describe("inference_send evidence", () => {
  test("surfaces resolved_endpoint observed from the provider response", async () => {
    // GIVEN a provider whose runtime response reports the resolved endpoint
    nextResponse = baseResponse({
      resolvedEndpoint: "https://inference.example.test/v1",
    });

    // WHEN the inference_send handler processes a request
    const result = (await inferenceSendHandler()({
      body: { message: "hi" },
    })) as {
      response: string;
      model: string;
      evidence?: { resolved_endpoint?: string };
    };

    // THEN the response echoes the model text
    expect(result.response).toBe("hello");

    // AND the observed endpoint is exposed under evidence.resolved_endpoint
    expect(result.evidence).toEqual({
      resolved_endpoint: "https://inference.example.test/v1",
    });
  });

  test("surfaces the connection recorded while the provider is resolved", async () => {
    /**
     * Tests that diagnostics recorded during provider resolution reach the
     * evidence payload. The connection backing the request is chosen while
     * resolving the provider, so resolution has to run inside the diagnostics
     * scope or "which key was this?" goes unanswered on every probe.
     */

    // GIVEN resolution picks a named connection for the request
    resolutionConnectionName = "gemini-personal";

    // WHEN the inference_send handler processes a request
    const result = (await inferenceSendHandler()({
      body: { message: "hi" },
    })) as { evidence?: { connection_name?: string } };

    // THEN the evidence names the connection that authenticated the send
    expect(result.evidence?.connection_name).toBe("gemini-personal");
  });

  test("omits evidence entirely when the provider surfaces no endpoint", async () => {
    // GIVEN a provider whose runtime response carries no resolvedEndpoint
    nextResponse = baseResponse({ resolvedEndpoint: undefined });

    // WHEN the inference_send handler processes a request
    const result = (await inferenceSendHandler()({
      body: { message: "hi" },
    })) as { evidence?: { resolved_endpoint?: string } };

    // THEN no evidence object is fabricated — the endpoint stays unknown
    expect(result.evidence).toBeUndefined();
  });

  test("reports the outbound request and verbatim upstream body when the send fails", async () => {
    // GIVEN a provider call that reaches the upstream and fails there
    sendMessageImpl = async () => {
      recordProviderRequestDiagnostics({
        resolved_url:
          "https://generativelanguage.googleapis.com/v1beta/models/gemini-3-pro:streamGenerateContent?key=REDACTED",
        model_id: "gemini-3-pro",
        connection_name: "gemini-personal",
        http_status: 404,
        upstream_error_body: '{"error":{"code":404}}',
        upstream_error_body_state: "captured",
        upstream_error_body_bytes: 22,
      });
      throw new Error("Gemini API error (404): Not Found");
    };

    // WHEN the inference_send handler processes a request
    const error = await Promise.resolve(
      inferenceSendHandler()({ body: { message: "hi" } }),
    ).then(
      () => new Error("expected the request to fail"),
      (err: unknown) => err,
    );

    // THEN the failure carries the evidence needed to diagnose it
    expect(error).toBeInstanceOf(UpstreamProviderError);
    expect(
      (error as InstanceType<typeof UpstreamProviderError>).details,
    ).toEqual({
      error_class: "Error",
      error_stack_head: expect.any(String),
      evidence: {
        resolved_url:
          "https://generativelanguage.googleapis.com/v1beta/models/gemini-3-pro:streamGenerateContent?key=REDACTED",
        model_id: "gemini-3-pro",
        connection_name: "gemini-personal",
        http_status: 404,
        upstream_error_body: '{"error":{"code":404}}',
        upstream_error_body_state: "captured",
        upstream_error_body_bytes: 22,
      },
    });
  });
});

// ---------------------------------------------------------------------------
// Existence in `llm.profiles` is weaker than usability: the resolver also
// requires the entry to be enabled and to carry its own provider + model, and
// silently falls through to this call site's `cost-optimized` default when it
// does not. The route must reject rather than answer from that other model.
// ---------------------------------------------------------------------------
