/**
 * One-time migration of the credentials in `keys.enc` to Psono.
 *
 * For each credential the migration:
 *
 * 1. reads the value from the encrypted key store (`CES_VALUES_BACKEND=keys`);
 * 2. upserts a Psono entry under `Joanna-shared/stack/<slug>`;
 * 3. reads the entry back and compares the SHA-256 of the stored value;
 * 4. only on a match, points the record at the entry (`ref`, `kind: "value"`,
 *    `sourceField: "password"`).
 *
 * The default list is the active set; `--all` enumerates every key in
 * `keys.enc`, including service credentials and OAuth material. A failed
 * comparison leaves the record untouched and fails the gate: the Psono values
 * backend must not be enabled. Re-running is safe: the same slug addresses the
 * same entry, and an entry whose value already matches is not rewritten.
 */

import { createHash, randomUUID } from "node:crypto";

import type { CredentialRecord } from "@vellumai/service-contracts/credential-rpc";
import type { SecureKeyBackend } from "@vellumai/credential-storage";

import type { CesMetadataStore } from "../records/metadata-store.js";
import { parseCredentialAccount } from "../records/metadata-store.js";
import { defaultStackRef, refSlug, stackRefForSlug } from "./refs.js";
import type { SecretPayload } from "./types.js";

/** Value records keep the value in the entry's `password` field. */
const SOURCE_FIELD = "password";

export interface PsonoMigrationEntry {
  service: string;
  field: string;
  /** Exact `keys.enc` key. Defaults to `credential/<service>/<field>`. */
  keyName?: string;
  /** Metadata-store account. Defaults to the key store key. */
  account?: string;
  /** Slug override, used to keep colliding names unique. */
  slug?: string;
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
  /** Enumerate every key in the store (`ces migrate-psono --all`). */
  all?: boolean;
}

export type MigrationFailureReason =
  | "missing"
  | "read_failed"
  | "write_failed"
  | "hash_mismatch"
  | "record_failed"
  | "unparsed";

export interface MigrationEntryOutcome {
  service: string;
  field: string;
  ref: string;
  ok: boolean;
  hashMatch: boolean;
  hashPrefix: string;
  /** The entry already held the same value, so no write was issued. */
  unchanged?: boolean;
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
  return entry.account ?? `${MIGRATION_ACCOUNT_PREFIX}${entry.service}/${entry.field}`;
}

function keyNameFor(entry: PsonoMigrationEntry): string {
  return entry.keyName ?? accountFor(entry);
}

function sha256(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

function payloadValue(payload: SecretPayload): string | undefined {
  const value = payload[SOURCE_FIELD];
  return typeof value === "string" ? value : undefined;
}

function sha256Short(value: string): string {
  return sha256(value).slice(0, 8);
}

/**
 * Turn one key store key into a migration entry.
 *
 * `credential/<service>/<field>` keys keep their exact account; every other key
 * (OAuth application and connection material) gets a `credential/`-prefixed
 * account so the metadata store accepts it, with the key path split on its last
 * slash.
 */
function entryForKey(keyName: string): PsonoMigrationEntry | undefined {
  const parsed = parseCredentialAccount(keyName);
  if (parsed) {
    return {
      service: parsed.service,
      field: parsed.field,
      keyName,
      account: keyName,
    };
  }

  const slash = keyName.lastIndexOf("/");
  if (slash < 1 || slash === keyName.length - 1) {
    return undefined;
  }
  return {
    service: keyName.slice(0, slash),
    field: keyName.slice(slash + 1),
    keyName,
    account: `${MIGRATION_ACCOUNT_PREFIX}${keyName}`,
  };
}

/** Base slug a key maps to before collision handling. */
function baseSlug(entry: PsonoMigrationEntry): string {
  return refSlug(entry.service, entry.field);
}

/**
 * Enumerate every key in the store as a migration entry.
 *
 * Slugs derive from `service/field`; two different keys can lowercase and
 * flatten to the same slug. The first (lexicographic) owner of a slug keeps it
 * and every other key gets a deterministic hash suffix, so the mapping is
 * stable across runs and no entry can overwrite another.
 */
export function discoverMigrationEntries(
  keyNames: readonly string[],
): PsonoMigrationEntry[] {
  const discovered = keyNames
    .map((keyName) => entryForKey(keyName))
    .filter((entry): entry is PsonoMigrationEntry => entry !== undefined)
    .sort((a, b) => keyNameFor(a).localeCompare(keyNameFor(b)));

  const legacy = new Set(
    PSONO_MIGRATION_ENTRIES.map(
      (entry) => `${entry.service}/${entry.field}`,
    ),
  );

  const groups = new Map<string, PsonoMigrationEntry[]>();
  for (const entry of discovered) {
    const slug = baseSlug(entry);
    const group = groups.get(slug);
    if (group) {
      group.push(entry);
    } else {
      groups.set(slug, [entry]);
    }
  }

  const out: PsonoMigrationEntry[] = [];
  for (const [slug, group] of groups) {
    if (group.length === 1) {
      out.push({ ...group[0]!, slug });
      continue;
    }
    for (const entry of group) {
      // A credential already migrated under the base slug keeps it, so the
      // collision cannot move an existing Psono entry.
      const keepBase = legacy.has(`${entry.service}/${entry.field}`);
      out.push({
        ...entry,
        slug: keepBase ? slug : `${slug}-${sha256Short(keyNameFor(entry))}`,
      });
    }
  }
  return out;
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

  let accounts: string[] = [];
  let listFailed = false;
  try {
    accounts = await options.keys.list();
  } catch {
    listFailed = true;
  }

  const entries = options.all
    ? discoverMigrationEntries(accounts)
    : options.entries ?? PSONO_MIGRATION_ENTRIES;

  const outcomes: MigrationEntryOutcome[] = [];

  if (options.all) {
    const mapped = new Set(entries.map((entry) => keyNameFor(entry)));
    for (const account of accounts.filter((key) => !mapped.has(key))) {
      outcomes.push({
        service: account,
        field: "",
        ref: "",
        ok: false,
        hashMatch: false,
        hashPrefix: "",
        reason: "unparsed",
      });
    }
  }

  if (options.all && listFailed) {
    return {
      entries: [],
      failures: [],
      unlistedCredentialAccounts: [],
      otherKeyNames: [],
      ok: false,
    };
  }

  for (const entry of entries) {
    const account = accountFor(entry);
    const baseRef = entry.slug
      ? stackRefForSlug(entry.slug)
      : defaultStackRef(entry.service, entry.field);
    const ref = options.records.getByAccount(account)?.ref?.trim() || baseRef;
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
      value = await options.keys.get(keyNameFor(entry));
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

    // A re-run against an entry that already holds the value is a no-op: no
    // write, no updated timestamp on the server.
    let storedAlready = false;
    try {
      const payload = await options.reader.readEntryPayload(ref);
      const stored = payloadValue(payload);
      storedAlready = stored !== undefined && hash(stored) === expectedHash;
    } catch {
      storedAlready = false;
    }

    if (!storedAlready) {
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
    } else {
      outcome.hashMatch = true;
      outcome.unchanged = true;
    }

    const existing = options.records.getByAccount(account);
    const aligned =
      existing !== undefined &&
      existing.service === entry.service &&
      existing.field === entry.field &&
      existing.ref === ref &&
      existing.kind === "value" &&
      existing.sourceField === SOURCE_FIELD;

    if (!aligned) {
      const updatedAt = now();
      const record: CredentialRecord = {
        ...existing,
        credentialId: existing?.credentialId ?? randomUUID(),
        service: entry.service,
        field: entry.field,
        ref,
        kind: "value",
        sourceField: SOURCE_FIELD,
        createdAt: existing?.createdAt ?? updatedAt,
        updatedAt,
      };
      if (!options.records.setByAccount(account, record)) {
        outcome.reason = "record_failed";
        outcomes.push(outcome);
        continue;
      }
    }

    outcome.ok = true;
    outcomes.push(outcome);
  }

  // With `--all` every key is in the entry list by construction, so nothing
  // is left over to report.
  const known = new Set(entries.map((entry) => keyNameFor(entry)));
  const unlistedCredentialAccounts = options.all
    ? []
    : accounts
        .filter(
          (account) =>
            account.startsWith(MIGRATION_ACCOUNT_PREFIX) &&
            !known.has(account),
        )
        .sort();
  const otherKeyNames = options.all
    ? []
    : accounts
        .filter((account) => !account.startsWith(MIGRATION_ACCOUNT_PREFIX))
        .sort();

  const failures = outcomes.filter((outcome) => !outcome.ok);
  return {
    entries: outcomes,
    failures,
    unlistedCredentialAccounts,
    otherKeyNames,
    ok: failures.length === 0 && !(options.all && listFailed),
  };
}
