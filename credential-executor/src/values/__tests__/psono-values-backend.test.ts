import { describe, expect, test } from "bun:test";

import type { CredentialRecord } from "@vellumai/service-contracts/credential-rpc";

import { PsonoError } from "../../psono/errors.js";
import type { SecretPayload } from "../../psono/types.js";
import {
  parseCredentialAccount,
  type CesMetadataStore,
} from "../../records/metadata-store.js";
import {
  PsonoValuesBackend,
  VALUE_SOURCE_FIELD,
  type PsonoValuesSource,
} from "../psono-values-backend.js";

class InMemoryRecords {
  private readonly rows = new Map<string, CredentialRecord>();

  getByAccount(account: string): CredentialRecord | undefined {
    return this.rows.get(account);
  }

  setByAccount(account: string, record: CredentialRecord): boolean {
    const parsed = parseCredentialAccount(account);
    if (!parsed) {
      return false;
    }
    this.rows.set(account, { ...record });
    return true;
  }

  deleteByAccount(account: string): "deleted" | "not-found" {
    return this.rows.delete(account) ? "deleted" : "not-found";
  }

  list(): Array<{ account: string; record: CredentialRecord }> {
    return [...this.rows.entries()].map(([account, record]) => ({
      account,
      record,
    }));
  }

  seed(record: CredentialRecord): void {
    this.rows.set(`credential/${record.service}/${record.field}`, record);
  }
}

class FakePsono implements PsonoValuesSource {
  readonly entries = new Map<string, SecretPayload>();
  readonly deleted: string[] = [];
  readonly kinds: Array<string | undefined> = [];
  invalidations = 0;

  async resolve(service: string, field: string): Promise<{ value: string }> {
    const payload = this.entries.get(`${service}/${field}`);
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
    records: InMemoryRecords;
    backend: PsonoValuesBackend;
  } {
    const psono = new FakePsono();
    const records = new InMemoryRecords();
    const backend = new PsonoValuesBackend({
      psono,
      records: records as unknown as CesMetadataStore,
      now: () => 1_000,
    });
    return { psono, records, backend };
  }

  test("get returns undefined without a record or a ref", async () => {
    const { backend } = setup();
    expect(await backend.get("credential/demo/missing")).toBeUndefined();
  });

  test("get returns undefined when the entry is missing", async () => {
    const { records, backend } = setup();
    records.seed({
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
    records.seed({
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
    records.seed({
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

  test("set rejects a malformed account", async () => {
    const { backend } = setup();
    expect(await backend.set("demo/token", "v")).toBe(false);
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

  test("delete succeeds when the Psono entry is already gone", async () => {
    const { records, backend } = setup();
    const account = "credential/ces/write-test";
    records.seed({
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
    records.seed({
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
    records.seed({
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
