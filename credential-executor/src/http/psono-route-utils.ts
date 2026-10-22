/**
 * Error mapping shared by the Psono-backed HTTP routes.
 */

import { asPsonoError } from "../psono/errors.js";
import { jsonResponse } from "./service-auth.js";

/**
 * Map a typed Psono error to the route response.
 *
 * `kv` reproduces the Vault KV v2 error envelope (`{"errors":[...]}`);
 * `plain` uses the resolve/file envelope (`{"error":"..."}`).
 */
export function psonoErrorResponse(
  err: unknown,
  style: "kv" | "plain",
): Response {
  const typed = asPsonoError(err);
  const status =
    typed.kind === "not_found"
      ? 404
      : typed.kind === "denied"
        ? style === "kv"
          ? 404
          : 403
        : typed.kind === "unauthorized"
          ? 401
          : 503;

  if (style === "kv") {
    const message =
      typed.kind === "denied"
        ? "permission denied or not found"
        : typed.kind === "not_found"
          ? "not found"
          : "credential store unavailable";
    return jsonResponse({ errors: [message] }, status);
  }

  return jsonResponse({ error: typed.kind }, status);
}
