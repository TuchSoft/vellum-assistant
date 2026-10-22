/**
 * End-to-end `--all` migration against the real Psono server.
 *
 * Requires:
 * - `PSONO_MATERIAL_FILE` pointing at the API key material;
 * - `CES_KEYS_DIR_FOR_INTEGRATION` pointing at a directory with `keys.enc` and
 *   `store.key` (the live CES security directory).
 *
 * Every key in the store is migrated, including service credentials and OAuth
 * material. Values are verified by SHA-256 and never printed. A second run must
 * report every entry as unchanged.
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
  discoverMigrationEntries,
  migrateCredentialsToPsono,
} from "../migrate.js";
import { PsonoTree } from "../tree.js";

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

live("Psono --all migration integration", () => {
  let recordsDir = "";
  let records: CesMetadataStore;
  let backend: PsonoCredentialBackend;
  let keys: ReturnType<typeof createLocalSecureKeyBackend>;

  beforeAll(() => {
    process.env["CREDENTIAL_SECURITY_DIR"] = KEYS_DIR!;
    recordsDir = mkdtempSync(join(tmpdir(), "ces-all-"));
    records = new CesMetadataStore(join(recordsDir, "metadata.json"));
    const material = loadMaterialFile(MATERIAL_PATH!);
    const client = new PsonoClient({
      material,
      serverPublicKeyHex: material.serverPublicKeyHex,
    });
    const tree = new PsonoTree(client);
    backend = new PsonoCredentialBackend({ client, tree, records });
    keys = createLocalSecureKeyBackend(dirname(KEYS_DIR!));
  });

  afterAll(() => {
    rmSync(recordsDir, { recursive: true, force: true });
  });

  test(
    "migrates every key in the store with a distinct ref",
    async () => {
      const accounts = await keys.list();
      const report = await migrateCredentialsToPsono({
        keys,
        writer: backend,
        reader: backend,
        records,
        all: true,
      });

      expect(report.entries).toHaveLength(accounts.length);
      expect(report.failures).toEqual([]);
      expect(report.ok).toBe(true);
      const refs = report.entries.map((entry) => entry.ref);
      expect(new Set(refs).size).toBe(refs.length);
      expect(records.list()).toHaveLength(accounts.length);

      for (const account of accounts) {
        const record =
          records.getByAccount(`credential/${account}`) ??
          records.getByAccount(account);
        expect(record?.ref).toBeTruthy();
        expect(record?.kind).toBe("value");
        expect(record?.sourceField).toBe("password");
      }
    },
    300_000,
  );

  test(
    "every migrated value matches the key store hash",
    async () => {
      const accounts = await keys.list();
      for (const account of accounts) {
        const original = await keys.get(account);
        expect(typeof original).toBe("string");

        const record =
          records.getByAccount(`credential/${account}`) ??
          records.getByAccount(account);
        const payload = await backend.readEntryPayload(record!.ref!);
        const stored = payload["password"];
        expect(typeof stored).toBe("string");
        expect(sha(stored as string)).toBe(sha(original!));
      }
    },
    300_000,
  );

  test(
    "a second run leaves every entry unchanged",
    async () => {
      const accounts = await keys.list();
      const before = records.list();
      const report = await migrateCredentialsToPsono({
        keys,
        writer: backend,
        reader: backend,
        records,
        all: true,
      });

      expect(report.ok).toBe(true);
      expect(report.entries).toHaveLength(accounts.length);
      expect(report.entries.every((entry) => entry.unchanged)).toBe(true);
      expect(records.list()).toEqual(before);
    },
    300_000,
  );

  test(
    "the enumerated entries cover the whole store",
    async () => {
      const accounts = await keys.list();
      const discovered = discoverMigrationEntries(accounts);
      expect(discovered).toHaveLength(accounts.length);
      expect(new Set(discovered.map((entry) => entry.keyName)).size).toBe(
        accounts.length,
      );
    },
    60_000,
  );
});
