/**
 * Gateway embedding backend.
 *
 * The LLM gateway (LiteLLM) is the single transport for every inference call,
 * embeddings included: this backend reuses the same connection row and the same
 * `resolveAuth` path the chat uses, so one credential serves every modality and
 * there is no embedding-specific key or credential slot.
 */

import {
  LLM_GATEWAY_URL_ENV,
  resolveGatewayEndpoint,
} from "../../config/llm-catalog.js";
import { resolveGatewayConnectionName } from "../../providers/gateway.js";
import { peekConnection } from "../../providers/inference/connections.js";
import {
  type EmbeddingBackend,
  type EmbeddingInput,
  type EmbeddingRequestOptions,
  normalizeEmbeddingInput,
} from "./embedding-types.js";

interface GatewayEmbeddingsResponse {
  data?: Array<{ embedding: number[] }>;
}

export interface GatewayEmbeddingTarget {
  baseUrl: string;
  headers: Record<string, string>;
  model: string;
  dimensions?: number;
}

export type GatewayEmbeddingResolution =
  | { ok: true; target: GatewayEmbeddingTarget }
  | { ok: false; error: string };

/** Trim and strip trailing slashes from a gateway base URL. */
export function trimGatewayBaseUrl(value: string): string {
  return value.trim().replace(/\/+$/, "");
}

/**
 * Resolve the gateway connection into the URL, headers and alias an embedding
 * request needs. Delegates to {@link resolveGatewayEndpoint}, the same helper
 * the model-catalog fetch uses, so embeddings cannot drift from chat.
 */
export async function resolveGatewayEmbeddingTarget(
  model: string,
  dimensions?: number,
): Promise<GatewayEmbeddingResolution> {
  const trimmedModel = model.trim();
  if (!trimmedModel) {
    return {
      ok: false,
      error: "memory.embeddings.gatewayModel must name a gateway alias",
    };
  }

  const endpoint = await resolveGatewayEndpoint();
  if (!endpoint) {
    return {
      ok: false,
      error:
        'Embedding backend "gateway" requires an LLM gateway connection with auth (name "llm-gateway", or an "openai-compatible" connection with a base URL)',
    };
  }

  const baseUrl = trimGatewayBaseUrl(endpoint.baseUrl);
  if (!baseUrl) {
    return {
      ok: false,
      error: 'Embedding backend "gateway" resolved an empty gateway base URL',
    };
  }

  return {
    ok: true,
    target: {
      baseUrl,
      headers: endpoint.headers,
      model: trimmedModel,
      ...(dimensions != null ? { dimensions } : {}),
    },
  };
}

/** Cache-key fragments for a resolved gateway target. */
export function gatewayTargetCacheExtras(target: {
  baseUrl: string;
  dimensions?: number;
}): string[] {
  const extras = [`url=${target.baseUrl}`];
  if (target.dimensions != null) {
    extras.push(`dim=${target.dimensions}`);
  }
  return extras;
}

/**
 * Synchronous cache-identity fragments for the durable embedding cache, where
 * the caller cannot await connection resolution. Reads the connection snapshot
 * (warmed at boot) with the env URL as the same override the resolver uses.
 */
export function gatewayDurableCacheExtras(config: {
  memory: { embeddings: { gatewayDimensions?: number } };
}): string[] {
  const extras: string[] = [];
  const baseUrl = gatewayBaseUrlFromSnapshot();
  if (baseUrl) {
    extras.push(`url=${baseUrl}`);
  }
  const dimensions = config.memory.embeddings.gatewayDimensions;
  if (dimensions != null) {
    extras.push(`dim=${dimensions}`);
  }
  return extras;
}

function gatewayBaseUrlFromSnapshot(): string | null {
  const envUrl = process.env[LLM_GATEWAY_URL_ENV]?.trim();
  if (envUrl) {
    return trimGatewayBaseUrl(envUrl);
  }
  const connectionName = resolveGatewayConnectionName();
  const connection =
    connectionName != null ? peekConnection(connectionName) : undefined;
  const baseUrl = connection?.baseUrl;
  return baseUrl ? trimGatewayBaseUrl(baseUrl) : null;
}

export class GatewayEmbeddingBackend implements EmbeddingBackend {
  readonly provider = "gateway" as const;
  readonly model: string;
  readonly baseUrl: string;
  readonly dimensions?: number;
  private readonly headers: Record<string, string>;

  constructor(target: GatewayEmbeddingTarget) {
    this.model = target.model;
    this.baseUrl = target.baseUrl;
    this.dimensions = target.dimensions;
    this.headers = target.headers;
  }

  async embed(
    inputs: EmbeddingInput[],
    options?: EmbeddingRequestOptions,
  ): Promise<number[][]> {
    if (inputs.length === 0) {
      return [];
    }

    const texts = inputs.map((input) => {
      const normalized = normalizeEmbeddingInput(input);
      if (normalized.type !== "text") {
        throw new Error("Gateway embedding backend only supports text inputs");
      }
      return normalized.text;
    });

    const response = await fetch(`${this.baseUrl}/embeddings`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        ...this.headers,
      },
      body: JSON.stringify({
        model: this.model,
        input: texts,
        ...(this.dimensions != null ? { dimensions: this.dimensions } : {}),
      }),
      signal: options?.signal,
    });
    if (!response.ok) {
      const body = await response.text();
      throw new Error(
        `Gateway embeddings request failed (${response.status}): ${body}`,
      );
    }
    const payload = (await response.json()) as GatewayEmbeddingsResponse;
    if (!Array.isArray(payload.data)) {
      throw new Error("Gateway embeddings response missing vectors");
    }
    return payload.data.map((item) => item.embedding);
  }
}
