import { describe, expect, test } from "bun:test";

import type { CredentialRecord } from "@vellumai/service-contracts/credential-rpc";

import { handleFileRoute } from "../file-routes.js";
import { handleKvRoute } from "../kv-routes.js";
import { handleResolveRoute } from "../resolve-routes.js";
import {
  PsonoCredentialBackend,
  type PsonoStatusSource,
  type PsonoTreeSource,
  type RecordSource,
} from "../../psono/backend.js";
import { denied } from "../../psono/errors.js";
import type { PsonoEntry } from "../../psono/tree.js";
import type { SecretPayload } from "../../psono/types.js";

const SERVICE_TOKEN = "service-token";
const KV_TOKEN = "kv-token";

const entry: PsonoEntry = {
  path: "TEST",
  name: "TEST",
  secretId: "secret-1",
  secretKey: new Uint8Array(32),
  source: "share",
};

const record: CredentialRecord = {
  credentialId: "demo-password",
  service: "demo",
  field: "password",
  ref: "TEST",
  kind: "value",
  allowedTools: [],
  allowedDomains: [],
  createdAt: 1,
  updatedAt: 1,
};

const records: RecordSource = {
  getByAccount: (account) =>
    account === "credential/demo/password" ? record : undefined,
  list: () => [{ account: "credential/demo/password", record }],
};

const status: PsonoStatusSource = {
  getStatus: () => ({
    configured: true,
    sessionOpen: true,
    lastRefresh: null,
    lastError: null,
  }),
};

class StubTree implements PsonoTreeSource {
  payload: SecretPayload = { password: "value-1" };
  fail: Error | undefined;

  async find(ref: string): Promise<PsonoEntry> {
    if (ref !== "TEST") {
      throw new Error("missing");
    }
    return entry;
  }

  async readPayload(): Promise<SecretPayload> {
    if (this.fail) {
      throw this.fail;
    }
    return this.payload;
  }

  invalidate(): void {}
}

function backend(tree = new StubTree()): PsonoCredentialBackend {
  return new PsonoCredentialBackend({ client: status, tree, records });
}

function request(path: string, headers: Record<string, string> = {}): Request {
  return new Request(`http://ces${path}`, { headers });
}

describe("KV route", () => {
  test("returns the KV v2 envelope", async () => {
    const response = await handleKvRoute(request("/v1/TEST", { "x-vault-token": KV_TOKEN }), {
      backend: backend(),
      kvToken: KV_TOKEN,
    });
    expect(response!.status).toBe(200);
    expect(await response!.json()).toEqual({
      data: { data: { password: "value-1" }, metadata: { version: 1 } },
    });
  });

  test("rejects a wrong or missing token", async () => {
    const cases: Array<Record<string, string>> = [
      { "x-vault-token": "wrong" },
      {},
    ];
    for (const headers of cases) {
      const response = await handleKvRoute(request("/v1/TEST", headers), {
        backend: backend(),
        kvToken: KV_TOKEN,
      });
      expect(response!.status).toBe(403);
    }
  });

  test("returns 503 when the backend is not configured", async () => {
    const response = await handleKvRoute(request("/v1/TEST", { "x-vault-token": KV_TOKEN }), {
      backend: undefined,
      kvToken: KV_TOKEN,
    });
    expect(response!.status).toBe(503);
  });

  test("ignores reserved prefixes", async () => {
    const response = await handleKvRoute(request("/v1/credentials", { "x-vault-token": KV_TOKEN }), {
      backend: backend(),
      kvToken: KV_TOKEN,
    });
    expect(response).toBeNull();
  });
});

describe("resolve route", () => {
  test("returns the resolved value", async () => {
    const response = await handleResolveRoute(
      request("/v1/resolve/demo/password", { authorization: `Bearer ${SERVICE_TOKEN}` }),
      { backend: backend(), serviceToken: SERVICE_TOKEN },
    );
    expect(response!.status).toBe(200);
    expect(await response!.json()).toEqual({ value: "value-1" });
  });

  test("returns 401 without a bearer", async () => {
    const response = await handleResolveRoute(
      request("/v1/resolve/demo/password"),
      { backend: backend(), serviceToken: SERVICE_TOKEN },
    );
    expect(response!.status).toBe(401);
    expect(await response!.json()).toEqual({ error: "unauthorized" });
  });

  test("returns 404 for an unmapped reference", async () => {
    const response = await handleResolveRoute(
      request("/v1/resolve/demo/other", { authorization: `Bearer ${SERVICE_TOKEN}` }),
      { backend: backend(), serviceToken: SERVICE_TOKEN },
    );
    expect(response!.status).toBe(404);
    expect(await response!.json()).toEqual({ error: "not_found" });
  });

  test("returns 403 when Psono denies access", async () => {
    const tree = new StubTree();
    tree.fail = denied();
    const response = await handleResolveRoute(
      request("/v1/resolve/demo/password", { authorization: `Bearer ${SERVICE_TOKEN}` }),
      { backend: backend(tree), serviceToken: SERVICE_TOKEN },
    );
    expect(response!.status).toBe(403);
    expect(await response!.json()).toEqual({ error: "denied" });
  });
});

describe("file route", () => {
  test("returns octet-stream bytes by default", async () => {
    const response = await handleFileRoute(
      request("/v1/files/demo/password", { authorization: `Bearer ${SERVICE_TOKEN}` }),
      { backend: backend(), serviceToken: SERVICE_TOKEN },
    );
    expect(response!.status).toBe(200);
    expect(response!.headers.get("content-type")).toBe("application/octet-stream");
    expect(await response!.text()).toBe("value-1");
  });

  test("returns base64 JSON with format=json", async () => {
    const response = await handleFileRoute(
      request("/v1/files/demo/password?format=json", {
        authorization: `Bearer ${SERVICE_TOKEN}`,
      }),
      { backend: backend(), serviceToken: SERVICE_TOKEN },
    );
    expect(response!.status).toBe(200);
    expect(await response!.json()).toEqual({
      content_base64: Buffer.from("value-1").toString("base64"),
      mode: "0600",
    });
  });
});
