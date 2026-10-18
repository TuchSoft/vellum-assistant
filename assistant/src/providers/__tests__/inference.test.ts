/**
 * Tests for provider_connections: table presence, CRUD, and
 * mix-and-match E2E (two profiles, same provider, different connections).
 */

import { beforeEach, describe, expect, test } from "bun:test";

import { describePg } from "../../__tests__/pg-test-db.js";
import { requireMainDb } from "../../persistence/db-facade.js";
import { AuthSchema } from "../inference/auth.js";
import {
  createConnection,
  deleteConnection,
  getConnection,
  listConnections,
  seedCanonicalConnections,
  updateConnection,
} from "../inference/connections.js";

async function resetConnections(): Promise<void> {
  const db = requireMainDb();
  await db.orm.delete(db.schema.providerConnections);
}

// ---------------------------------------------------------------------------
// Table presence
// ---------------------------------------------------------------------------

describePg("migrateCreateProviderConnections", () => {
  beforeEach(async () => {
    await resetConnections();
  });

  test("creates the provider_connections table", async () => {
    const rows = await requireMainDb().all<{ name: string }>(
      "SELECT name FROM provider_connections",
    );
    expect(Array.isArray(rows)).toBe(true);
  });

  test("seedCanonicalConnections seeds the provider-agnostic vellum connection", async () => {
    await seedCanonicalConnections(requireMainDb());
    const vellum = await getConnection(requireMainDb(), "vellum");
    expect(vellum).not.toBeNull();
    expect(vellum?.provider).toBe("vellum");
    expect(vellum?.auth.type).toBe("platform");
    // Derived from MANAGED_CONNECTION_NAMES, write-protected at the route layer.
    expect(vellum?.isManaged).toBe(true);
  });

  test("seedCanonicalConnections is idempotent", async () => {
    // Run twice, should not throw or create duplicate vellum rows.
    await seedCanonicalConnections(requireMainDb());
    await seedCanonicalConnections(requireMainDb());
    const managed = await listConnections(requireMainDb(), {
      provider: "vellum",
    });
    expect(managed.filter((c) => c.name === "vellum").length).toBe(1);
  });

  test("seedCanonicalConnections does not clobber a user connection named vellum", async () => {
    // `vellum` was not reserved before consolidation, so an install may already
    // have a BYOK connection keyed `vellum`. Seeding must not rewrite it to the
    // platform-auth sentinel.
    await createConnection(requireMainDb(), {
      name: "vellum",
      provider: "anthropic",
      auth: { type: "api_key", credential: "credential/anthropic/api_key" },
    });

    await seedCanonicalConnections(requireMainDb());

    const conn = await getConnection(requireMainDb(), "vellum");
    expect(conn?.provider).toBe("anthropic");
    expect(conn?.auth.type).toBe("api_key");
  });
});

// ---------------------------------------------------------------------------
// Connection CRUD
// ---------------------------------------------------------------------------

describePg("Connection CRUD", () => {
  beforeEach(async () => {
    await resetConnections();
  });

  test("createConnection — happy path", async () => {
    const result = await createConnection(requireMainDb(), {
      name: "my-anthropic",
      provider: "anthropic",
      auth: { type: "api_key", credential: "credential/anthropic/api_key" },
    });
    expect(result.ok).toBe(true);
    if (!result.ok) {
      return;
    }
    expect(result.connection.name).toBe("my-anthropic");
    expect(result.connection.provider).toBe("anthropic");
    expect(result.connection.auth.type).toBe("api_key");
  });

  test("createConnection — rejects unknown provider", async () => {
    const result = await createConnection(requireMainDb(), {
      name: "bad-conn",
      provider: "unknown-llm" as never,
      auth: { type: "none" },
    });
    expect(result.ok).toBe(false);
    if (result.ok) {
      return;
    }
    expect(result.error.code).toBe("invalid_provider");
  });

  test("createConnection — rejects duplicate name", async () => {
    await createConnection(requireMainDb(), {
      name: "dup-conn",
      provider: "openai",
      auth: { type: "platform" },
    });
    const result = await createConnection(requireMainDb(), {
      name: "dup-conn",
      provider: "openai",
      auth: { type: "platform" },
    });
    expect(result.ok).toBe(false);
    if (result.ok) {
      return;
    }
    expect(result.error.code).toBe("already_exists");
  });

  test("getConnection — returns null for unknown name", async () => {
    expect(await getConnection(requireMainDb(), "nonexistent")).toBeNull();
  });

  test("listConnections — filters by provider", async () => {
    await createConnection(requireMainDb(), {
      name: "test-openai",
      provider: "openai",
      auth: { type: "api_key", credential: "credential/openai/api_key" },
    });
    const openai = await listConnections(requireMainDb(), {
      provider: "openai",
    });
    expect(openai.every((c) => c.provider === "openai")).toBe(true);
  });

  test("updateConnection — happy path", async () => {
    await createConnection(requireMainDb(), {
      name: "updatable",
      provider: "anthropic",
      auth: { type: "platform" },
    });
    const result = await updateConnection(requireMainDb(), "updatable", {
      auth: { type: "api_key", credential: "credential/anthropic/api_key" },
    });
    expect(result.ok).toBe(true);
    if (!result.ok) {
      return;
    }
    expect(result.connection.auth.type).toBe("api_key");
    const fetched = await getConnection(requireMainDb(), "updatable");
    expect(fetched?.auth.type).toBe("api_key");
  });

  test("updateConnection: provider correction rides an auth rewrite", async () => {
    // The ChatGPT sign-in flow stamps provider "openai" when it writes
    // subscription auth, so a claiming row with another provider cannot
    // strand the fresh token behind derived platform auth.
    await createConnection(requireMainDb(), {
      name: "chatgpt-subscription",
      provider: "vellum",
      auth: { type: "platform" },
    });
    const result = await updateConnection(
      requireMainDb(),
      "chatgpt-subscription",
      {
        auth: {
          type: "oauth_subscription",
          credential: "credential/chatgpt/access_token",
        },
        provider: "openai",
      },
    );
    expect(result.ok).toBe(true);
    const fetched = await getConnection(
      requireMainDb(),
      "chatgpt-subscription",
    );
    expect(fetched?.provider).toBe("openai");
    expect(fetched?.auth.type).toBe("oauth_subscription");
  });

  test("updateConnection: rejects an unknown provider", async () => {
    await createConnection(requireMainDb(), {
      name: "updatable-provider",
      provider: "anthropic",
      auth: { type: "api_key", credential: "credential/anthropic/api_key" },
    });
    const result = await updateConnection(
      requireMainDb(),
      "updatable-provider",
      {
        auth: { type: "api_key", credential: "credential/anthropic/api_key" },
        provider: "not-a-provider",
      },
    );
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe("invalid_provider");
    }
  });

  test("updateConnection — rejects unknown name", async () => {
    const result = await updateConnection(requireMainDb(), "ghost", {
      auth: { type: "none" },
    });
    expect(result.ok).toBe(false);
    if (result.ok) {
      return;
    }
    expect(result.error.code).toBe("not_found");
  });

  test("deleteConnection — happy path", async () => {
    await createConnection(requireMainDb(), {
      name: "to-delete",
      provider: "gemini",
      auth: { type: "platform" },
    });
    const result = await deleteConnection(requireMainDb(), "to-delete");
    expect(result.ok).toBe(true);
    expect(await getConnection(requireMainDb(), "to-delete")).toBeNull();
  });

  test("deleteConnection — rejects unknown name", async () => {
    const result = await deleteConnection(requireMainDb(), "ghost");
    expect(result.ok).toBe(false);
    if (result.ok) {
      return;
    }
    expect(result.error.code).toBe("not_found");
  });

  test("deleteConnection — rejects when profiles reference it (no --force)", async () => {
    await createConnection(requireMainDb(), {
      name: "referenced",
      provider: "anthropic",
      auth: { type: "platform" },
    });
    const result = await deleteConnection(requireMainDb(), "referenced", {
      force: false,
      referencingProfiles: ["profile-a", "profile-b"],
    });
    expect(result.ok).toBe(false);
    if (result.ok) {
      return;
    }
    expect(result.error.code).toBe("has_references");
    if (result.error.code !== "has_references") {
      return;
    }
    expect(result.error.count).toBe(2);
  });

  test("deleteConnection --force removes even with references", async () => {
    await createConnection(requireMainDb(), {
      name: "force-delete",
      provider: "anthropic",
      auth: { type: "platform" },
    });
    const result = await deleteConnection(requireMainDb(), "force-delete", {
      force: true,
      referencingProfiles: ["some-profile"],
    });
    expect(result.ok).toBe(true);
    expect(await getConnection(requireMainDb(), "force-delete")).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// Auth schema validation
// ---------------------------------------------------------------------------

describe("AuthSchema", () => {
  test("api_key variant requires credential", () => {
    const ok = AuthSchema.safeParse({
      type: "api_key",
      credential: "cred/foo/api_key",
    });
    expect(ok.success).toBe(true);

    const bad = AuthSchema.safeParse({ type: "api_key" }); // missing credential
    expect(bad.success).toBe(false);
  });

  test("platform variant has no extra fields", () => {
    const ok = AuthSchema.safeParse({ type: "platform" });
    expect(ok.success).toBe(true);
  });

  test("none variant parses", () => {
    const ok = AuthSchema.safeParse({ type: "none" });
    expect(ok.success).toBe(true);
  });

  test("oauth_subscription and service_account parse (v2 variants, runtime-rejected)", () => {
    expect(
      AuthSchema.safeParse({ type: "oauth_subscription", credential: "x" })
        .success,
    ).toBe(true);
    expect(
      AuthSchema.safeParse({ type: "service_account", credential: "x" })
        .success,
    ).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Mix-and-match correctness
// ---------------------------------------------------------------------------

describePg(
  "Mix-and-match: two profiles, same provider, different connections",
  () => {
    beforeEach(async () => {
      await resetConnections();
    });

    test("getConnection returns the right auth for each connection name", async () => {
      // Two connections for the same provider with distinct auth resolve
      // independently: one platform-auth, one personal api_key.
      await createConnection(requireMainDb(), {
        name: "anthropic-platform",
        provider: "anthropic",
        auth: { type: "platform" },
      });
      await createConnection(requireMainDb(), {
        name: "anthropic-personal",
        provider: "anthropic",
        auth: { type: "api_key", credential: "credential/anthropic/api_key" },
      });

      expect(
        (await getConnection(requireMainDb(), "anthropic-platform"))?.auth.type,
      ).toBe("platform");
      expect(
        (await getConnection(requireMainDb(), "anthropic-personal"))?.auth.type,
      ).toBe("api_key");

      // Both connections exist for the same provider.
      const anthropicConns = await listConnections(requireMainDb(), {
        provider: "anthropic",
      });
      const names = anthropicConns.map((c) => c.name);
      expect(names).toContain("anthropic-platform");
      expect(names).toContain("anthropic-personal");

      // Auth is distinct per connection.
      const platform = anthropicConns.find(
        (c) => c.name === "anthropic-platform",
      );
      const personal = anthropicConns.find(
        (c) => c.name === "anthropic-personal",
      );
      expect(platform?.auth.type).toBe("platform");
      expect(personal?.auth.type).toBe("api_key");
    });
  },
);
