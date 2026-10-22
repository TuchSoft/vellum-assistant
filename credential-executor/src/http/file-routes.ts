/**
 * File endpoint: serves a credential as bytes for file-shaped consumers.
 *
 * `GET /v1/files/<service>/<field>` → `application/octet-stream`
 * `GET /v1/files/<service>/<field>?format=json` →
 *   `{"content_base64":"...","mode":"0600"}`
 *
 * CES never writes into another container's filesystem; the consumer writes
 * the bytes with mode 0600.
 */

import type { PsonoCredentialBackend } from "../psono/backend.js";
import {
  equalsConstantTime,
  jsonResponse,
  readBearerToken,
} from "./service-auth.js";
import { psonoErrorResponse } from "./psono-route-utils.js";

export interface FileRouteDeps {
  backend: PsonoCredentialBackend | undefined;
  serviceToken: string;
}

const PREFIX = "/v1/files/";

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

export async function handleFileRoute(
  req: Request,
  deps: FileRouteDeps,
): Promise<Response | null> {
  const url = new URL(req.url);
  const target = parseTarget(url.pathname);
  if (!target) {
    return null;
  }
  if (req.method !== "GET") {
    return null;
  }

  if (
    !deps.serviceToken ||
    !equalsConstantTime(readBearerToken(req), deps.serviceToken)
  ) {
    return jsonResponse({ error: "unauthorized" }, 401);
  }

  if (!deps.backend) {
    return jsonResponse({ error: "unavailable" }, 503);
  }

  try {
    const file = await deps.backend.resolveFile(target.service, target.field);
    if (url.searchParams.get("format") === "json") {
      return jsonResponse({
        content_base64: Buffer.from(file.bytes).toString("base64"),
        mode: "0600",
      });
    }
    return new Response(new Blob([file.bytes]), {
      status: 200,
      headers: { "Content-Type": "application/octet-stream" },
    });
  } catch (err) {
    return psonoErrorResponse(err, "plain");
  }
}
