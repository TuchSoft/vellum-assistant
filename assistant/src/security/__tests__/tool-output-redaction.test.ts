import { afterEach, describe, expect, test } from "bun:test";

import { redactToolOutput } from "../tool-output-redaction.js";
import {
  _resetVaultRegistryForTests,
  refreshVaultRegistry,
  type VaultSnapshotSource,
} from "../vault-secret-registry.js";

/** Synthetic AWS-shaped key (AKIA + 16 uppercase chars, not a real credential). */
const AWS_KEY = "AKIAABCDEFGHIJKLMNOP";

/** Vault-shaped values used across the tests (generic, not real credentials). */
const VAULT_VALUE = "sk-vault-abcdef12345678";
const OPAQUE_VALUE = "opaque-token-without-any-known-prefix";

function vaultSource(entries: Record<string, string>): VaultSnapshotSource {
  return {
    async listAccounts() {
      return { accounts: Object.keys(entries), unreachable: false };
    },
    async getValue(account: string) {
      return { value: entries[account], unreachable: false };
    },
  };
}

/** Module-scope reset so no test triggers a real secure-backend read. */
_resetVaultRegistryForTests();

afterEach(() => {
  _resetVaultRegistryForTests();
});

describe("redactToolOutput", () => {
  test("clean text passes through unchanged", () => {
    const result = redactToolOutput("just some output\nwith lines");
    expect(result.text).toBe("just some output\nwith lines");
    expect(result.redactedCount).toBe(0);
    expect(result.vaultCount).toBe(0);
  });

  test("a scanner-known secret gets the unified marker with pattern head, suffix, hash", () => {
    const result = redactToolOutput(`key: ${AWS_KEY} done`);
    expect(result.text).toBe(
      'key: <redacted type="AWS Access Key" prefix="AKIA…" suffix="…OP" length="20" hash="69ae1ddb" /> done',
    );
    expect(result.redactedCount).toBe(1);
    expect(result.vaultCount).toBe(0);
  });

  test("a separator-terminated pattern prefix keeps it (ghp_)", () => {
    const token = "ghp_AbCdEfGhIjKlMnOpQrStUvWxYz0123456789ab";
    const result = redactToolOutput(`token: ${token}`);
    expect(result.text).toBe(
      'token: <redacted type="GitHub Token" prefix="ghp_…" suffix="…89ab" length="42" hash="ac9cf8d6" />',
    );
  });

  test("an opaque vault credential gets the unified marker with vault attribution", async () => {
    await refreshVaultRegistry(
      vaultSource({ "credential/openai/api_key": VAULT_VALUE }),
    );
    const result = redactToolOutput(`export KEY=${VAULT_VALUE}`);
    expect(result.text).toBe(
      'export KEY=<redacted type="Vault Credential" credential="openai/api_key" prefix="sk-…" suffix="…678" length="23" hash="7043e349" />',
    );
    expect(result.redactedCount).toBe(1);
    expect(result.vaultCount).toBe(1);
  });

  test("an opaque vault credential with no scanner pattern is redacted via the separator rule", async () => {
    await refreshVaultRegistry(
      vaultSource({ "credential/demo/token": OPAQUE_VALUE }),
    );
    const result = redactToolOutput(`token=${OPAQUE_VALUE}`);
    expect(result.text).toBe(
      'token=<redacted type="Generic Secret Assignment" credential="demo/token" prefix="opaque-…" suffix="…efix" length="37" hash="dea8b39c" />',
    );
  });

  test("the 30 percent cap trims the prefix and drops the suffix on short values", async () => {
    const short = "opapi_123456";
    await refreshVaultRegistry(
      vaultSource({ "credential/openproject/api_key": short }),
    );
    const result = redactToolOutput(`key=${short}`);
    // Budget: floor(0.3 * 12) = 3 chars total, all spent on the prefix.
    expect(result.text).toBe(
      'key=<redacted type="Vault Credential" credential="openproject/api_key" prefix="opa…" length="12" hash="d0721c27" />',
    );
  });

  test("multiple occurrences of a vault credential are all redacted with identical markers", async () => {
    await refreshVaultRegistry(
      vaultSource({ "credential/openai/api_key": VAULT_VALUE }),
    );
    const result = redactToolOutput(`${VAULT_VALUE} and ${VAULT_VALUE}`);
    expect(result.text).not.toContain(VAULT_VALUE);
    const marker =
      '<redacted type="Vault Credential" credential="openai/api_key" prefix="sk-…" suffix="…678" length="23" hash="7043e349" />';
    expect(result.text).toBe(`${marker} and ${marker}`);
    expect(result.redactedCount).toBe(2);
    expect(result.vaultCount).toBe(1);
  });

  test("identical values produce identical markers across separate calls (token correlation)", async () => {
    await refreshVaultRegistry(
      vaultSource({ "credential/openai/api_key": VAULT_VALUE }),
    );
    const first = redactToolOutput(`a: ${VAULT_VALUE}`);
    const second = redactToolOutput(`b: ${VAULT_VALUE}`);
    expect(first.text.slice(3)).toBe(second.text.slice(3));
  });

  test("vault and scanner redactions compose in one pass", async () => {
    await refreshVaultRegistry(
      vaultSource({ "credential/openai/api_key": VAULT_VALUE }),
    );
    const result = redactToolOutput(`aws=${AWS_KEY} vault=${VAULT_VALUE}`);
    expect(result.text).toContain('type="AWS Access Key"');
    expect(result.text).toContain('type="Vault Credential"');
    expect(result.text).not.toContain(AWS_KEY);
    expect(result.text).not.toContain(VAULT_VALUE);
    expect(result.redactedCount).toBe(2);
    expect(result.vaultCount).toBe(1);
  });

  test("a vault value that also matches a scanner pattern is redacted once, with vault attribution", async () => {
    await refreshVaultRegistry(
      vaultSource({ "credential/aws/access_key": AWS_KEY }),
    );
    const result = redactToolOutput(`key: ${AWS_KEY}`);
    expect(result.text).toBe(
      'key: <redacted type="AWS Access Key" credential="aws/access_key" prefix="AKIA…" suffix="…OP" length="20" hash="69ae1ddb" />',
    );
    expect(result.redactedCount).toBe(1);
    expect(result.vaultCount).toBe(1);
  });

  test("a private key block is fully redacted with the armor header as prefix", () => {
    const pem = [
      "-----BEGIN PRIVATE KEY-----",
      `MIIEvQIBADANBgkqhkiG9w0BAQEFAASCBKcwggSjAgEAAoIBAQC7${"a".repeat(60)}`,
      "b".repeat(64),
      "c".repeat(64),
      "d".repeat(64),
      "e".repeat(64),
      "f".repeat(64),
      "0123456789+/ABCDEFGHIJKLMNOPQRSTUVWXYZabcdef",
      "-----END PRIVATE KEY-----",
    ].join("\n");
    const result = redactToolOutput(`pem:\n${pem}`);
    expect(result.text).toContain('type="Private Key"');
    expect(result.text).toContain('prefix="-----BEGIN PRIVATE KEY-----…"');
    expect(result.text).not.toContain("MIIEvQIBADAN");
    expect(result.redactedCount).toBe(1);
  });
});
