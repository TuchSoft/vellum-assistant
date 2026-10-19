import {
  LLM_GATEWAY_CONNECTION_NAME,
  LLM_GATEWAY_URL_ENV,
} from "../config/llm-catalog.js";
import { resolveCallSite } from "../config/llm-resolver.js";
import { getConfig } from "../config/loader.js";
import type { LLMConfig } from "../config/schemas/llm.js";
import type { ProviderConnection } from "./inference/auth.js";
import { listSnapshotConnections } from "./inference/connections.js";

export { LLM_GATEWAY_CONNECTION_NAME, LLM_GATEWAY_URL_ENV };

/** Provider kind the gateway connection dispatches through. */
export const LLM_GATEWAY_PROVIDER = "openai-compatible";

/**
 * The connection row that carries the LLM gateway's URL and credential.
 *
 * Selection order:
 *   1. an `openai-compatible` row whose `models` list declares the model the
 *      chat resolves for the main agent — the same connection chat dispatches
 *      through, so embeddings and chat cannot diverge;
 *   2. the canonical `llm-gateway` row;
 *   3. the first `openai-compatible` row with a base URL.
 *
 * Shared by {@link resolveGatewayConnectionName} (dispatch and cache identity)
 * and the model-catalog/embedding endpoint resolver, so both always agree.
 */
export function selectGatewayConnection(
  connections: readonly ProviderConnection[],
  model: string | null | undefined,
): ProviderConnection | null {
  const preferredModel = model?.trim();
  if (preferredModel) {
    const declaresModel = connections.find(
      (connection) =>
        connection.provider === LLM_GATEWAY_PROVIDER &&
        connection.baseUrl != null &&
        connection.models?.some((entry) => entry.id === preferredModel),
    );
    if (declaresModel != null) {
      return declaresModel;
    }
  }
  const canonical = connections.find(
    (connection) => connection.name === LLM_GATEWAY_CONNECTION_NAME,
  );
  if (canonical != null) {
    return canonical;
  }
  return (
    connections.find(
      (connection) =>
        connection.provider === LLM_GATEWAY_PROVIDER &&
        connection.baseUrl != null,
    ) ?? null
  );
}

/**
 * The connection row that carries the LLM gateway's URL and credential.
 *
 * Uses {@link selectGatewayConnection} with the model the chat resolves for
 * the main agent. The snapshot is cold before boot warms it, in which case
 * callers fall back to the env-only path (or return null).
 */
export function resolveGatewayConnectionName(): string | null {
  return (
    selectGatewayConnection(listSnapshotConnections(), gatewayModelFromConfig())
      ?.name ?? null
  );
}

/**
 * The chat's main-agent model, or undefined when the config cannot be read or
 * the alias is unknown. Callers fall back to the canonical/first-row rungs
 * rather than failing gateway resolution.
 */
function gatewayModelFromConfig(): string | undefined {
  try {
    return resolveGatewayModel(getConfig().llm);
  } catch {
    return undefined;
  }
}

/** The model the main agent resolves to, for adapter construction. */
export function resolveGatewayModel(llm: LLMConfig): string {
  const resolution = resolveCallSite("mainAgent", llm);
  return resolution.status === "ok" ? resolution.model : llm.defaultModel;
}
