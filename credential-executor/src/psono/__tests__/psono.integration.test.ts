import { beforeAll, describe, expect, test } from "bun:test";
import { existsSync } from "node:fs";

import type { CredentialRecord } from "@vellumai/service-contracts/credential-rpc";

import { handleKvRoute } from "../../http/kv-routes.js";
import { handleResolveRoute } from "../../http/resolve-routes.js";
import {
  PsonoCredentialBackend,
  type RecordSource,
} from "../backend.js";
import { PsonoClient } from "../client.js";
import { loadMaterialFile } from "../material.js";
import { PsonoTree } from "../tree.js";

const MATERIAL_PATH =
  process.env["PSONO_MATERIAL_FILE"] ??
  "/Users/mattiabonzi/Progetti/assistant/docs/psono/CRED.txt";

const SERVICE_TOKEN = "integration-service-token";
const KV_TOKEN = "integration-kv-token";

const record: CredentialRecord = {
  credentialId: "psono-test-password",
  service: "psono-test",
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
    account === "credential/psono-test/password" ? record : undefined,
  list: () => [{ account: "credential/psono-test/password", record }],
};

const live = existsSync(MATERIAL_PATH) ? describe : describe.skip;

live("Psono integration (read-only)", () => {
  const material = existsSync(MATERIAL_PATH)
    ? loadMaterialFile(MATERIAL_PATH)
    : undefined;
  const client = material
    ? new PsonoClient({ material })
    : undefined;
  const tree = client ? new PsonoTree(client) : undefined;
  const backend =
    client && tree
      ? new PsonoCredentialBackend({ client, tree, records })
      : undefined;

  beforeAll(async () => {
    await client!.login();
  }, 30_000);

  test(
    "logs in and exposes a session",
    () => {
      const status = client!.getStatus();
      expect(status.sessionOpen).toBe(true);
      expect(status.lastRefresh).not.toBeNull();
      expect(status.lastError).toBeNull();
    },
    30_000,
  );

  test(
    "enumerates the shares visible to joanna",
    async () => {
      const entry = await tree!.find("TEST");
      expect(entry.secretId.length).toBeGreaterThan(0);
      expect(entry.source).toBe("share");
    },
    30_000,
  );

  test(
    "reads and decrypts the shared test entry",
    async () => {
      const entry = await tree!.find("TEST");
      const payload = await tree!.readPayload(entry);
      // Never print the value: only its shape is asserted.
      expect(typeof payload["password"]).toBe("string");
      expect((payload["password"] as string).length).toBeGreaterThan(0);
    },
    30_000,
  );

  test(
    "serves the KV v2 envelope",
    async () => {
      const response = await handleKvRoute(
        new Request("http://ces/v1/TEST", {
          headers: { "x-vault-token": KV_TOKEN },
        }),
        { backend: backend!, kvToken: KV_TOKEN },
      );
      expect(response!.status).toBe(200);
      const body = (await response!.json()) as {
        data: { data: Record<string, unknown>; metadata: { version: number } };
      };
      expect(body.data.metadata.version).toBe(1);
      expect(typeof body.data.data["password"]).toBe("string");
    },
    30_000,
  );

  test(
    "resolves a mapped service/field",
    async () => {
      const response = await handleResolveRoute(
        new Request("http://ces/v1/resolve/psono-test/password", {
          headers: { authorization: `Bearer ${SERVICE_TOKEN}` },
        }),
        { backend: backend!, serviceToken: SERVICE_TOKEN },
      );
      expect(response!.status).toBe(200);
      const body = (await response!.json()) as { value: string };
      expect(typeof body.value).toBe("string");
      expect(body.value.length).toBeGreaterThan(0);
    },
    30_000,
  );

  test(
    "returns 404 for an unmapped reference",
    async () => {
      const response = await handleResolveRoute(
        new Request("http://ces/v1/resolve/psono-test/missing", {
          headers: { authorization: `Bearer ${SERVICE_TOKEN}` },
        }),
        { backend: backend!, serviceToken: SERVICE_TOKEN },
      );
      expect(response!.status).toBe(404);
      expect(await response!.json()).toEqual({ error: "not_found" });
    },
    30_000,
  );

  test(
    "returns 401 without a bearer",
    async () => {
      const response = await handleResolveRoute(
        new Request("http://ces/v1/resolve/psono-test/password"),
        { backend: backend!, serviceToken: SERVICE_TOKEN },
      );
      expect(response!.status).toBe(401);
    },
    30_000,
  );

  test(
    "returns 503 when Psono is unreachable",
    async () => {
      const brokenClient = new PsonoClient({
        material: { ...material!, serverUrl: "http://127.0.0.1:9" },
        timeoutMs: 500,
      });
      const brokenBackend = new PsonoCredentialBackend({
        client: brokenClient,
        tree: new PsonoTree(brokenClient),
        records,
      });
      await expect(
        brokenBackend.resolve("psono-test", "password"),
      ).rejects.toMatchObject({ kind: "unavailable" });
    },
    30_000,
  );

  // The vault has no entry that exists but is not shared with `joanna`; every
  // visible entry is reachable. Psono also answers NO_PERMISSION_OR_NOT_EXIST
  // for both cases, so 403 cannot be produced from this material.
  test.skip(
    "returns 403 for an entry that exists but is not shared with joanna",
    () => {},
  );
});
