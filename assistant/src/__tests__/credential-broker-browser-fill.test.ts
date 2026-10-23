import { randomBytes } from "node:crypto";
import { mkdirSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  afterAll,
  afterEach,
  beforeAll,
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
  `vellum-broker-fill-test-${randomBytes(4).toString("hex")}`,
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

afterAll(() => {
  mock.restore();
});

describe("CredentialBroker.browserFill", () => {
  let broker: CredentialBroker;

  beforeAll(() => {
    mkdirSync(TEST_DIR, { recursive: true });
  });

  beforeEach(() => {
    // Clear content files but preserve the directory structure
    for (const entry of readdirSync(TEST_DIR)) {
      rmSync(join(TEST_DIR, entry), { recursive: true, force: true });
    }
    setStorePathForTesting(STORE_PATH);
    _resetBackend();
    _setMetadataPath(join(TEST_DIR, "metadata.json"));
    broker = new CredentialBroker();
  });

  afterEach(() => {
    _setMetadataPath(null);
    setStorePathForTesting(null);
    _resetBackend();
  });

  afterAll(() => {
    rmSync(TEST_DIR, { recursive: true, force: true });
  });

  test("fills successfully when credential exists", async () => {
    upsertCredentialMetadata("github", "token");
    await setSecureKeyAsync(credentialKey("github", "token"), "ghp_secret123");

    let filledValue: string | undefined;
    const result = await broker.browserFill({
      service: "github",
      field: "token",
      toolName: "browser_fill_credential",
      fill: async (value) => {
        filledValue = value;
      },
    });

    expect(result.success).toBe(true);
    expect(result.reason).toBeUndefined();
    // The fill callback received the plaintext
    expect(filledValue).toBe("ghp_secret123");
  });

  test("returns metadata-only result (no plaintext in return value)", async () => {
    upsertCredentialMetadata("github", "token");
    await setSecureKeyAsync(credentialKey("github", "token"), "ghp_secret123");

    const result = await broker.browserFill({
      service: "github",
      field: "token",
      toolName: "browser_fill_credential",
      fill: async () => {},
    });

    // Result has no plaintext value — only success/failure metadata
    expect(result).toEqual({ success: true });
    expect("value" in result).toBe(false);
    expect("storageKey" in result).toBe(false);
  });

  test("fails when no credential metadata exists", async () => {
    const result = await broker.browserFill({
      service: "nonexistent",
      field: "token",
      toolName: "browser_fill_credential",
      fill: async () => {
        throw new Error("should not be called");
      },
    });

    expect(result.success).toBe(false);
    expect(result.reason).toContain("No credential found");
    expect(result.reason).toContain("nonexistent/token");
  });

  test("fails when metadata exists but no stored secret value", async () => {
    upsertCredentialMetadata("github", "token");
    // No setSecureKeyAsync call — metadata exists but value doesn't

    const result = await broker.browserFill({
      service: "github",
      field: "token",
      toolName: "browser_fill_credential",
      fill: async () => {
        throw new Error("should not be called");
      },
    });

    expect(result.success).toBe(false);
    expect(result.reason).toContain("no stored value");
  });

  test("returns failure when fill callback throws", async () => {
    upsertCredentialMetadata("github", "token");
    await setSecureKeyAsync(credentialKey("github", "token"), "ghp_secret123");

    const result = await broker.browserFill({
      service: "github",
      field: "token",
      toolName: "browser_fill_credential",
      fill: async () => {
        throw new Error("Element not found");
      },
    });

    expect(result.success).toBe(false);
    expect(result.reason).toContain("Fill operation failed");
    // The broker intentionally returns a generic error — the original error
    // message is NOT included because it could embed the credential value,
    // leaking plaintext outside the broker's trust boundary.
    expect(result.reason).not.toContain("Element not found");
  });

  test("handles multiple fills with different credentials", async () => {
    upsertCredentialMetadata("github", "username");
    upsertCredentialMetadata("github", "password");
    await setSecureKeyAsync(credentialKey("github", "username"), "octocat");
    await setSecureKeyAsync(credentialKey("github", "password"), "hunter2");

    const filled: Record<string, string> = {};

    const r1 = await broker.browserFill({
      service: "github",
      field: "username",
      toolName: "browser_fill_credential",
      fill: async (v) => {
        filled.username = v;
      },
    });

    const r2 = await broker.browserFill({
      service: "github",
      field: "password",
      toolName: "browser_fill_credential",
      fill: async (v) => {
        filled.password = v;
      },
    });

    expect(r1.success).toBe(true);
    expect(r2.success).toBe(true);
    expect(filled.username).toBe("octocat");
    expect(filled.password).toBe("hunter2");
  });

  test("fill callback error does not leak plaintext in result", async () => {
    upsertCredentialMetadata("github", "token");
    await setSecureKeyAsync(
      credentialKey("github", "token"),
      "ghp_supersecret",
    );

    const result = await broker.browserFill({
      service: "github",
      field: "token",
      toolName: "browser_fill_credential",
      fill: async () => {
        throw new Error("timeout");
      },
    });

    expect(result.success).toBe(false);
    // Ensure the secret value doesn't appear in the error result
    expect(JSON.stringify(result)).not.toContain("ghp_supersecret");
  });

  // ---------------------------------------------------------------------------
  // Baseline: tool/domain policy mismatch deny behavior
  // ---------------------------------------------------------------------------

  describe("service/field uniqueness", () => {
    test("same service with different fields are independent credentials", async () => {
      upsertCredentialMetadata("github", "username");
      upsertCredentialMetadata("github", "password");
      await setSecureKeyAsync(credentialKey("github", "username"), "octocat");
      await setSecureKeyAsync(credentialKey("github", "password"), "hunter2");

      let u = "";
      const r1 = await broker.browserFill({
        service: "github",
        field: "username",
        toolName: "browser_fill_credential",
        fill: async (v) => {
          u = v;
        },
      });
      expect(r1.success).toBe(true);
      expect(u).toBe("octocat");

      let p = "";
      const r2 = await broker.browserFill({
        service: "github",
        field: "password",
        toolName: "browser_fill_credential",
        fill: async (v) => {
          p = v;
        },
      });
      expect(r2.success).toBe(true);
      expect(p).toBe("hunter2");
    });

    test("different services with same field name are independent", async () => {
      upsertCredentialMetadata("github", "token");
      upsertCredentialMetadata("gitlab", "token");
      await setSecureKeyAsync(credentialKey("github", "token"), "gh_tok");
      await setSecureKeyAsync(credentialKey("gitlab", "token"), "gl_tok");

      let gh = "";
      const r1 = await broker.browserFill({
        service: "github",
        field: "token",
        toolName: "browser_fill_credential",
        domain: "github.com",
        fill: async (v) => {
          gh = v;
        },
      });
      expect(r1.success).toBe(true);
      expect(gh).toBe("gh_tok");

      let gl = "";
      const r2 = await broker.browserFill({
        service: "gitlab",
        field: "token",
        toolName: "browser_fill_credential",
        domain: "gitlab.com",
        fill: async (v) => {
          gl = v;
        },
      });
      expect(r2.success).toBe(true);
      expect(gl).toBe("gl_tok");
    });
  });
});
