import { describe, expect, mock, test } from "bun:test";

import { resolveAuth } from "../resolve-auth.js";

// ---------------------------------------------------------------------------
// Legacy SQLite migration: strip base_url from non-openai-compatible
// connections. The Postgres runtime enforces the same rule through
// `resolveAuth` below; migration 257 runs only on the legacy SQLite chain and
// cannot be applied to the Postgres facade.
// ---------------------------------------------------------------------------

describe("migration 257: strip base_url from non-openai-compatible connections", () => {
  test.todo("clears base_url on anthropic connection", () => {});

  test.todo("preserves base_url on openai-compatible connection", () => {});

  test.todo("is idempotent", () => {});
});

// ---------------------------------------------------------------------------
// resolveAuth defense-in-depth: strip baseUrl for non-openai-compatible
// ---------------------------------------------------------------------------

describe("resolveAuth defense-in-depth", () => {
  // Mock the secure key store to return a predictable value.
  mock.module("../../../security/secure-keys.js", () => ({
    getSecureKeyAsync: async (credential: string) =>
      credential === "cred-test" ? "sk-test-key" : null,
  }));

  // Mock the platform proxy context to avoid real platform calls.
  mock.module("../../platform-proxy/context.js", () => ({
    buildManagedBaseUrl: async () => null,
    resolveManagedProxyContext: async () => ({
      assistantApiKey: "platform-key",
    }),
  }));

  test("strips baseUrl for anthropic provider", async () => {
    const result = await resolveAuth(
      { type: "api_key", credential: "cred-test" },
      "anthropic",
      { baseUrl: "https://evil.example.com/v1" },
    );
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.resolved.kind).toBe("header");
      if (result.resolved.kind === "header") {
        expect(result.resolved.baseUrl).toBeUndefined();
      }
    }
  });

  test("strips baseUrl for openai provider", async () => {
    const result = await resolveAuth(
      { type: "api_key", credential: "cred-test" },
      "openai",
      { baseUrl: "https://evil.example.com/v1" },
    );
    expect(result.ok).toBe(true);
    if (result.ok && result.resolved.kind === "header") {
      expect(result.resolved.baseUrl).toBeUndefined();
    }
  });

  test("strips baseUrl for gemini provider", async () => {
    const result = await resolveAuth(
      { type: "api_key", credential: "cred-test" },
      "gemini",
      { baseUrl: "https://evil.example.com/v1" },
    );
    expect(result.ok).toBe(true);
    if (result.ok && result.resolved.kind === "header") {
      expect(result.resolved.baseUrl).toBeUndefined();
    }
  });

  test("preserves baseUrl for openai-compatible provider", async () => {
    const result = await resolveAuth(
      { type: "api_key", credential: "cred-test" },
      "openai-compatible",
      { baseUrl: "https://my-vllm.example.com/v1" },
    );
    expect(result.ok).toBe(true);
    if (result.ok && result.resolved.kind === "header") {
      expect(result.resolved.baseUrl).toBe("https://my-vllm.example.com/v1");
    }
  });

  test("preserves baseUrl for opencode provider", async () => {
    const result = await resolveAuth(
      { type: "api_key", credential: "cred-test" },
      "opencode",
      { baseUrl: "https://opencode.ai/zen/go/v1" },
    );
    expect(result.ok).toBe(true);
    if (result.ok && result.resolved.kind === "header") {
      expect(result.resolved.baseUrl).toBe("https://opencode.ai/zen/go/v1");
    }
  });

  test("preserves baseUrl for ollama none-auth", async () => {
    const result = await resolveAuth({ type: "none" }, "ollama", {
      baseUrl: "http://192.168.1.50:11434/v1",
    });
    expect(result.ok).toBe(true);
    if (result.ok && result.resolved.kind === "none") {
      expect(result.resolved.baseUrl).toBe("http://192.168.1.50:11434/v1");
    }
  });

  test("handles null baseUrl gracefully for any provider", async () => {
    const result = await resolveAuth(
      { type: "api_key", credential: "cred-test" },
      "anthropic",
      { baseUrl: null },
    );
    expect(result.ok).toBe(true);
    if (result.ok && result.resolved.kind === "header") {
      expect(result.resolved.baseUrl).toBeUndefined();
    }
  });
});
