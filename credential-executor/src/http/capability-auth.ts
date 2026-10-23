/**
 * Capability-based authorization for the CES HTTP surface.
 *
 * Three bearer tokens, three capabilities, no per-reference scoping:
 *
 * - `CES_READ_TOKEN`    — `GET /v1/resolve/*` and `GET /v1/files/*`
 * - `CES_WRITE_TOKEN`   — the read capability plus `PUT|POST /v1/files/*`
 * - `CES_SERVICE_TOKEN` — the whole surface, including `/v1/metadata` and
 *                         `/v1/credentials`
 *
 * The tokens express capabilities, not allowlists: a consumer holds the
 * smallest token that covers the operations it performs, and what it may read
 * is decided by the Psono account, never by a list CES has to maintain.
 *
 * A capability token presented on an endpoint that needs more answers `403`
 * with a code naming the token class; a missing or unknown token answers
 * `401`. When no token at all is configured, every capability endpoint stays
 * closed (`503`) instead of falling open.
 */

import {
  equalsConstantTime,
  jsonResponse,
  readBearerToken,
} from "./service-auth.js";

export type CesCapability = "read" | "write" | "service";

/** The class a presented token belongs to: the capability it carries. */
export type CesTokenClass = CesCapability;

export interface CesTokens {
  read: string;
  write: string;
  service: string;
}

/** Higher rank covers every lower capability. */
const RANK: Record<CesCapability, number> = { read: 0, write: 1, service: 2 };

/** Strongest first, so a token is classified against the highest class it can
 * represent (the tokens are independent values, so at most one matches). */
const STRONGEST_FIRST: readonly CesCapability[] = ["service", "write", "read"];

export function readTokensFromEnv(
  env: Record<string, string | undefined> = process.env,
): CesTokens {
  return {
    read: env["CES_READ_TOKEN"]?.trim() ?? "",
    write: env["CES_WRITE_TOKEN"]?.trim() ?? "",
    service: env["CES_SERVICE_TOKEN"]?.trim() ?? "",
  };
}

function configuredTokens(tokens: CesTokens): boolean {
  return Boolean(tokens.read || tokens.write || tokens.service);
}

/** Match a presented bearer against the configured tokens. */
export function classifyToken(
  req: Request,
  tokens: CesTokens,
): CesTokenClass | null {
  const provided = readBearerToken(req);
  if (!provided) {
    return null;
  }
  for (const tokenClass of STRONGEST_FIRST) {
    const expected = tokens[tokenClass];
    if (expected && equalsConstantTime(provided, expected)) {
      return tokenClass;
    }
  }
  return null;
}

/** Codes returned in the `403` body. */
const READ_ONLY_CODE = "read_only_token";
const WRITE_SCOPE_CODE = "write_scope_required";

/**
 * Body for a `403`. The `error` names the class of the token that was
 * presented; `required` names what the endpoint needed.
 */
export function capabilityDenial(
  presented: Exclude<CesTokenClass, "service">,
  required: CesCapability,
): { error: string; presented: CesTokenClass; required: CesCapability } {
  return {
    error: presented === "read" ? READ_ONLY_CODE : WRITE_SCOPE_CODE,
    presented,
    required,
  };
}

/**
 * Authorize a request for one capability. Returns `null` when the request may
 * proceed, otherwise the response to send.
 */
export function authorize(
  req: Request,
  tokens: CesTokens,
  required: CesCapability,
): Response | null {
  if (!configuredTokens(tokens)) {
    return jsonResponse({ error: "token_not_configured", required }, 503);
  }

  const presented = classifyToken(req, tokens);
  if (!presented) {
    return jsonResponse({ error: "unauthorized" }, 401);
  }
  if (presented === "service" || RANK[presented] >= RANK[required]) {
    return null;
  }
  return jsonResponse(capabilityDenial(presented, required), 403);
}

/**
 * Authorize a request for the admin surface (`/v1/metadata`,
 * `/v1/credentials`). Only `CES_SERVICE_TOKEN` grants it.
 *
 * Kept separate from `authorize` because this surface has always answered
 * `401` for a missing/malformed header and `403` for a wrong token; a
 * capability token now gets the explicit denial code instead.
 */
export function authorizeService(
  req: Request,
  tokens: CesTokens,
): Response | null {
  if (!readBearerToken(req)) {
    return jsonResponse(
      { error: "Missing Authorization header" },
      401,
    );
  }
  if (!configuredTokens(tokens)) {
    return jsonResponse({ error: "token_not_configured", required: "service" }, 503);
  }

  const presented = classifyToken(req, tokens);
  if (presented === "service") {
    return null;
  }
  if (presented) {
    return jsonResponse(capabilityDenial(presented, "service"), 403);
  }
  return jsonResponse({ error: "Invalid service token" }, 403);
}
