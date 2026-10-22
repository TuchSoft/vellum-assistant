import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type { SecureKeyBackend } from "@vellumai/credential-storage";

import { CesMetadataStore } from "../../records/metadata-store.js";
import {
  discoverMigrationEntries,
  migrateCredentialsToPsono,
  PSONO_MIGRATION_ENTRIES,
  type PsonoEntryReader,
  type PsonoEntryWriter,
} from "../migrate.js";
import type { SecretPayload } from "../types.js";

class FakeKeys implements SecureKeyBackend {
  readonly values = new Map<string, string>();
  readonly accounts: string[] = [];

  async get(key: string): Promise<string | undefined> {
    return this.values.get(key);
  }

  async set(key: string, value: string): Promise<boolean> {
    this.values.set(key, value);
    return true;
  }

  async delete(): Promise<"deleted" | "not-found" | "error"> {
    return "deleted";
  }

  async list(): Promise<string[]> {
    return [...this.accounts];
  }
}

class FakeEntries implements PsonoEntryWriter, PsonoEntryReader {
  readonly entries = new Map<string, SecretPayload>();
  readonly writes: string[] = [];
  corrupt?: string;

  async createEntry(
    ref: string,
    fields: SecretPayload,
  ): Promise<{ created: boolean }> {
    this.writes.push(ref);
    const value = this.corrupt === ref ? "corrupted" : fields["password"];
    this.entries.set(ref, { ...(this.entries.get(ref) ?? {}), password: value });
    return { created: true };
  }

  async readEntryPayload(ref: string): Promise<SecretPayload> {
    return { ...(this.entries.get(ref) ?? {}) };
  }
}

const dirs: string[] = [];

afterEach(() => {
  for (const dir of dirs.splice(0)) {
    rmSync(dir, { recursive: true, force: true });
  }
});

function setup() {
  const dir = mkdtempSync(join(tmpdir(), "ces-migrate-"));
  dirs.push(dir);
  const records = new CesMetadataStore(join(dir, "metadata.json"));
  const keys = new FakeKeys();
  const entries = new FakeEntries();
  for (const entry of PSONO_MIGRATION_ENTRIES) {
    keys.values.set(
      `credential/${entry.service}/${entry.field}`,
      `value-for-${entry.service}-${entry.field}`,
    );
  }
  keys.accounts.push(...keys.values.keys());
  return { keys, entries, records };
}

describe("migrateCredentialsToPsono", () => {
  test("migrates every listed credential and verifies the hash", async () => {
    const { keys, entries, records } = setup();
    const report = await migrateCredentialsToPsono({
      keys,
      writer: entries,
      reader: entries,
      records,
      now: () => 1_000,
    });

    expect(report.ok).toBe(true);
    expect(report.entries).toHaveLength(8);
    expect(report.failures).toEqual([]);
    expect(report.entries.every((e) => e.hashMatch)).toBe(true);
    expect(report.entries.every((e) => e.hashPrefix.length === 12)).toBe(true);

    expect(records.list()).toHaveLength(8);
    for (const entry of PSONO_MIGRATION_ENTRIES) {
      const record = records.getByAccount(
        `credential/${entry.service}/${entry.field}`,
      );
      expect(record?.kind).toBe("value");
      expect(record?.sourceField).toBe("password");
      expect(record?.ref).toBe(
        `Joanna-shared/stack/${`${entry.service}/${entry.field}`
          .toLowerCase()
          .replace(/[/_]+/g, "-")}`,
      );
    }
  });

  test("is idempotent: a second run keeps the same records and refs", async () => {
    const { keys, entries, records } = setup();
    const first = await migrateCredentialsToPsono({
      keys,
      writer: entries,
      reader: entries,
      records,
      now: () => 1_000,
    });
    const ids = records
      .list()
      .map(({ record }) => record.credentialId)
      .sort();

    const second = await migrateCredentialsToPsono({
      keys,
      writer: entries,
      reader: entries,
      records,
      now: () => 2_000,
    });

    expect(first.ok).toBe(true);
    expect(second.ok).toBe(true);
    expect(records.list()).toHaveLength(8);
    expect(
      records
        .list()
        .map(({ record }) => record.credentialId)
        .sort(),
    ).toEqual(ids);
    expect(entries.entries.size).toBe(8);
  });

  test("a value mismatch fails the gate and leaves the record untouched", async () => {
    const { keys, entries, records } = setup();
    const target = "Joanna-shared/stack/vellum-webhook-secret";
    entries.corrupt = target;

    const report = await migrateCredentialsToPsono({
      keys,
      writer: entries,
      reader: entries,
      records,
    });

    expect(report.ok).toBe(false);
    expect(report.failures).toHaveLength(1);
    expect(report.failures[0]?.field).toBe("webhook_secret");
    expect(report.failures[0]?.reason).toBe("hash_mismatch");
    expect(
      records.getByAccount("credential/vellum/webhook_secret"),
    ).toBeUndefined();
    // The other seven are still migrated.
    expect(records.list()).toHaveLength(7);
  });

  test("a missing value fails without writing anything", async () => {
    const { keys, entries, records } = setup();
    keys.values.delete("credential/ipcert/ftp");

    const report = await migrateCredentialsToPsono({
      keys,
      writer: entries,
      reader: entries,
      records,
    });

    expect(report.ok).toBe(false);
    expect(report.failures[0]?.reason).toBe("missing");
    expect(entries.writes).not.toContain("Joanna-shared/stack/ipcert-ftp");
    expect(records.getByAccount("credential/ipcert/ftp")).toBeUndefined();
  });

  test("--all migrates every key, including service credentials and OAuth material", async () => {
    const { keys, entries, records } = setup();
    const extra: Record<string, string> = {
      "credential/brave/api_key": "brave-value",
      "credential/openai-compatible-personal-2/api_key": "dormant-one",
      "credential/openai-compatible/omniroute": "dormant-two",
      "oauth_app/aaaa/client_secret": "oauth-client-secret",
      "oauth_connection/bbbb/access_token": "oauth-access",
      "oauth_connection/bbbb/refresh_token": "oauth-refresh",
    };
    for (const [key, value] of Object.entries(extra)) {
      keys.values.set(key, value);
    }
    keys.accounts.splice(0, keys.accounts.length, ...keys.values.keys());

    const report = await migrateCredentialsToPsono({
      keys,
      writer: entries,
      reader: entries,
      records,
      all: true,
    });

    expect(report.ok).toBe(true);
    expect(report.entries).toHaveLength(14);
    expect(report.failures).toEqual([]);
    expect(report.unlistedCredentialAccounts).toEqual([]);
    expect(report.otherKeyNames).toEqual([]);
    expect(new Set(report.entries.map((outcome) => outcome.ref)).size).toBe(14);

    expect(
      records.getByAccount("credential/openai-compatible-personal-2/api_key")
        ?.ref,
    ).toBe("Joanna-shared/stack/openai-compatible-personal-2-api-key");
    expect(
      records.getByAccount("credential/oauth_app/aaaa/client_secret")?.ref,
    ).toBe("Joanna-shared/stack/oauth-app-aaaa-client-secret");
    expect(
      records.getByAccount("credential/oauth_connection/bbbb/refresh_token")
        ?.sourceField,
    ).toBe("password");
  });

  test("colliding slugs are disambiguated deterministically", () => {
    const discovered = discoverMigrationEntries([
      "credential/a_b/c",
      "credential/a/b_c",
      "credential/oauth_app/cccc/client_secret",
      "credential/oauth_app/cccc/client-secret",
    ]);
    const slugs = discovered.map((entry) => entry.slug);
    expect(slugs).toHaveLength(4);
    expect(new Set(slugs).size).toBe(4);

    const again = discoverMigrationEntries([
      "credential/a_b/c",
      "credential/a/b_c",
      "credential/oauth_app/cccc/client_secret",
      "credential/oauth_app/cccc/client-secret",
    ]);
    expect(again.map((entry) => entry.slug)).toEqual(slugs);
  });

  test("a colliding legacy entry keeps its base slug", () => {
    const discovered = discoverMigrationEntries([
      "credential/vellum/webhook_secret",
      "credential/vellum/webhook-secret",
    ]);
    const byKey = new Map(
      discovered.map((entry) => [entry.keyName, entry.slug]),
    );
    expect(byKey.get("credential/vellum/webhook_secret")).toBe(
      "vellum-webhook-secret",
    );
    expect(byKey.get("credential/vellum/webhook-secret")).not.toBe(
      "vellum-webhook-secret",
    );
  });

  test("--all is idempotent and does not rewrite aligned entries or records", async () => {
    const { keys, entries, records } = setup();
    keys.values.set("oauth_app/aaaa/client_secret", "oauth-client-secret");
    keys.accounts.splice(0, keys.accounts.length, ...keys.values.keys());

    const first = await migrateCredentialsToPsono({
      keys,
      writer: entries,
      reader: entries,
      records,
      all: true,
      now: () => 1_000,
    });
    const writesAfterFirst = entries.writes.length;
    const recordsAfterFirst = records.list();

    const second = await migrateCredentialsToPsono({
      keys,
      writer: entries,
      reader: entries,
      records,
      all: true,
      now: () => 2_000,
    });

    expect(first.ok).toBe(true);
    expect(second.ok).toBe(true);
    expect(entries.writes.length).toBe(writesAfterFirst);
    expect(second.entries.every((outcome) => outcome.unchanged)).toBe(true);
    expect(records.list()).toEqual(recordsAfterFirst);
    expect(records.list()).toHaveLength(9);
  });

  test("--all fails the gate when the key store cannot be listed", async () => {
    const { entries, records } = setup();
    const keys = new FakeKeys();
    keys.list = async () => {
      throw new Error("unreadable");
    };

    const report = await migrateCredentialsToPsono({
      keys,
      writer: entries,
      reader: entries,
      records,
      all: true,
    });

    expect(report.ok).toBe(false);
    expect(report.entries).toEqual([]);
  });

  test("reports unlisted key store entries by name", async () => {
    const { keys, entries, records } = setup();
    keys.accounts.push("credential/dormant/provider", "oauth_app/x/client_secret");

    const report = await migrateCredentialsToPsono({
      keys,
      writer: entries,
      reader: entries,
      records,
    });

    expect(report.unlistedCredentialAccounts).toEqual([
      "credential/dormant/provider",
    ]);
    expect(report.otherKeyNames).toEqual(["oauth_app/x/client_secret"]);
    expect(records.list()).toHaveLength(8);
  });
});
