import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, test } from "bun:test";

import { stripCredentialPolicyFieldsMigration } from "../166-strip-credential-policy-fields.js";

function workspaceWithMetadata(metadata: unknown): string {
  const dir = mkdtempSync(join(tmpdir(), "strip-credential-policy-"));
  const metadataDir = join(dir, "data", "credentials");
  mkdirSync(metadataDir, { recursive: true });
  writeFileSync(
    join(metadataDir, "metadata.json"),
    JSON.stringify(metadata, null, 2),
  );
  return dir;
}

function readMetadata(dir: string): {
  credentials: Array<Record<string, unknown>>;
} {
  return JSON.parse(
    readFileSync(join(dir, "data", "credentials", "metadata.json"), "utf8"),
  ) as { credentials: Array<Record<string, unknown>> };
}

describe("166-strip-credential-policy-fields", () => {
  test("removes allowedTools and allowedDomains from each record", () => {
    const dir = workspaceWithMetadata({
      version: 5,
      credentials: [
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
      ],
    });

    stripCredentialPolicyFieldsMigration.run(dir);

    expect(readMetadata(dir).credentials[0]).toEqual({
      credentialId: "cred-1",
      service: "github",
      field: "token",
      usageDescription: "GitHub login",
      createdAt: 1,
      updatedAt: 1,
    });
  });

  test("is a no-op when the file is missing", () => {
    const dir = mkdtempSync(join(tmpdir(), "strip-credential-policy-"));
    expect(() => stripCredentialPolicyFieldsMigration.run(dir)).not.toThrow();
  });

  test("is idempotent", () => {
    const dir = workspaceWithMetadata({
      version: 5,
      credentials: [
        {
          credentialId: "cred-1",
          service: "github",
          field: "token",
          allowedTools: [],
          createdAt: 1,
          updatedAt: 1,
        },
      ],
    });

    stripCredentialPolicyFieldsMigration.run(dir);
    const once = readMetadata(dir);
    stripCredentialPolicyFieldsMigration.run(dir);
    expect(readMetadata(dir)).toEqual(once);
  });
});
