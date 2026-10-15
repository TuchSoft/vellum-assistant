import { afterEach, describe, expect, test } from "bun:test";

import {
  _resetVaultRegistryForTests,
  getVaultSnapshot,
  refreshVaultRegistry,
  type VaultSnapshotSource,
} from "../vault-secret-registry.js";

function fakeSource(entries: Record<string, string>): VaultSnapshotSource {
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

describe("vault-secret-registry", () => {
  test("snapshot is null before any refresh", () => {
    expect(getVaultSnapshot()).toBeNull();
  });

  test("refresh registers values and parses service/field from account names", async () => {
    await refreshVaultRegistry(
      fakeSource({
        "credential/openai/api_key": "sk-test-1234567890abcdef",
      }),
    );
    const snapshot = getVaultSnapshot();
    expect(snapshot?.get("sk-test-1234567890abcdef")).toEqual({
      account: "credential/openai/api_key",
      service: "openai",
      field: "api_key",
    });
  });

  test("values shorter than the minimum length are not registered", async () => {
    await refreshVaultRegistry(fakeSource({ "credential/demo/short": "short12" }));
    expect(getVaultSnapshot()?.size).toBe(0);
  });

  test("account names outside the credential/<service>/<field> shape keep only the account", async () => {
    await refreshVaultRegistry(
      fakeSource({ "legacy-account-name": "legacy-value-12345678" }),
    );
    expect(getVaultSnapshot()?.get("legacy-value-12345678")).toEqual({
      account: "legacy-account-name",
    });
  });

  test("an unreachable listing leaves the snapshot empty", async () => {
    const source: VaultSnapshotSource = {
      async listAccounts() {
        return { accounts: [], unreachable: true };
      },
      async getValue() {
        return { value: undefined, unreachable: true };
      },
    };
    await refreshVaultRegistry(source);
    expect(getVaultSnapshot()).toBeNull();
  });

  test("a failing refresh keeps the previous snapshot", async () => {
    await refreshVaultRegistry(
      fakeSource({ "credential/openai/api_key": "sk-test-1234567890abcdef" }),
    );
    const failing: VaultSnapshotSource = {
      async listAccounts() {
        throw new Error("backend exploded");
      },
      async getValue() {
        return { value: undefined, unreachable: true };
      },
    };
    await refreshVaultRegistry(failing);
    expect(
      getVaultSnapshot()?.get("sk-test-1234567890abcdef"),
    ).toBeDefined();
  });

  test("a fresh snapshot does not re-hit the source on read", async () => {
    let listCalls = 0;
    const source: VaultSnapshotSource = {
      async listAccounts() {
        listCalls += 1;
        return {
          accounts: ["credential/openai/api_key"],
          unreachable: false,
        };
      },
      async getValue() {
        return { value: "sk-test-1234567890abcdef", unreachable: false };
      },
    };
    await refreshVaultRegistry(source);
    getVaultSnapshot();
    getVaultSnapshot();
    expect(listCalls).toBe(1);
  });
});
