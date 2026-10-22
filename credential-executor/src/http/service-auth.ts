/**
 * Constant-time comparison for the CES HTTP tokens.
 */

import { timingSafeEqual } from "node:crypto";

export function equalsConstantTime(
  provided: string | null | undefined,
  expected: string,
): boolean {
  if (!provided) {
    return false;
  }
  const a = Buffer.from(provided);
  const b = Buffer.from(expected);
  return a.length === b.length && timingSafeEqual(a, b);
}

/** Read `Authorization: Bearer <token>`, returning the token or undefined. */
export function readBearerToken(req: Request): string | undefined {
  const header = req.headers.get("authorization");
  if (!header) {
    return undefined;
  }
  const parts = header.split(" ");
  if (parts.length !== 2 || parts[0]!.toLowerCase() !== "bearer") {
    return undefined;
  }
  return parts[1];
}

export function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}
