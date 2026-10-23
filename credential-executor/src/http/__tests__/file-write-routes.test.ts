import { describe, expect, test } from "bun:test";

import type { CredentialRecord } from "@vellumai/service-contracts/credential-rpc";

import { handleFileRoute, type FileRecordStore } from "../file-routes.js";
import {
  PsonoCredentialBackend,
  type PsonoClientSource,
  type PsonoTreeSource,
  type RecordSource,
} from "../../psono/backend.js";
import { hexToBytes, secretBoxOpen } from "../../psono/crypto.js";
import type { PsonoEntry, ShareHandle } from "../../psono/tree.js";
import {
  normalizePayload,
  type PsonoShareContent,
  type SecretPayload,
} from "../../psono/types.js";

const SERVICE_TOKEN = "service-token";

/** One share root with the `stack` folder the write path targets. */
function emptyContent(): PsonoShareContent {
  return {
    id: "share-1",
    name: "Joanna-shared",
    folders: [{ id: "folder-1", name: "stack", items: [] }],
  };
}

class MemoryRecords implements RecordSource, FileRecordStore {
  private readonly rows = new Map<string, CredentialRecord>();

  constructor(initial: CredentialRecord[] = []) {
    for (const record of initial) {
      this.rows.set(`credential/${record.service}/${record.field}`, record);
    }
  }

  getByAccount(account: string): CredentialRecord | undefined {
    return this.rows.get(account);
  }

  setByAccount(account: string, record: CredentialRecord): boolean {
    this.rows.set(account, record);
    return true;
  }

  list(): Array<{ account: string; record: CredentialRecord }> {
    return [...this.rows.entries()].map(([account, record]) => ({
      account,
      record,
    }));
  }
}

/** Client that keeps the sealed payloads so the tree can open them. */
class FakeClient implements PsonoClientSource {
  readonly secrets = new Map<string, { data: string; data_nonce: string }>();
  creates = 0;
  private sequence = 0;

  getStatus() {
    return {
      configured: true,
      sessionOpen: true,
      lastRefresh: null,
      lastError: null,
    };
  }

  async createSecret(input: {
    data: string;
    data_nonce: string;
  }): Promise<{ secretId: string }> {
    this.creates += 1;
    const secretId = `secret-${++this.sequence}`;
    this.secrets.set(secretId, {
      data: input.data,
      data_nonce: input.data_nonce,
    });
    return { secretId };
  }

  async updateSecret(
    secretId: string,
    payload: { data: string; data_nonce: string },
  ): Promise<void> {
    this.secrets.set(secretId, payload);
  }

  async deleteSecretLink(): Promise<void> {}
}

/** Share tree backed by an in-memory folder tree and the client's secrets. */
class WritableTree implements PsonoTreeSource {
  content = emptyContent();

  constructor(private readonly client: FakeClient) {}

  async find(ref: string): Promise<PsonoEntry> {
    const name = ref.split("/").pop() ?? "";
    for (const folder of this.content.folders ?? []) {
      const item = (folder.items ?? []).find(
        (candidate) => candidate.name === name,
      );
      if (item?.secret_id && item.secret_key && item.name) {
        return {
          path: item.name,
          name: item.name,
          type: item.type,
          secretId: item.secret_id,
          secretKey: hexToBytes(item.secret_key),
          source: "share",
        };
      }
    }
    throw new Error(`missing ref ${ref}`);
  }

  async readPayload(entry: PsonoEntry): Promise<SecretPayload> {
    return normalizePayload(await this.readRawPayload(entry), entry.type);
  }

  async readRawPayload(entry: PsonoEntry): Promise<SecretPayload> {
    const sealed = this.client.secrets.get(entry.secretId);
    if (!sealed) {
      throw new Error("missing secret");
    }
    const opened = secretBoxOpen(
      hexToBytes(sealed.data),
      hexToBytes(sealed.data_nonce),
      entry.secretKey,
    );
    return JSON.parse(new TextDecoder().decode(opened)) as SecretPayload;
  }

  async openWritableShare(): Promise<ShareHandle> {
    return {
      shareId: "share-1",
      shareKey: new Uint8Array(32),
      content: structuredClone(this.content),
      read: async () => structuredClone(this.content),
      update: async <T>(
        mutator: (content: PsonoShareContent) => T | Promise<T>,
      ): Promise<T> => {
        const current = structuredClone(this.content);
        const result = await mutator(current);
        this.content = current;
        return result;
      },
    };
  }

  invalidate(): void {}
}

function setup(initial: CredentialRecord[] = []) {
  const client = new FakeClient();
  const tree = new WritableTree(client);
  const records = new MemoryRecords(initial);
  const backend = new PsonoCredentialBackend({
    client,
    tree,
    records,
  });
  return { client, tree, records, backend };
}

function request(
  path: string,
  init: { method?: string; body?: string | ArrayBuffer; auth?: string } = {},
): Request {
  const headers: Record<string, string> = {};
  if (init.auth) {
    headers["authorization"] = `Bearer ${init.auth}`;
  }
  return new Request(`http://ces${path}`, {
    method: init.method ?? "GET",
    headers,
    body: init.body,
  });
}

function deps(ctx: ReturnType<typeof setup>) {
  return {
    backend: ctx.backend,
    records: ctx.records,
    serviceToken: SERVICE_TOKEN,
  };
}

describe("file write route", () => {
  test("creates a missing record as kind file and reads the bytes back", async () => {
    const ctx = setup();
    const content = "città\nline two\n";

    const put = await handleFileRoute(
      request("/v1/files/google-workspace/union", {
        method: "PUT",
        auth: SERVICE_TOKEN,
        body: content,
      }),
      deps(ctx),
    );
    expect(put!.status).toBe(200);
    expect(await put!.json()).toMatchObject({
      ok: true,
      service: "google-workspace",
      field: "union",
      ref: "Joanna-shared/stack/google-workspace-union",
      kind: "file",
      created: true,
    });

    const record = ctx.records.getByAccount(
      "credential/google-workspace/union",
    );
    expect(record?.kind).toBe("file");
    expect(record?.ref).toBe("Joanna-shared/stack/google-workspace-union");

    const get = await handleFileRoute(
      request("/v1/files/google-workspace/union", { auth: SERVICE_TOKEN }),
      deps(ctx),
    );
    expect(get!.status).toBe(200);
    expect(get!.headers.get("content-type")).toBe("application/octet-stream");
    expect(new Uint8Array(await get!.arrayBuffer())).toEqual(
      new TextEncoder().encode(content),
    );
  });

  test("updates the entry and keeps kind file", async () => {
    const ctx = setup();
    const first = await handleFileRoute(
      request("/v1/files/demo/blob", {
        method: "PUT",
        auth: SERVICE_TOKEN,
        body: "first",
      }),
      deps(ctx),
    );
    expect(first!.status).toBe(200);

    const second = await handleFileRoute(
      request("/v1/files/demo/blob", {
        method: "PUT",
        auth: SERVICE_TOKEN,
        body: "second, different",
      }),
      deps(ctx),
    );
    expect(second!.status).toBe(200);
    expect(await second!.json()).toMatchObject({ created: false });

    const record = ctx.records.getByAccount("credential/demo/blob");
    expect(record?.kind).toBe("file");

    const get = await handleFileRoute(
      request("/v1/files/demo/blob", { auth: SERVICE_TOKEN }),
      deps(ctx),
    );
    expect(await get!.text()).toBe("second, different");
  });

  test("POST behaves like PUT", async () => {
    const ctx = setup();
    const response = await handleFileRoute(
      request("/v1/files/demo/posted", {
        method: "POST",
        auth: SERVICE_TOKEN,
        body: "posted",
      }),
      deps(ctx),
    );
    expect(response!.status).toBe(200);
    expect(await response!.json()).toMatchObject({ kind: "file" });
    expect(ctx.records.getByAccount("credential/demo/posted")?.kind).toBe(
      "file",
    );
  });

  test("refuses to convert a value record", async () => {
    const ctx = setup([
      {
        credentialId: "value-record",
        service: "demo",
        field: "value",
        ref: "Joanna-shared/stack/demo-value",
        kind: "value",
        sourceField: "password",
        createdAt: 1,
        updatedAt: 1,
      },
    ]);

    const response = await handleFileRoute(
      request("/v1/files/demo/value", {
        method: "PUT",
        auth: SERVICE_TOKEN,
        body: "nope",
      }),
      deps(ctx),
    );
    expect(response!.status).toBe(409);
    expect(await response!.json()).toEqual({
      error: "kind_mismatch",
      kind: "value",
    });
    expect(ctx.client.creates).toBe(0);
    expect(ctx.records.getByAccount("credential/demo/value")?.kind).toBe(
      "value",
    );
  });

  test("rejects an unauthenticated write", async () => {
    const ctx = setup();
    const response = await handleFileRoute(
      request("/v1/files/demo/blob", { method: "PUT", body: "x" }),
      deps(ctx),
    );
    expect(response!.status).toBe(401);
    expect(ctx.client.creates).toBe(0);
  });

  test("rejects a body that is not valid UTF-8", async () => {
    const ctx = setup();
    const response = await handleFileRoute(
      request("/v1/files/demo/blob", {
        method: "PUT",
        auth: SERVICE_TOKEN,
        body: new Uint8Array([0xff, 0xfe, 0x00]).buffer,
      }),
      deps(ctx),
    );
    expect(response!.status).toBe(400);
    expect(await response!.json()).toEqual({ error: "invalid_utf8" });
    expect(ctx.client.creates).toBe(0);
  });
});
