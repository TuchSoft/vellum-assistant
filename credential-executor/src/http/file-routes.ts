/**
 * File endpoint: serves and stores a credential as bytes for file-shaped
 * consumers.
 *
 * `GET /v1/files/<service>/<field>` → `application/octet-stream`
 * `GET /v1/files/<service>/<field>?format=json` →
 *   `{"content_base64":"...","mode":"0600"}`
 * `PUT /v1/files/<service>/<field>` (and `POST`) writes the body bytes into the
 *   entry behind the record, keeping `kind: "file"`.
 *
 * CES never writes into another container's filesystem; the consumer writes
 * the bytes with mode 0600.
 *
 * The body is stored in the entry's JSON string field named after the record's
 * `field`, which is exactly what the read path encodes back to bytes. Only
 * valid UTF-8 is accepted: a non-UTF-8 body could not round-trip through that
 * text field byte for byte, so it answers `400 invalid_utf8`.
 *
 * `kind` is never converted implicitly. A record that is `value` or `json`
 * answers `409 kind_mismatch`; to change its shape, delete the record and PUT
 * the file-shaped one.
 *
 * Auth: reads accept `CES_READ_TOKEN`, `CES_WRITE_TOKEN` or
 * `CES_SERVICE_TOKEN`; writes need `CES_WRITE_TOKEN` or `CES_SERVICE_TOKEN`.
 */

import { randomUUID } from "node:crypto";

import type { CredentialRecord } from "@vellumai/service-contracts/credential-rpc";

import type { PsonoCredentialBackend } from "../psono/backend.js";
import { defaultStackRef } from "../psono/refs.js";
import { authorize, type CesTokens } from "./capability-auth.js";
import { jsonResponse } from "./service-auth.js";
import { psonoErrorResponse } from "./psono-route-utils.js";

/** Narrow metadata surface the write path needs. */
export interface FileRecordStore {
  getByAccount(account: string): CredentialRecord | undefined;
  setByAccount(account: string, record: CredentialRecord): boolean;
}

export interface FileRouteDeps {
  backend: PsonoCredentialBackend | undefined;
  /** Metadata store; absent means writes are unavailable (reads still work). */
  records?: FileRecordStore;
  tokens: CesTokens;
}

const PREFIX = "/v1/files/";
const ACCOUNT_PREFIX = "credential/";

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

async function handleRead(
  req: Request,
  url: URL,
  target: { service: string; field: string },
  deps: FileRouteDeps,
): Promise<Response> {
  const denial = authorize(req, deps.tokens, "read");
  if (denial) {
    return denial;
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

async function handleWrite(
  req: Request,
  target: { service: string; field: string },
  deps: FileRouteDeps,
): Promise<Response> {
  const denial = authorize(req, deps.tokens, "write");
  if (denial) {
    return denial;
  }

  if (!deps.backend || !deps.records) {
    return jsonResponse({ error: "unavailable" }, 503);
  }

  const bytes = new Uint8Array(await req.arrayBuffer());
  let content: string;
  try {
    content = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch {
    return jsonResponse({ error: "invalid_utf8" }, 400);
  }

  const account = `${ACCOUNT_PREFIX}${target.service}/${target.field}`;
  const existing = deps.records.getByAccount(account);
  if (existing && existing.kind !== "file") {
    return jsonResponse(
      { error: "kind_mismatch", kind: existing.kind ?? "value" },
      409,
    );
  }

  const ref =
    existing?.ref && existing.ref.trim() !== ""
      ? existing.ref
      : defaultStackRef(target.service, target.field);

  try {
    await deps.backend.createEntry(
      ref,
      { title: `${target.service}/${target.field}`, [target.field]: content },
      "file",
    );

    const now = Date.now();
    const record: CredentialRecord = {
      credentialId: existing?.credentialId ?? randomUUID(),
      service: target.service,
      field: target.field,
      ref,
      kind: "file",
      createdAt: existing?.createdAt ?? now,
      updatedAt: now,
    };
    deps.records.setByAccount(account, record);
    deps.backend.invalidate();

    return jsonResponse({
      ok: true,
      service: target.service,
      field: target.field,
      ref,
      kind: "file",
      bytes: bytes.byteLength,
      created: existing === undefined,
    });
  } catch (err) {
    return psonoErrorResponse(err, "plain");
  }
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

  if (req.method === "GET") {
    return handleRead(req, url, target, deps);
  }
  if (req.method === "PUT" || req.method === "POST") {
    return handleWrite(req, target, deps);
  }
  return null;
}
