import { describe, expect, test } from "bun:test";

import type { CredentialRecord } from "@vellumai/service-contracts/credential-rpc";

import {
  PsonoCredentialBackend,
  type PsonoStatusSource,
  type PsonoTreeSource,
  type RecordSource,
} from "../backend.js";
import { denied, PsonoError } from "../errors.js";
import type { PsonoEntry } from "../tree.js";
import type { SecretPayload } from "../types.js";

function record(
  service: string,
  field: string,
  ref: string | undefined,
  kind?: "value" | "file" | "json",
): CredentialRecord {
  const now = 1;
  return {
    credentialId: `${service}-${field}`,
    service,
    field,
    ...(ref === undefined ? {} : { ref }),
    ...(kind === undefined ? {} : { kind }),
    allowedTools: [],
    allowedDomains: [],
    createdAt: now,
    updatedAt: now,
  };
}

class FakeRecords implements RecordSource {
  constructor(private readonly rows: CredentialRecord[]) {}

  getByAccount(account: string): CredentialRecord | undefined {
    return this.rows.find(
      (row) => account === `credential/${row.service}/${row.field}`,
    );
  }

  list(): Array<{ account: string; record: CredentialRecord }> {
    return this.rows.map((row) => ({
      account: `credential/${row.service}/${row.field}`,
      record: row,
    }));
  }
}

class FakeTree implements PsonoTreeSource {
  reads = 0;
  invalidations = 0;
  payload: SecretPayload = { password: "value-1" };
  failure?: PsonoError;

  async find(ref: string): Promise<PsonoEntry> {
    if (ref !== "TEST") {
      throw new PsonoError("not_found", "missing");
    }
    return {
      path: "TEST",
      name: "TEST",
      secretId: "secret-1",
      secretKey: new Uint8Array(32),
      source: "share",
    };
  }

  async readPayload(): Promise<SecretPayload> {
    this.reads += 1;
    if (this.failure) {
      throw this.failure;
    }
    return this.payload;
  }

  invalidate(): void {
    this.invalidations += 1;
  }
}

const status: PsonoStatusSource = {
  getStatus: () => ({
    configured: true,
    sessionOpen: true,
    lastRefresh: "2026-01-01T00:00:00.000Z",
    lastError: null,
  }),
};

function backendWith(
  rows: CredentialRecord[],
  tree: FakeTree,
  now: () => number = () => 0,
): PsonoCredentialBackend {
  return new PsonoCredentialBackend({
    client: status,
    tree,
    records: new FakeRecords(rows),
    now,
  });
}

describe("PsonoCredentialBackend", () => {
  test("resolves a service/field through the record ref", async () => {
    const backend = backendWith(
      [record("demo", "password", "TEST")],
      new FakeTree(),
    );
    await expect(backend.resolve("demo", "password")).resolves.toEqual({
      value: "value-1",
      kind: "value",
      ref: "TEST",
    });
  });

  test("selects a type-prefixed field by suffix", async () => {
    const tree = new FakeTree();
    tree.payload = { website_password_password: "value-2", tags: ["x"] };
    const backend = backendWith([record("demo", "password", "TEST")], tree);
    expect((await backend.resolve("demo", "password")).value).toBe("value-2");
  });

  test("serves a json record as the whole payload", async () => {
    const tree = new FakeTree();
    tree.payload = { a: "1", b: "2" };
    const backend = backendWith([record("demo", "blob", "TEST", "json")], tree);
    expect((await backend.resolve("demo", "blob")).value).toBe(
      JSON.stringify({ a: "1", b: "2" }),
    );
  });

  test("returns not_found when the record has no ref", async () => {
    const backend = backendWith([record("demo", "password", undefined)], new FakeTree());
    await expect(backend.resolve("demo", "password")).rejects.toMatchObject({
      kind: "not_found",
    });
  });

  test("returns not_found for an unknown ref", async () => {
    const backend = backendWith([record("demo", "password", "OTHER")], new FakeTree());
    await expect(backend.resolve("demo", "password")).rejects.toMatchObject({
      kind: "not_found",
    });
  });

  test("propagates a denied error from Psono", async () => {
    const tree = new FakeTree();
    tree.failure = denied();
    const backend = backendWith([record("demo", "password", "TEST")], tree);
    await expect(backend.resolve("demo", "password")).rejects.toMatchObject({
      kind: "denied",
    });
  });

  test("caches payloads for 60 seconds", async () => {
    let now = 0;
    const tree = new FakeTree();
    const backend = backendWith(
      [record("demo", "password", "TEST")],
      tree,
      () => now,
    );

    await backend.resolve("demo", "password");
    await backend.resolve("demo", "password");
    expect(tree.reads).toBe(1);

    now += 60_001;
    await backend.resolve("demo", "password");
    expect(tree.reads).toBe(2);
  });

  test("getByRef returns the whole payload for a mapped ref", async () => {
    const tree = new FakeTree();
    tree.payload = { api_key: "abc" };
    const backend = backendWith([record("demo", "api_key", "TEST")], tree);
    await expect(backend.getByRef("TEST")).resolves.toEqual({ api_key: "abc" });
  });

  test("invalidate clears the caches and the tree", async () => {
    const tree = new FakeTree();
    const backend = backendWith([record("demo", "password", "TEST")], tree);
    await backend.resolve("demo", "password");
    backend.invalidate();
    await backend.resolve("demo", "password");
    expect(tree.reads).toBe(2);
    expect(tree.invalidations).toBe(1);
  });
});
