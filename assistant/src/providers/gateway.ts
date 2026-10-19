import {
  LLM_GATEWAY_CONNECTION_NAME,
  LLM_GATEWAY_URL_ENV,
} from "../config/llm-catalog.js";
import { resolveCallSite } from "../config/llm-resolver.js";
import type { LLMConfig } from "../config/schemas/llm.js";
import { listSnapshotConnections } from "./inference/connections.js";

export { LLM_GATEWAY_CONNECTION_NAME, LLM_GATEWAY_URL_ENV };

/** Provider kind the gateway connection dispatches through. */
export const LLM_GATEWAY_PROVIDER = "openai-compatible";

/**
 * The connection row that carries the LLM gateway's URL and credential.
 *
 * Prefers the canonical name, then any `openai-compatible` row that has a
 * base URL. The snapshot is cold before boot warms it, in which case callers
 * fall back to the env-only path (or return null).
 */
export function resolveGatewayConnectionName(): string | null {
  const connections = listSnapshotConnections();
  const canonical = connections.find(
    (connection) => connection.name === LLM_GATEWAY_CONNECTION_NAME,
  );
  if (canonical != null) {
    return canonical.name;
  }
  return (
    connections.find(
      (connection) =>
        connection.provider === LLM_GATEWAY_PROVIDER &&
        connection.baseUrl != null,
    )?.name ?? null
  );
}

/** The model the main agent resolves to, for adapter construction. */
export function resolveGatewayModel(llm: LLMConfig): string {
  const resolution = resolveCallSite("mainAgent", llm);
  return resolution.status === "ok" ? resolution.model : llm.defaultModel;
}
