import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type { SecureKeyBackend } from "@vellumai/credential-storage";
import type { CredentialRecord } from "@vellumai/service-contracts/credential-rpc";

import {
  authorize,
  authorizeService,
  classifyToken,
  readTokensFromEnv,
  type CesTokens,
} from "../capability-auth.js";
import { handleCredentialRoute } from "../credential-routes.js";
import { handleFileRoute, type FileRecordStore } from "../file-routes.js";
import { handleMetadataRoute } from "../metadata-routes.js";
import { handleResolveRoute } from "../resolve-routes.js";
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
import {
  initMetadataStore,
  resetMetadataStoreForTests,
} from "../../records/metadata-store.js";

const READ_TOKEN = "read-token";
const WRITE_TOKEN = "write-token";
const SERVICE_TOKEN = "service-token";
const TOKENS: CesTokens = {
  read: READ_TOKEN,
  write: WRITE_TOKEN,
  service: SERVICE_TOKEN,
};

const record: CredentialRecord = {
  credentialId: "demo-password",
  service: "demo",
  field: "password",
  ref: "TEST",
  kind: "value",
  createdAt: 1,
  updatedAt: 1,
};

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
    for (const entry of initial) {
      this.rows.set(`credential/${entry.service}/${entry.field}`, entry);
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
    return [...this.rows.entries()].map(([account, entry]) => ({
      account,
      record: entry,
    }));
  }
}

/** Client that keeps the sealed payloads so the tree can open them. */
class FakeClient implements PsonoClientSource {
  readonly secrets = new Map<string, { data: string; data_nonce: string }>();
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
    const secretId = `secret-${++this.sequence}`;
    this.secrets.set(secretId, input);
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

/** Share tree with one readable entry and a writable `stack` folder. */
class FakeTree implements PsonoTreeSource {
  content = emptyContent();

  constructor(private readonly client: FakeClient) {}

  async find(ref: string): Promise<PsonoEntry> {
    if (ref === "TEST") {
      return {
        path: "TEST",
        name: "TEST",
        secretId: "secret-1",
        secretKey: new Uint8Array(32),
        source: "share",
      };
    }
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
    if (entry.secretId === "secret-1") {
      return { password: "value-1" };
    }
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

function makeBackend(): {
  backend: PsonoCredentialBackend;
  records: MemoryRecords;
} {
  const client = new FakeClient();
  const tree = new FakeTree(client);
  const records = new MemoryRecords([record]);
  return {
    backend: new PsonoCredentialBackend({ client, tree, records }),
    records,
  };
}

function makeKeyBackend(): SecureKeyBackend {
  const store = new Map<string, string>([["credential/demo/password", "value-1"]]);
  return {
    get: async (account: string) => store.get(account),
    set: async (account: string, value: string) => {
      store.set(account, value);
      return true;
    },
    delete: async (account: string) => {
      if (!store.has(account)) {
        return "not-found";
      }
      store.delete(account);
      return "deleted";
    },
    list: async () => [...store.keys()],
  };
}

function request(
  path: string,
  init: { method?: string; token?: string; body?: string } = {},
): Request {
  const headers: Record<string, string> = {};
  if (init.token !== undefined) {
    headers["authorization"] = `Bearer ${init.token}`;
  }
  return new Request(`http://ces${path}`, {
    method: init.method ?? "GET",
    headers,
    body: init.body,
  });
}

type Endpoint = (token: string | undefined) => Promise<Response | null>;

function endpoints(): Record<string, Endpoint> {
  return {
    "GET /v1/resolve": async (token) => {
      const { backend } = makeBackend();
      return handleResolveRoute(request("/v1/resolve/demo/password", { token }), {
        backend,
        tokens: TOKENS,
      });
    },
    "GET /v1/files": async (token) => {
      const { backend } = makeBackend();
      return handleFileRoute(request("/v1/files/demo/password", { token }), {
        backend,
        tokens: TOKENS,
      });
    },
    "PUT /v1/files": async (token) => {
      const { backend, records } = makeBackend();
      return handleFileRoute(
        request("/v1/files/demo/blob", { method: "PUT", token, body: "bytes" }),
        { backend, records, tokens: TOKENS },
      );
    },
    "GET /v1/credentials": async (token) =>
      handleCredentialRoute(
        request("/v1/credentials/credential/demo/password", { token }),
        { backend: makeKeyBackend(), tokens: TOKENS },
      ),
    "POST /v1/credentials": async (token) =>
      handleCredentialRoute(
        request("/v1/credentials/credential/demo/other", {
          method: "POST",
          token,
          body: JSON.stringify({ value: "value" }),
        }),
        { backend: makeKeyBackend(), tokens: TOKENS },
      ),
    "GET /v1/metadata": async (token) => {
      initMetadataStore(mkdtempSync(join(tmpdir(), "ces-capability-")));
      return handleMetadataRoute(request("/v1/metadata", { token }));
    },
  };
}

describe("capability matrix", () => {
  afterEach(() => {
    resetMetadataStoreForTests();
    delete process.env.CES_SERVICE_TOKEN;
    delete process.env.CES_READ_TOKEN;
    delete process.env.CES_WRITE_TOKEN;
  });

  test("read token: reads only", async () => {
    process.env.CES_SERVICE_TOKEN = SERVICE_TOKEN;
    process.env.CES_READ_TOKEN = READ_TOKEN;
    process.env.CES_WRITE_TOKEN = WRITE_TOKEN;
    const table = endpoints();
    const expected: Record<string, number> = {
      "GET /v1/resolve": 200,
      "GET /v1/files": 200,
      "PUT /v1/files": 403,
      "GET /v1/credentials": 403,
      "POST /v1/credentials": 403,
      "GET /v1/metadata": 403,
    };
    for (const [name, call] of Object.entries(table)) {
      const response = await call(READ_TOKEN);
      expect({ name, status: response!.status }).toEqual({
        name,
        status: expected[name]!,
      });
    }
  });

  test("write token: reads and file writes, never the admin surface", async () => {
    process.env.CES_SERVICE_TOKEN = SERVICE_TOKEN;
    process.env.CES_READ_TOKEN = READ_TOKEN;
    process.env.CES_WRITE_TOKEN = WRITE_TOKEN;
    const table = endpoints();
    const expected: Record<string, number> = {
      "GET /v1/resolve": 200,
      "GET /v1/files": 200,
      "PUT /v1/files": 200,
      "GET /v1/credentials": 403,
      "POST /v1/credentials": 403,
      "GET /v1/metadata": 403,
    };
    for (const [name, call] of Object.entries(table)) {
      const response = await call(WRITE_TOKEN);
      expect({ name, status: response!.status }).toEqual({
        name,
        status: expected[name]!,
      });
    }
  });

  test("service token: every endpoint", async () => {
    process.env.CES_SERVICE_TOKEN = SERVICE_TOKEN;
    process.env.CES_READ_TOKEN = READ_TOKEN;
    process.env.CES_WRITE_TOKEN = WRITE_TOKEN;
    for (const [name, call] of Object.entries(endpoints())) {
      const response = await call(SERVICE_TOKEN);
      expect({ name, status: response!.status }).toEqual({ name, status: 200 });
    }
  });

  test("no token is rejected everywhere", async () => {
    for (const [name, call] of Object.entries(endpoints())) {
      const missing = await call(undefined);
      expect({ name, status: missing!.status }).toEqual({ name, status: 401 });
    }
  });

  test("an unknown token is rejected everywhere", async () => {
    process.env.CES_SERVICE_TOKEN = SERVICE_TOKEN;
    process.env.CES_READ_TOKEN = READ_TOKEN;
    process.env.CES_WRITE_TOKEN = WRITE_TOKEN;
    // The read/file surface has always answered 401 for an unknown bearer; the
    // admin surface has always answered 403. Both are unchanged.
    const unknownStatus: Record<string, number> = {
      "GET /v1/resolve": 401,
      "GET /v1/files": 401,
      "PUT /v1/files": 401,
      "GET /v1/credentials": 403,
      "POST /v1/credentials": 403,
      "GET /v1/metadata": 403,
    };
    for (const [name, call] of Object.entries(endpoints())) {
      const unknown = await call("not-a-token");
      expect({ name, status: unknown!.status }).toEqual({
        name,
        status: unknownStatus[name]!,
      });
    }
  });
});

describe("denial codes", () => {
  test("the code names the presented token class", async () => {
    const { backend, records } = makeBackend();
    const response = await handleFileRoute(
      request("/v1/files/demo/blob", {
        method: "PUT",
        token: READ_TOKEN,
        body: "bytes",
      }),
      { backend, records, tokens: TOKENS },
    );
    expect(response!.status).toBe(403);
    expect(await response!.json()).toEqual({
      error: "read_only_token",
      presented: "read",
      required: "write",
    });
  });

  test("read token on the admin surface answers read_only_token", async () => {
    initMetadataStore(mkdtempSync(join(tmpdir(), "ces-capability-")));
    process.env.CES_SERVICE_TOKEN = SERVICE_TOKEN;
    process.env.CES_READ_TOKEN = READ_TOKEN;
    const response = await handleMetadataRoute(
      request("/v1/metadata", { token: READ_TOKEN }),
    );
    expect(response!.status).toBe(403);
    expect(await response!.json()).toEqual({
      error: "read_only_token",
      presented: "read",
      required: "service",
    });
  });

  test("write token on the admin surface answers write_scope_required", async () => {
    process.env.CES_SERVICE_TOKEN = SERVICE_TOKEN;
    process.env.CES_WRITE_TOKEN = WRITE_TOKEN;
    const response = await handleCredentialRoute(
      request("/v1/credentials/credential/demo/password", { token: WRITE_TOKEN }),
      { backend: makeKeyBackend(), tokens: TOKENS },
    );
    expect(response!.status).toBe(403);
    expect(await response!.json()).toEqual({
      error: "write_scope_required",
      presented: "write",
      required: "service",
    });
  });
});

describe("fail-closed", () => {
  const none: CesTokens = { read: "", write: "", service: "" };

  test("no configured token closes every capability endpoint", async () => {
    for (const required of ["read", "write", "service"] as const) {
      const response = authorize(request("/v1/x", { token: "anything" }), none, required);
      expect(response!.status).toBe(503);
      expect(await response!.json()).toEqual({
        error: "token_not_configured",
        required,
      });
    }
    const admin = authorizeService(request("/v1/metadata", { token: "x" }), none);
    expect(admin!.status).toBe(503);
  });

  test("a configured token covers only its own capability", () => {
    const readOnly: CesTokens = { read: READ_TOKEN, write: "", service: "" };
    expect(authorize(request("/v1/x", { token: READ_TOKEN }), readOnly, "read")).toBeNull();
    expect(
      authorize(request("/v1/x", { token: READ_TOKEN }), readOnly, "write")!.status,
    ).toBe(403);
    expect(
      authorize(request("/v1/x", { token: READ_TOKEN }), readOnly, "service")!.status,
    ).toBe(403);
  });

  test("the service token still covers every capability", () => {
    const serviceOnly: CesTokens = { read: "", write: "", service: SERVICE_TOKEN };
    for (const required of ["read", "write", "service"] as const) {
      expect(
        authorize(request("/v1/x", { token: SERVICE_TOKEN }), serviceOnly, required),
      ).toBeNull();
    }
    expect(
      authorizeService(request("/v1/metadata", { token: SERVICE_TOKEN }), serviceOnly),
    ).toBeNull();
  });
});

describe("token parsing", () => {
  test("classifies the strongest matching class", () => {
    const req = request("/v1/x", { token: WRITE_TOKEN });
    expect(classifyToken(req, TOKENS)).toBe("write");
    expect(classifyToken(request("/v1/x", { token: READ_TOKEN }), TOKENS)).toBe("read");
    expect(
      classifyToken(request("/v1/x", { token: SERVICE_TOKEN }), TOKENS),
    ).toBe("service");
    expect(classifyToken(request("/v1/x"), TOKENS)).toBeNull();
  });

  test("reads the tokens from the environment and trims them", () => {
    const env = {
      CES_READ_TOKEN: " read ",
      CES_WRITE_TOKEN: "write",
      CES_SERVICE_TOKEN: undefined,
    };
    expect(readTokensFromEnv(env)).toEqual({
      read: "read",
      write: "write",
      service: "",
    });
  });
});
