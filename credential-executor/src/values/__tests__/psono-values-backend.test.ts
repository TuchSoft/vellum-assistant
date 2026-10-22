import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, test } from "bun:test";

import type { CredentialRecord } from "@vellumai/service-contracts/credential-rpc";

import { PsonoError } from "../../psono/errors.js";
import { defaultStackRef } from "../../psono/refs.js";
import type { SecretPayload } from "../../psono/types.js";
import {
  accountForRecord,
  CesMetadataStore,
  getMetadataPath,
  parseCredentialAccount,
} from "../../records/metadata-store.js";
import {
  PsonoValuesBackend,
  VALUE_SOURCE_FIELD,
  type PsonoValuesSource,
} from "../psono-values-backend.js";

class FakePsono implements PsonoValuesSource {
  readonly entries = new Map<string, SecretPayload>();
  readonly deleted: string[] = [];
  readonly kinds: Array<string | undefined> = [];
  invalidations = 0;

  async resolve(service: string, field: string): Promise<{ value: string }> {
    // Records name the entry by ref; legacy tests seed the `service/field` key.
    const payload =
      this.entries.get(defaultStackRef(service, field)) ??
      this.entries.get(`${service}/${field}`);
    const value = payload?.["password"];
    if (typeof value !== "string") {
      throw new PsonoError("not_found", "missing");
    }
    return { value };
  }

  async resolveFile(): Promise<{ bytes: Uint8Array }> {
    throw new PsonoError("not_found", "missing");
  }

  async createEntry(
    ref: string,
    fields: SecretPayload,
    kind?: "value" | "file" | "json",
  ): Promise<{ created: boolean }> {
    const existing = this.entries.has(ref);
    this.entries.set(ref, { ...(this.entries.get(ref) ?? {}), ...fields });
    this.kinds.push(kind);
    return { created: !existing };
  }

  async deleteEntry(ref: string): Promise<{ deleted: boolean }> {
    const deleted = this.entries.delete(ref);
    this.deleted.push(ref);
    return { deleted };
  }

  invalidate(): void {
    this.invalidations += 1;
  }
}

describe("parseCredentialAccount", () => {
  test("splits service and field", () => {
    expect(parseCredentialAccount("credential/vellum/webhook_secret")).toEqual({
      service: "vellum",
      field: "webhook_secret",
    });
  });
});

describe("PsonoValuesBackend", () => {
  function setup(): {
    psono: FakePsono;
    records: CesMetadataStore;
    backend: PsonoValuesBackend;
  } {
    const psono = new FakePsono();
    const dir = mkdtempSync(join(tmpdir(), "ces-values-"));
    const records = new CesMetadataStore(getMetadataPath(dir));
    const backend = new PsonoValuesBackend({
      psono,
      records,
      now: () => 1_000,
    });
    return { psono, records, backend };
  }

  function seed(records: CesMetadataStore, record: CredentialRecord): void {
    const account = record.account ?? accountForRecord(record);
    expect(records.setByAccount(account, record)).toBe(true);
  }

  test("get returns undefined without a record", async () => {
    const { backend } = setup();
    expect(await backend.get("credential/demo/missing")).toBeUndefined();
  });

  test("get returns undefined when the record has no ref", async () => {
    const { records, backend } = setup();
    seed(records, {
      credentialId: "c1",
      service: "demo",
      field: "token",
      kind: "value",
      allowedTools: [],
      allowedDomains: [],
      createdAt: 1,
      updatedAt: 1,
    });
    expect(await backend.get("credential/demo/token")).toBeUndefined();
  });

  test("get returns undefined when the entry is missing", async () => {
    const { records, backend } = setup();
    seed(records, {
      credentialId: "c1",
      service: "demo",
      field: "token",
      ref: "Joanna-shared/stack/demo-token",
      kind: "value",
      allowedTools: [],
      allowedDomains: [],
      createdAt: 1,
      updatedAt: 1,
    });
    expect(await backend.get("credential/demo/token")).toBeUndefined();
  });

  test("get resolves through the record", async () => {
    const { psono, records, backend } = setup();
    psono.entries.set("demo/token", { password: "secret-value" });
    seed(records, {
      credentialId: "c1",
      service: "demo",
      field: "token",
      ref: "Joanna-shared/stack/demo-token",
      kind: "value",
      sourceField: "password",
      allowedTools: [],
      allowedDomains: [],
      createdAt: 1,
      updatedAt: 1,
    });
    expect(await backend.get("credential/demo/token")).toBe("secret-value");
  });

  test("set upserts the entry and the record, preserving the id", async () => {
    const { psono, records, backend } = setup();
    const account = "credential/openai-compatible-personal-5/api_key";

    expect(await backend.set(account, "first")).toBe(true);
    const first = records.getByAccount(account);
    expect(first?.ref).toBe(
      "Joanna-shared/stack/openai-compatible-personal-5-api-key",
    );
    expect(first?.kind).toBe("value");
    expect(first?.sourceField).toBe(VALUE_SOURCE_FIELD);
    expect(first?.allowedTools).toEqual([]);
    expect(first?.account).toBeUndefined();
    expect(psono.kinds).toEqual(["value"]);

    expect(await backend.set(account, "second")).toBe(true);
    const second = records.getByAccount(account);
    expect(second?.credentialId).toBe(first?.credentialId);
    expect(second?.createdAt).toBe(first?.createdAt);
    expect(second?.updatedAt).toBe(1_000);
    expect(psono.entries.get(first!.ref!)?.["password"]).toBe("second");
  });

  test("set keeps an existing ref instead of relocating the entry", async () => {
    const { psono, records, backend } = setup();
    const account = "credential/demo/token";
    seed(records, {
      credentialId: "c1",
      service: "demo",
      field: "token",
      ref: "Joanna-shared/custom/entry",
      kind: "value",
      allowedTools: [],
      allowedDomains: [],
      createdAt: 1,
      updatedAt: 1,
    });
    expect(await backend.set(account, "v")).toBe(true);
    expect(psono.entries.get("Joanna-shared/custom/entry")?.["password"]).toBe(
      "v",
    );
  });

  test("set accepts an mcp header account and derives a stable ref", async () => {
    const { psono, records, backend } = setup();
    const account = "mcp:tools:headers";

    expect(await backend.set(account, '{"Authorization":"Bearer x"}')).toBe(
      true,
    );
    const record = records.getByAccount(account);
    expect(record?.service).toBe("mcp:tools");
    expect(record?.field).toBe("headers");
    expect(record?.account).toBe(account);
    expect(record?.ref).toBe("Joanna-shared/stack/mcp:tools-headers");
    expect(record?.kind).toBe("value");
    expect(record?.sourceField).toBe(VALUE_SOURCE_FIELD);
    expect(
      psono.entries.get("Joanna-shared/stack/mcp:tools-headers")?.[
        VALUE_SOURCE_FIELD
      ],
    ).toBe('{"Authorization":"Bearer x"}');

    expect(await backend.get(account)).toBe('{"Authorization":"Bearer x"}');
    expect(await backend.list()).toEqual([account]);
  });

  test("set distinguishes mcp servers by account", async () => {
    const { records, backend } = setup();
    expect(await backend.set("mcp:tools:headers", "a")).toBe(true);
    expect(await backend.set("mcp:web:headers", "b")).toBe(true);

    expect(records.getByAccount("mcp:tools:headers")?.ref).toBe(
      "Joanna-shared/stack/mcp:tools-headers",
    );
    expect(records.getByAccount("mcp:web:headers")?.ref).toBe(
      "Joanna-shared/stack/mcp:web-headers",
    );
    expect(await backend.list()).toEqual([
      "mcp:tools:headers",
      "mcp:web:headers",
    ]);
  });

  test("set accepts an OAuth client secret account", async () => {
    const { psono, records, backend } = setup();
    const account = "oauth_app/aaaa-bbbb/client_secret";

    expect(await backend.set(account, "client-secret")).toBe(true);
    const record = records.getByAccount(account);
    expect(record?.service).toBe("oauth_app/aaaa-bbbb");
    expect(record?.field).toBe("client_secret");
    expect(record?.account).toBe(account);
    expect(record?.ref).toBe(
      "Joanna-shared/stack/oauth-app-aaaa-bbbb-client-secret",
    );
    expect(await backend.get(account)).toBe("client-secret");
    expect(psono.deleted).toEqual([]);
  });

  test("an account and its credential-prefixed form share one record", async () => {
    const { records, backend } = setup();
    expect(await backend.set("mcp:tools:headers", "a")).toBe(true);
    expect(await backend.get("credential/mcp:tools/headers")).toBe("a");

    expect(await backend.set("credential/mcp:tools/headers", "b")).toBe(true);
    expect(await backend.get("mcp:tools:headers")).toBe("b");
    expect(records.list()).toHaveLength(1);
    expect(await backend.list()).toEqual(["credential/mcp:tools/headers"]);
  });

  test("set rejects an empty account", async () => {
    const { backend } = setup();
    expect(await backend.set("", "v")).toBe(false);
    expect(await backend.set("   ", "v")).toBe(false);
  });

  test("delete removes the entry and the record", async () => {
    const { psono, records, backend } = setup();
    const account = "credential/ces/write-test";
    await backend.set(account, "v");
    const ref = records.getByAccount(account)!.ref!;

    expect(await backend.delete(account)).toBe("deleted");
    expect(psono.deleted).toEqual([ref]);
    expect(records.getByAccount(account)).toBeUndefined();
    expect(await backend.delete(account)).toBe("not-found");
  });

  test("delete removes an arbitrary account", async () => {
    const { psono, records, backend } = setup();
    const account = "oauth_connection/bbbb/refresh_token";
    await backend.set(account, "refresh");
    const ref = records.getByAccount(account)!.ref!;

    expect(await backend.delete(account)).toBe("deleted");
    expect(psono.deleted).toEqual([ref]);
    expect(psono.entries.has(ref)).toBe(false);
    expect(records.getByAccount(account)).toBeUndefined();
    expect(await backend.list()).toEqual([]);
  });

  test("delete succeeds when the Psono entry is already gone", async () => {
    const { records, backend } = setup();
    const account = "credential/ces/write-test";
    seed(records, {
      credentialId: "c1",
      service: "ces",
      field: "write-test",
      ref: "Joanna-shared/stack/ces-write-test",
      kind: "value",
      allowedTools: [],
      allowedDomains: [],
      createdAt: 1,
      updatedAt: 1,
    });
    expect(await backend.delete(account)).toBe("deleted");
  });

  test("list returns only records that have a ref", async () => {
    const { records, backend } = setup();
    seed(records, {
      credentialId: "c1",
      service: "demo",
      field: "with-ref",
      ref: "Joanna-shared/stack/demo-with-ref",
      kind: "value",
      allowedTools: [],
      allowedDomains: [],
      createdAt: 1,
      updatedAt: 1,
    });
    seed(records, {
      credentialId: "c2",
      service: "demo",
      field: "no-ref",
      kind: "value",
      allowedTools: [],
      allowedDomains: [],
      createdAt: 1,
      updatedAt: 1,
    });
    expect(await backend.list()).toEqual(["credential/demo/with-ref"]);
  });
});
