import { beforeEach, expect, mock, test } from "bun:test";

// Vault mock (must precede imports)

let vault: Record<string, string>;
let vaultUnreachable: boolean;
const setCalls: Array<{ account: string; value: string }> = [];

mock.module("../../../security/secure-keys.js", () => ({
  getSecureKeyResultAsync: async (account: string) =>
    vaultUnreachable
      ? { value: undefined, unreachable: true }
      : { value: vault[account], unreachable: false },
  setSecureKeyAsync: async (account: string, value: string) => {
    setCalls.push({ account, value });
    vault[account] = value;
  },
  deleteSecureKeyAsync: async (account: string) => {
    delete vault[account];
  },
}));

// Real imports (after mocks)

import { describePg } from "../../../__tests__/pg-test-db.js";
import { requireMainDb } from "../../../persistence/db-facade.js";
import { initializeDb } from "../../../persistence/db-init.js";
import { getConnection } from "../connections.js";
import { repairSharedCredentialSlots } from "../credential-slot-repair.js";

await initializeDb();

const LEGACY = "credential/openai-compatible/api_key";

async function seedRow(name: string, credential: string): Promise<void> {
  const db = requireMainDb();
  const now = Date.now();
  await db.run(
    `INSERT INTO provider_connections (name, provider, auth, base_url, models, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)`,
    [
      name,
      "openai-compatible",
      JSON.stringify({ type: "api_key", credential }),
      `https://${name}.example/v1`,
      JSON.stringify([{ id: "model-1" }]),
      now,
      now,
    ],
  );
}

async function refOf(name: string): Promise<string | undefined> {
  const row = await getConnection(requireMainDb(), name);
  return row?.auth.type === "api_key" ? row.auth.credential : undefined;
}

describePg("repairSharedCredentialSlots", () => {
  beforeEach(async () => {
    const db = requireMainDb();
    await db.orm.delete(db.schema.providerConnections);
    vault = {};
    vaultUnreachable = false;
    setCalls.length = 0;
  });

  test("repoints sharing rows to per-connection slots and copies the shared value", async () => {
    await seedRow("openai-compatible-personal", LEGACY);
    await seedRow("openai-compatible-personal-2", LEGACY);
    vault[LEGACY] = "sk-last-saved";

    await repairSharedCredentialSlots();

    expect(await refOf("openai-compatible-personal")).toBe(
      "credential/openai-compatible-personal/api_key",
    );
    expect(await refOf("openai-compatible-personal-2")).toBe(
      "credential/openai-compatible-personal-2/api_key",
    );
    // Behavior-preserving: each new slot holds the value the row resolved
    // through the shared slot.
    expect(vault["credential/openai-compatible-personal/api_key"]).toBe(
      "sk-last-saved",
    );
    expect(vault["credential/openai-compatible-personal-2/api_key"]).toBe(
      "sk-last-saved",
    );
  });

  test("an empty shared slot still repoints the refs without writing secrets", async () => {
    await seedRow("openai-compatible-personal", LEGACY);

    await repairSharedCredentialSlots();

    expect(await refOf("openai-compatible-personal")).toBe(
      "credential/openai-compatible-personal/api_key",
    );
    expect(setCalls).toEqual([]);
  });

  test("defers everything when the vault is unreachable", async () => {
    await seedRow("openai-compatible-personal", LEGACY);
    vaultUnreachable = true;

    await repairSharedCredentialSlots();

    expect(await refOf("openai-compatible-personal")).toBe(LEGACY);
  });

  test("leaves per-connection and custom refs untouched; idempotent", async () => {
    await seedRow(
      "openai-compatible-personal",
      "credential/openai-compatible-personal/api_key",
    );
    await seedRow("my-endpoint", "credential/shared-team-key/api_key");

    await repairSharedCredentialSlots();
    await repairSharedCredentialSlots();

    expect(await refOf("openai-compatible-personal")).toBe(
      "credential/openai-compatible-personal/api_key",
    );
    expect(await refOf("my-endpoint")).toBe(
      "credential/shared-team-key/api_key",
    );
    expect(setCalls).toEqual([]);
  });

  test("does not overwrite a value already present in a per-connection slot", async () => {
    await seedRow("openai-compatible-personal", LEGACY);
    vault[LEGACY] = "sk-shared";
    vault["credential/openai-compatible-personal/api_key"] = "sk-already-mine";

    await repairSharedCredentialSlots();

    expect(vault["credential/openai-compatible-personal/api_key"]).toBe(
      "sk-already-mine",
    );
    expect(await refOf("openai-compatible-personal")).toBe(
      "credential/openai-compatible-personal/api_key",
    );
  });
});
