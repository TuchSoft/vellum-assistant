import { afterAll, afterEach, beforeEach, expect, mock, test } from "bun:test";

mock.module("../security/secure-keys.js", () => ({
  deleteSecureKeyAsync: () => Promise.resolve("deleted" as const),
  setSecureKeyAsync: () => Promise.resolve(true),
  getSecureKeyAsync: () => Promise.resolve(undefined),
}));

import type { AssistantConfig } from "../config/schema.js";
import { listProviders, seedProviders } from "../oauth/oauth-store.js";
import { isProviderVisible } from "../oauth/provider-visibility.js";
import { requireMainDb } from "../persistence/db-facade.js";
import { initializeDb } from "../persistence/db-init.js";
import { resetDbForTesting } from "./db-test-helpers.js";
import { setOverridesForTesting } from "./feature-flag-test-helpers.js";
import { describePg } from "./pg-test-db.js";

await initializeDb();

/** Create a minimal AssistantConfig for testing. */
function makeConfig(): AssistantConfig {
  return {} as AssistantConfig;
}

async function resetOAuthTables(): Promise<void> {
  const db = requireMainDb();
  // Delete in FK-dependency order: connections -> apps -> providers.
  for (const table of ["oauth_connections", "oauth_apps", "oauth_providers"]) {
    await db.run(`DELETE FROM "${table}"`);
  }
}

afterAll(() => {
  resetDbForTesting();
});

describePg("isProviderVisible", () => {
  beforeEach(async () => {
    await resetOAuthTables();
    setOverridesForTesting({});
  });

  afterEach(() => {
    setOverridesForTesting({});
  });

  test("returns true when featureFlag is null", async () => {
    await seedProviders([
      {
        provider: "no-flag-provider",
        authorizeUrl: "https://example.com/auth",
        tokenExchangeUrl: "https://example.com/token",
        defaultScopes: ["read"],
      },
    ]);

    const providers = await listProviders();
    const provider = providers.find((p) => p.provider === "no-flag-provider");
    expect(provider).toBeDefined();
    expect(provider!.featureFlag).toBeNull();

    const config = makeConfig();
    expect(isProviderVisible(provider!, config)).toBe(true);
  });

  test("returns true when featureFlag is set and the flag is enabled", async () => {
    setOverridesForTesting({ "test-gate": true });

    await seedProviders([
      {
        provider: "gated-provider",
        authorizeUrl: "https://example.com/auth",
        tokenExchangeUrl: "https://example.com/token",
        defaultScopes: ["read"],

        featureFlag: "test-gate",
      },
    ]);

    const providers = await listProviders();
    const provider = providers.find((p) => p.provider === "gated-provider");
    expect(provider).toBeDefined();
    expect(provider!.featureFlag).toBe("test-gate");

    const config = makeConfig();
    expect(isProviderVisible(provider!, config)).toBe(true);
  });

  test("returns false when featureFlag is set and the flag is disabled", async () => {
    setOverridesForTesting({ "test-gate": false });

    await seedProviders([
      {
        provider: "gated-provider",
        authorizeUrl: "https://example.com/auth",
        tokenExchangeUrl: "https://example.com/token",
        defaultScopes: ["read"],

        featureFlag: "test-gate",
      },
    ]);

    const providers = await listProviders();
    const provider = providers.find((p) => p.provider === "gated-provider");
    expect(provider).toBeDefined();

    const config = makeConfig();
    expect(isProviderVisible(provider!, config)).toBe(false);
  });

  test("listProviders returns all providers but isProviderVisible filters gated ones when flag is disabled", async () => {
    setOverridesForTesting({ "test-gate": false });

    await seedProviders([
      {
        provider: "visible-provider",
        authorizeUrl: "https://example.com/auth",
        tokenExchangeUrl: "https://example.com/token",
        defaultScopes: ["read"],
      },
      {
        provider: "gated-provider",
        authorizeUrl: "https://gated.example.com/auth",
        tokenExchangeUrl: "https://gated.example.com/token",
        defaultScopes: ["read"],

        featureFlag: "test-gate",
      },
    ]);

    const allProviders = await listProviders();
    expect(allProviders).toHaveLength(2);

    const config = makeConfig();
    const visibleProviders = allProviders.filter((p) =>
      isProviderVisible(p, config),
    );
    expect(visibleProviders).toHaveLength(1);
    expect(visibleProviders[0]!.provider).toBe("visible-provider");
  });
});
