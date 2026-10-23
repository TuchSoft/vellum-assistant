import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, test } from "bun:test";

import type { SecureKeyBackend } from "@vellumai/credential-storage";

import { stripCredentialPolicyFieldsMigration } from "../migrations/005-strip-credential-policy-fields.js";
import {
  CesMetadataStore,
  getMetadataPath,
} from "../records/metadata-store.js";

const backend: SecureKeyBackend = {
  get: async () => undefined,
  set: async () => true,
  delete: async () => "not-found",
  list: async () => [],
};

let dataDir: string;

beforeEach(() => {
  dataDir = mkdtempSync(join(tmpdir(), "ces-policy-strip-"));
  process.env["CES_MODE"] = "managed";
  process.env["CES_DATA_DIR"] = dataDir;
});

afterEach(() => {
  delete process.env["CES_MODE"];
  delete process.env["CES_DATA_DIR"];
});

function seed(credentials: unknown[]): void {
  writeFileSync(
    getMetadataPath(dataDir),
    JSON.stringify({ version: 5, credentials }, null, 2),
  );
}

function read(): Array<Record<string, unknown>> {
  return (
    JSON.parse(readFileSync(getMetadataPath(dataDir), "utf8")) as {
      credentials: Array<Record<string, unknown>>;
    }
  ).credentials;
}

describe("005-strip-credential-policy-fields", () => {
  test("removes allowedTools and allowedDomains from persisted records", async () => {
    seed([
      {
        credentialId: "cred-1",
        service: "github",
        field: "token",
        allowedTools: ["bash"],
        allowedDomains: ["github.com"],
        usageDescription: "GitHub login",
        createdAt: 1,
        updatedAt: 1,
      },
    ]);

    await stripCredentialPolicyFieldsMigration.run(backend);

    expect(read()[0]).toEqual({
      credentialId: "cred-1",
      service: "github",
      field: "token",
      usageDescription: "GitHub login",
      createdAt: 1,
      updatedAt: 1,
    });
  });

  test("is idempotent", async () => {
    seed([
      {
        credentialId: "cred-1",
        service: "github",
        field: "token",
        allowedTools: [],
        createdAt: 1,
        updatedAt: 1,
      },
    ]);

    await stripCredentialPolicyFieldsMigration.run(backend);
    const once = read();
    await stripCredentialPolicyFieldsMigration.run(backend);
    expect(read()).toEqual(once);
  });

  test("leaves the store usable through the metadata store", async () => {
    seed([
      {
        credentialId: "cred-1",
        service: "github",
        field: "token",
        allowedTools: ["bash"],
        createdAt: 1,
        updatedAt: 1,
      },
    ]);

    await stripCredentialPolicyFieldsMigration.run(backend);

    const store = new CesMetadataStore(getMetadataPath(dataDir));
    expect(store.getByAccount("credential/github/token")?.credentialId).toBe(
      "cred-1",
    );
  });
});
