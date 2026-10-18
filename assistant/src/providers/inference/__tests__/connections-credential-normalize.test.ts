import { beforeEach, describe, expect, test } from "bun:test";

import { describePg } from "../../../__tests__/pg-test-db.js";
import { requireMainDb } from "../../../persistence/db-facade.js";
import { normalizeCredentialRef } from "../../../security/credential-key.js";
import { createConnection, getConnection } from "../connections.js";

describe("normalizeCredentialRef", () => {
  test("maps the secrets-API wire name to the vault key", () => {
    expect(normalizeCredentialRef("openrouter:api_key")).toBe(
      "credential/openrouter/api_key",
    );
  });

  test("splits compound service names at the last colon", () => {
    expect(normalizeCredentialRef("integration:google:access_token")).toBe(
      "credential/integration:google/access_token",
    );
  });

  test("leaves vault keys and other refs untouched", () => {
    expect(normalizeCredentialRef("credential/openrouter/api_key")).toBe(
      "credential/openrouter/api_key",
    );
    expect(normalizeCredentialRef("openrouter")).toBe("openrouter");
    expect(normalizeCredentialRef("openrouter:")).toBe("openrouter:");
    expect(normalizeCredentialRef(":api_key")).toBe(":api_key");
  });
});

describePg("connection credential normalization", () => {
  beforeEach(async () => {
    const db = requireMainDb();
    await db.orm.delete(db.schema.providerConnections);
  });

  test("createConnection stores the vault-key form for a wire-name credential", async () => {
    const result = await createConnection(requireMainDb(), {
      name: "openrouter-conn",
      provider: "openrouter",
      auth: { type: "api_key", credential: "openrouter:api_key" },
    });
    expect(result.ok).toBe(true);
    if (result.ok && result.connection.auth.type === "api_key") {
      expect(result.connection.auth.credential).toBe(
        "credential/openrouter/api_key",
      );
    }
  });

  test("getConnection heals a stored wire-name credential without a migration", async () => {
    const db = requireMainDb();
    const now = Date.now();
    await db.run(
      `INSERT INTO provider_connections (name, provider, auth, created_at, updated_at) VALUES (?, ?, ?, ?, ?)`,
      [
        "legacy-openrouter",
        "openrouter",
        JSON.stringify({
          type: "api_key",
          credential: "openrouter:api_key",
        }),
        now,
        now,
      ],
    );

    const conn = await getConnection(db, "legacy-openrouter");
    expect(conn).not.toBeNull();
    if (conn?.auth.type === "api_key") {
      expect(conn.auth.credential).toBe("credential/openrouter/api_key");
    }
  });
});
