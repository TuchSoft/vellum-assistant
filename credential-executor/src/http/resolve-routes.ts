/**
 * Resolve endpoint for per-request consumers (rest-gateway, Antirion).
 *
 * `GET /v1/resolve/<service>/<field>` → `{ "value": "..." }`
 * Auth: `CES_READ_TOKEN`, `CES_WRITE_TOKEN` or `CES_SERVICE_TOKEN`.
 */

import type { PsonoCredentialBackend } from "../psono/backend.js";
import { authorize, type CesTokens } from "./capability-auth.js";
import { jsonResponse } from "./service-auth.js";
import { psonoErrorResponse } from "./psono-route-utils.js";

export interface ResolveRouteDeps {
  backend: PsonoCredentialBackend | undefined;
  tokens: CesTokens;
}

const PREFIX = "/v1/resolve/";

function parseTarget(
  pathname: string,
): { service: string; field: string } | null {
  if (!pathname.startsWith(PREFIX)) {
    return null;
  }
  const parts = pathname.slice(PREFIX.length).split("/");
  if (parts.length !== 2 || !parts[0] || !parts[1]) {
    return null;
  }
  return {
    service: decodeURIComponent(parts[0]),
    field: decodeURIComponent(parts[1]),
  };
}

export async function handleResolveRoute(
  req: Request,
  deps: ResolveRouteDeps,
): Promise<Response | null> {
  const target = parseTarget(new URL(req.url).pathname);
  if (!target) {
    return null;
  }
  if (req.method !== "GET") {
    return null;
  }

  const denial = authorize(req, deps.tokens, "read");
  if (denial) {
    return denial;
  }

  if (!deps.backend) {
    return jsonResponse({ error: "unavailable" }, 503);
  }

  try {
    const resolved = await deps.backend.resolve(target.service, target.field);
    return jsonResponse({ value: resolved.value });
  } catch (err) {
    return psonoErrorResponse(err, "plain");
  }
}
