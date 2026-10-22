/**
 * End-to-end switch test against the real Psono server.
 *
 * Requires:
 * - `PSONO_MATERIAL_FILE` pointing at the API key material;
 * - `CES_KEYS_DIR_FOR_INTEGRATION` pointing at a directory with `keys.enc` and
 *   `store.key` (the live CES security directory).
 *
 * The test migrates the eight active credentials, verifies every value by
 * SHA-256, reads them back through the Psono values backend, and exercises
 * `set` / `delete` on a throwaway credential. Values are never printed.
 *
 * Migrated entries are the product of the migration and stay in Psono. The
 * throwaway credential is deleted before the test ends.
 */

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

import { createLocalSecureKeyBackend } from "../../materializers/local-secure-key-backend.js";
import { CesMetadataStore } from "../../records/metadata-store.js";
import { PsonoCredentialBackend } from "../backend.js";
import { PsonoClient } from "../client.js";
import { loadMaterialFile } from "../material.js";
import {
  migrateCredentialsToPsono,
  PSONO_MIGRATION_ENTRIES,
} from "../migrate.js";
import { defaultStackRef } from "../refs.js";
import { PsonoTree } from "../tree.js";
import { PsonoValuesBackend } from "../../values/psono-values-backend.js";

const MATERIAL_PATH = process.env["PSONO_MATERIAL_FILE"];
const KEYS_DIR = process.env["CES_KEYS_DIR_FOR_INTEGRATION"];

const available =
  Boolean(MATERIAL_PATH) &&
  existsSync(MATERIAL_PATH!) &&
  Boolean(KEYS_DIR) &&
  existsSync(join(KEYS_DIR!, "keys.enc"));

const live = available ? describe : describe.skip;

function sha(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

live("Psono switch integration", () => {
  let recordsDir = "";
  let records: CesMetadataStore;
  let tree: PsonoTree;
  let backend: PsonoCredentialBackend;
  let keys: ReturnType<typeof createLocalSecureKeyBackend>;
  let values: PsonoValuesBackend;

  const testAccount = "credential/ces/write-test";
  const testRef = defaultStackRef("ces", "write-test");

  beforeAll(() => {
    recordsDir = mkdtempSync(join(tmpdir(), "ces-switch-"));
    records = new CesMetadataStore(join(recordsDir, "metadata.json"));
    const material = loadMaterialFile(MATERIAL_PATH!);
    const client = new PsonoClient({
      material,
      serverPublicKeyHex: material.serverPublicKeyHex,
    });
    tree = new PsonoTree(client);
    backend = new PsonoCredentialBackend({ client, tree, records });
    keys = createLocalSecureKeyBackend(dirname(KEYS_DIR!));
    values = new PsonoValuesBackend({ psono: backend, records });
  });

  afterAll(async () => {
    try {
      await values.delete(testAccount);
    } catch {
      // Cleanup is best effort; a missing test credential is the goal anyway.
    }
    try {
      await backend.deleteEntry(testRef);
    } catch {
      // Already gone.
    }
    rmSync(recordsDir, { recursive: true, force: true });
  });

  test(
    "migrates the eight active credentials",
    async () => {
      process.env["CREDENTIAL_SECURITY_DIR"] = KEYS_DIR!;
      const report = await migrateCredentialsToPsono({
        keys,
        writer: backend,
        reader: backend,
        records,
      });
      expect(report.entries).toHaveLength(8);
      expect(report.failures).toEqual([]);
      expect(report.ok).toBe(true);
      expect(records.list()).toHaveLength(8);
    },
    180_000,
  );

  test(
    "every migrated value matches the key store hash",
    async () => {
      for (const entry of PSONO_MIGRATION_ENTRIES) {
        const account = `credential/${entry.service}/${entry.field}`;
        const original = await keys.get(account);
        expect(typeof original).toBe("string");
        const resolved = await values.get(account);
        expect(typeof resolved).toBe("string");
        expect(sha(resolved!)).toBe(sha(original!));
      }
    },
    180_000,
  );

  test(
    "a second migration run is idempotent",
    async () => {
      const report = await migrateCredentialsToPsono({
        keys,
        writer: backend,
        reader: backend,
        records,
      });
      expect(report.ok).toBe(true);
      expect(records.list()).toHaveLength(8);
    },
    180_000,
  );

  test(
    "list exposes exactly the migrated records",
    async () => {
      const accounts = await values.list();
      expect(accounts).toHaveLength(8);
      for (const entry of PSONO_MIGRATION_ENTRIES) {
        expect(accounts).toContain(
          `credential/${entry.service}/${entry.field}`,
        );
      }
    },
    60_000,
  );

  test(
    "set and delete round-trip a throwaway credential",
    async () => {
      const value = `test-${Date.now()}`;
      expect(await values.set(testAccount, value)).toBe(true);
      expect(await values.get(testAccount)).toBe(value);

      const record = records.getByAccount(testAccount);
      expect(record?.ref).toBe(testRef);
      expect(record?.sourceField).toBe("password");

      expect(await values.delete(testAccount)).toBe("deleted");
      expect(records.getByAccount(testAccount)).toBeUndefined();
      await expect(backend.readEntryPayload(testRef)).rejects.toMatchObject({
        kind: "not_found",
      });
    },
    180_000,
  );
});
