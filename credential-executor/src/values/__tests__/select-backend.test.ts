import { describe, expect, test } from "bun:test";

import type { SecureKeyBackend } from "@vellumai/credential-storage";

import type { CesMetadataStore } from "../../records/metadata-store.js";
import type { PsonoValuesSource } from "../psono-values-backend.js";
import { PsonoValuesBackend } from "../psono-values-backend.js";
import { parseValuesBackend, resolveValuesBackend } from "../select-backend.js";

const keysBackend: SecureKeyBackend = {
  get: async () => undefined,
  set: async () => true,
  delete: async () => "not-found",
  list: async () => [],
};

const records = {
  getByAccount: () => undefined,
  list: () => [],
} as unknown as CesMetadataStore;

const psono: PsonoValuesSource = {
  resolve: async () => ({ value: "" }),
  resolveFile: async () => ({ bytes: new Uint8Array() }),
  createEntry: async () => ({ created: false }),
  deleteEntry: async () => ({ deleted: false }),
  invalidate: () => {},
};

describe("parseValuesBackend", () => {
  test("defaults to keys", () => {
    expect(parseValuesBackend(undefined)).toBe("keys");
    expect(parseValuesBackend("")).toBe("keys");
    expect(parseValuesBackend(" KEYS ")).toBe("keys");
  });

  test("accepts psono", () => {
    expect(parseValuesBackend("psono")).toBe("psono");
  });

  test("rejects unknown values", () => {
    expect(() => parseValuesBackend("vault")).toThrow(/CES_VALUES_BACKEND/);
  });
});

describe("resolveValuesBackend", () => {
  test("keys keeps the encrypted key store", () => {
    const selected = resolveValuesBackend({
      configured: undefined,
      keys: keysBackend,
      psono,
      records,
    });
    expect(selected.name).toBe("keys");
    expect(selected.backend).toBe(keysBackend);
  });

  test("psono wraps the Psono source", () => {
    const selected = resolveValuesBackend({
      configured: "psono",
      keys: keysBackend,
      psono,
      records,
    });
    expect(selected.name).toBe("psono");
    expect(selected.backend).toBeInstanceOf(PsonoValuesBackend);
  });

  test("psono without material fails loudly", () => {
    expect(() =>
      resolveValuesBackend({
        configured: "psono",
        keys: keysBackend,
        psono: undefined,
        records,
      }),
    ).toThrow(/PSONO_MATERIAL_FILE/);
  });
});
