/**
 * Vault KV v2-compatible read endpoint.
 *
 * `GET /v1/<path>` where `<path>` is a logical ref from the CES credential
 * map. Auth: `X-Vault-Token: <CES_KV_TOKEN>`. A successful response has the
 * shape Antirion's vault store expects:
 *
 *   { "data": { "data": { ...fields }, "metadata": { "version": 1 } } }
 *
 * This route is registered after the credential, metadata, resolve, and file
 * routes so those prefixes are never swallowed by the catch-all.
 */

import type { PsonoCredentialBackend } from "../psono/backend.js";
import { jsonResponse, equalsConstantTime } from "./service-auth.js";
import { psonoErrorResponse } from "./psono-route-utils.js";

export interface KvRouteDeps {
  backend: PsonoCredentialBackend | undefined;
  kvToken: string;
}

const PREFIX = "/v1/";
const RESERVED = [
  "/v1/credentials",
  "/v1/metadata",
  "/v1/resolve",
  "/v1/files",
  "/v1/logs",
];

function isReserved(pathname: string): boolean {
  return RESERVED.some(
    (prefix) => pathname === prefix || pathname.startsWith(`${prefix}/`),
  );
}

export async function handleKvRoute(
  req: Request,
  deps: KvRouteDeps,
): Promise<Response | null> {
  const url = new URL(req.url);
  const { pathname } = url;

  if (!pathname.startsWith(PREFIX) || isReserved(pathname)) {
    return null;
  }
  if (req.method !== "GET") {
    return null;
  }

  const ref = pathname.slice(PREFIX.length);
  if (ref.length === 0) {
    return null;
  }

  const provided = req.headers.get("x-vault-token");
  if (!deps.kvToken || !equalsConstantTime(provided, deps.kvToken)) {
    return jsonResponse({ errors: ["permission denied"] }, 403);
  }

  if (!deps.backend) {
    return jsonResponse({ errors: ["credential store unavailable"] }, 503);
  }

  try {
    const data = await deps.backend.getByRef(decodeURIComponent(ref));
    return jsonResponse({
      data: {
        data,
        metadata: { version: 1 },
      },
    });
  } catch (err) {
    return psonoErrorResponse(err, "kv");
  }
}
