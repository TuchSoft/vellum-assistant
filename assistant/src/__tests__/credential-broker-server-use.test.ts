import { randomBytes } from "node:crypto";
import { mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  afterAll,
  afterEach,
  beforeEach,
  describe,
  expect,
  mock,
  test,
} from "bun:test";

// ---------------------------------------------------------------------------
// Mock logger
// ---------------------------------------------------------------------------
// ---------------------------------------------------------------------------
// Use encrypted backend with a temp store path
// ---------------------------------------------------------------------------
import { _resetBackend } from "../security/secure-keys.js";
import { setStorePathForTesting } from "./encrypted-store-test-helpers.js";

const TEST_DIR = join(
  tmpdir(),
  `vellum-broker-server-use-test-${randomBytes(4).toString("hex")}`,
);
const STORE_PATH = join(TEST_DIR, "keys.enc");

// ---------------------------------------------------------------------------
// Mock registry to avoid double-registration
// ---------------------------------------------------------------------------

mock.module("../tools/registry.js", () => ({
  registerTool: () => {},
}));

// ---------------------------------------------------------------------------
// Imports under test
// ---------------------------------------------------------------------------

import { credentialKey } from "../security/credential-key.js";
import { setSecureKeyAsync } from "../security/secure-keys.js";
import { CredentialBroker } from "../tools/credentials/broker.js";
import {
  _setMetadataPath,
  upsertCredentialMetadata,
} from "../tools/credentials/metadata-store.js";

// ---------------------------------------------------------------------------
// Tests — serverUse (publish_page / unpublish_page regression)
// ---------------------------------------------------------------------------

afterAll(() => {
  mock.restore();
});

describe("CredentialBroker.serverUse", () => {
  let broker: CredentialBroker;

  beforeEach(() => {
    mkdirSync(TEST_DIR, { recursive: true });
    setStorePathForTesting(STORE_PATH);
    _resetBackend();
    _setMetadataPath(join(TEST_DIR, "metadata.json"));
    broker = new CredentialBroker();
  });

  afterEach(() => {
    _setMetadataPath(null);
    setStorePathForTesting(null);
    _resetBackend();
    rmSync(TEST_DIR, { recursive: true, force: true });
  });

  test("executes callback with credential value and returns result", async () => {
    upsertCredentialMetadata("vercel", "api_token", {});
    await setSecureKeyAsync(
      credentialKey("vercel", "api_token"),
      "test-vercel-token",
    );

    const result = await broker.serverUse({
      service: "vercel",
      field: "api_token",
      toolName: "publish_page",
      execute: async (token) => {
        // Verify the callback receives the actual secret
        expect(token).toBe("test-vercel-token");
        return { deploymentId: "dpl_123", url: "https://example.vercel.app" };
      },
    });

    expect(result.success).toBe(true);
    expect(result.result).toEqual({
      deploymentId: "dpl_123",
      url: "https://example.vercel.app",
    });
  });

  test("denies when no credential metadata exists", async () => {
    const result = await broker.serverUse({
      service: "vercel",
      field: "api_token",
      toolName: "publish_page",
      execute: async () => {
        throw new Error("should not be called");
      },
    });

    expect(result.success).toBe(false);
    expect(result.reason).toContain("No credential found");
  });

  test("denies when credential has no stored value", async () => {
    upsertCredentialMetadata("vercel", "api_token", {});
    // No setSecureKeyAsync — metadata exists but value doesn't

    const result = await broker.serverUse({
      service: "vercel",
      field: "api_token",
      toolName: "publish_page",
      execute: async () => {
        throw new Error("should not be called");
      },
    });

    expect(result.success).toBe(false);
    expect(result.reason).toContain("no stored value");
  });

  test("returns generic error when callback throws (no secret leakage)", async () => {
    upsertCredentialMetadata("vercel", "api_token", {});
    await setSecureKeyAsync(
      credentialKey("vercel", "api_token"),
      "test-vercel-token",
    );

    const result = await broker.serverUse({
      service: "vercel",
      field: "api_token",
      toolName: "publish_page",
      execute: async () => {
        throw new Error("Vercel API 401: invalid token test-vercel-token");
      },
    });

    expect(result.success).toBe(false);
    // The error message must NOT contain the secret
    expect(result.reason).not.toContain("test-vercel-token");
    expect(result.reason).toBe("Credential use failed");
  });

  test("secret value never appears in the result object", async () => {
    upsertCredentialMetadata("vercel", "api_token", {});
    await setSecureKeyAsync(
      credentialKey("vercel", "api_token"),
      "test-vercel-token",
    );

    const result = await broker.serverUse({
      service: "vercel",
      field: "api_token",
      toolName: "publish_page",
      execute: async () => ({ status: "deployed" }),
    });

    // Serialize the entire result and verify no secret leakage
    const serialized = JSON.stringify(result);
    expect(serialized).not.toContain("test-vercel-token");
  });

  describe("service/field uniqueness", () => {
    test("same service with different fields are independent credentials", async () => {
      upsertCredentialMetadata("vercel", "api_token");
      upsertCredentialMetadata("vercel", "deploy_hook");
      await setSecureKeyAsync(credentialKey("vercel", "api_token"), "tok_api");
      await setSecureKeyAsync(
        credentialKey("vercel", "deploy_hook"),
        "hook_secret",
      );

      const r1 = await broker.serverUse({
        service: "vercel",
        field: "api_token",
        toolName: "trigger_deploy",
        execute: async (v) => v,
      });
      expect(r1.success).toBe(true);
      expect(r1.result).toBe("tok_api");

      const r2 = await broker.serverUse({
        service: "vercel",
        field: "deploy_hook",
        toolName: "trigger_deploy",
        execute: async (v) => v,
      });
      expect(r2.success).toBe(true);
      expect(r2.result).toBe("hook_secret");
    });

    test("different services with same field name are independent", async () => {
      upsertCredentialMetadata("github", "api_token");
      upsertCredentialMetadata("gitlab", "api_token");
      await setSecureKeyAsync(credentialKey("github", "api_token"), "gh_tok");
      await setSecureKeyAsync(credentialKey("gitlab", "api_token"), "gl_tok");

      const r1 = await broker.serverUse({
        service: "github",
        field: "api_token",
        toolName: "gitlab_api",
        execute: async (v) => v,
      });
      expect(r1.success).toBe(true);
      expect(r1.result).toBe("gh_tok");

      const r2 = await broker.serverUse({
        service: "gitlab",
        field: "api_token",
        toolName: "gitlab_api",
        execute: async (v) => v,
      });
      expect(r2.success).toBe(true);
      expect(r2.result).toBe("gl_tok");
    });
  });
});
