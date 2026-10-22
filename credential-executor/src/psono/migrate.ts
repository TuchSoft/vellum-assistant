/**
 * One-time migration of the active credentials from `keys.enc` to Psono.
 *
 * For each listed credential the migration:
 *
 * 1. reads the value from the encrypted key store (`CES_VALUES_BACKEND=keys`);
 * 2. upserts a Psono entry under `Joanna-shared/stack/<slug>`;
 * 3. reads the entry back and compares the SHA-256 of the stored value;
 * 4. only on a match, points the record at the entry (`ref`, `kind: "value"`,
 *    `sourceField: "password"`).
 *
 * A failed comparison leaves the record untouched and fails the gate: the
 * Psono values backend must not be enabled. Re-running is safe: the same slug
 * addresses the same entry, and a record that already points at a ref keeps it.
 */

import { createHash, randomUUID } from "node:crypto";

import type { CredentialRecord } from "@vellumai/service-contracts/credential-rpc";
import type { SecureKeyBackend } from "@vellumai/credential-storage";

import type { CesMetadataStore } from "../records/metadata-store.js";
import { defaultStackRef } from "./refs.js";
import type { SecretPayload } from "./types.js";

/** Value records keep the value in the entry's `password` field. */
const SOURCE_FIELD = "password";

export interface PsonoMigrationEntry {
  service: string;
  field: string;
}

/** Active credentials to migrate. Dormant provider connections stay behind. */
export const PSONO_MIGRATION_ENTRIES: readonly PsonoMigrationEntry[] = [
  { service: "vellum", field: "platform_assistant_id" },
  { service: "vellum", field: "platform_organization_id" },
  { service: "vellum", field: "webhook_secret" },
  { service: "vellum", field: "assistant_api_key" },
  { service: "openai-compatible-personal-5", field: "api_key" },
  { service: "rest-gateway", field: "auth_password" },
  { service: "ipcert", field: "ftp" },
  { service: "ipcert-ftp", field: "password" },
];

export interface PsonoEntryWriter {
  createEntry(
    ref: string,
    fields: SecretPayload,
    kind?: "value" | "file" | "json",
  ): Promise<unknown>;
}

export interface PsonoEntryReader {
  readEntryPayload(ref: string): Promise<SecretPayload>;
}

export interface MigrateCredentialsOptions {
  keys: SecureKeyBackend;
  writer: PsonoEntryWriter;
  reader: PsonoEntryReader;
  records: CesMetadataStore;
  now?: () => number;
  hash?: (value: string) => string;
  entries?: readonly PsonoMigrationEntry[];
}

export type MigrationFailureReason =
  | "missing"
  | "read_failed"
  | "write_failed"
  | "hash_mismatch"
  | "record_failed";

export interface MigrationEntryOutcome {
  service: string;
  field: string;
  ref: string;
  ok: boolean;
  hashMatch: boolean;
  hashPrefix: string;
  reason?: MigrationFailureReason;
}

export interface MigrationReport {
  entries: MigrationEntryOutcome[];
  failures: MigrationEntryOutcome[];
  /** `credential/*` accounts in the key store outside the migration list. */
  unlistedCredentialAccounts: string[];
  /** Non-credential keys in the key store (OAuth material, etc.). */
  otherKeyNames: string[];
  ok: boolean;
}

export const MIGRATION_ACCOUNT_PREFIX = "credential/";

function accountFor(entry: PsonoMigrationEntry): string {
  return `${MIGRATION_ACCOUNT_PREFIX}${entry.service}/${entry.field}`;
}

function sha256(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

function payloadValue(payload: SecretPayload): string | undefined {
  const value = payload[SOURCE_FIELD];
  return typeof value === "string" ? value : undefined;
}

/**
 * Run the migration.
 *
 * Per-entry failures never abort the loop: every listed credential is
 * attempted, and the report carries the failures for the caller's gate.
 */
export async function migrateCredentialsToPsono(
  options: MigrateCredentialsOptions,
): Promise<MigrationReport> {
  const now = options.now ?? Date.now;
  const hash = options.hash ?? sha256;
  const entries = options.entries ?? PSONO_MIGRATION_ENTRIES;
  const outcomes: MigrationEntryOutcome[] = [];

  for (const entry of entries) {
    const account = accountFor(entry);
    const ref =
      options.records.getByAccount(account)?.ref?.trim() || defaultStackRef(entry.service, entry.field);
    const outcome: MigrationEntryOutcome = {
      service: entry.service,
      field: entry.field,
      ref,
      ok: false,
      hashMatch: false,
      hashPrefix: "",
    };

    let value: string | undefined;
    try {
      value = await options.keys.get(account);
    } catch {
      outcome.reason = "read_failed";
      outcomes.push(outcome);
      continue;
    }
    if (value === undefined) {
      outcome.reason = "missing";
      outcomes.push(outcome);
      continue;
    }
    const expectedHash = hash(value);
    outcome.hashPrefix = expectedHash.slice(0, 12);

    try {
      await options.writer.createEntry(
        ref,
        { title: `${entry.service}/${entry.field}`, [SOURCE_FIELD]: value },
        "value",
      );
    } catch {
      outcome.reason = "write_failed";
      outcomes.push(outcome);
      continue;
    }

    let stored: string | undefined;
    try {
      const payload = await options.reader.readEntryPayload(ref);
      stored = payloadValue(payload);
    } catch {
      outcome.reason = "hash_mismatch";
      outcomes.push(outcome);
      continue;
    }

    outcome.hashMatch = stored !== undefined && hash(stored) === expectedHash;
    if (!outcome.hashMatch) {
      outcome.reason = "hash_mismatch";
      outcomes.push(outcome);
      continue;
    }

    const existing = options.records.getByAccount(account);
    const updatedAt = now();
    const record: CredentialRecord = {
      ...existing,
      credentialId: existing?.credentialId ?? randomUUID(),
      service: entry.service,
      field: entry.field,
      ref,
      kind: "value",
      sourceField: SOURCE_FIELD,
      allowedTools: existing?.allowedTools ?? [],
      allowedDomains: existing?.allowedDomains ?? [],
      createdAt: existing?.createdAt ?? updatedAt,
      updatedAt,
    };
    if (!options.records.setByAccount(account, record)) {
      outcome.reason = "record_failed";
      outcomes.push(outcome);
      continue;
    }

    outcome.ok = true;
    outcomes.push(outcome);
  }

  const known = new Set(entries.map((entry) => accountFor(entry)));
  let accounts: string[] = [];
  try {
    accounts = await options.keys.list();
  } catch {
    accounts = [];
  }
  const unlistedCredentialAccounts = accounts
    .filter(
      (account) =>
        account.startsWith(MIGRATION_ACCOUNT_PREFIX) && !known.has(account),
    )
    .sort();
  const otherKeyNames = accounts
    .filter((account) => !account.startsWith(MIGRATION_ACCOUNT_PREFIX))
    .sort();

  const failures = outcomes.filter((outcome) => !outcome.ok);
  return {
    entries: outcomes,
    failures,
    unlistedCredentialAccounts,
    otherKeyNames,
    ok: failures.length === 0,
  };
}
