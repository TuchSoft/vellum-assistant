/**
 * CES-owned credential metadata store.
 *
 * Persists non-secret identity and policy (`allowedTools`, `allowedDomains`,
 * `injectionTemplates`, plus catalog fields) at
 * `<cesDataRoot>/metadata.json`. Secret values stay in `keys.enc`.
 */

import { randomUUID } from "node:crypto";
import {
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  writeFileSync,
} from "node:fs";
import { dirname, join } from "node:path";

import type { CredentialRecord } from "@vellumai/service-contracts/credential-rpc";

import { getCesDataRoot } from "../paths.js";

export const METADATA_FILENAME = "metadata.json";

const CURRENT_VERSION = 5;

interface MetadataFile {
  version: typeof CURRENT_VERSION;
  credentials: CredentialRecord[];
}

export function getMetadataPath(cesDataRoot: string): string {
  return join(cesDataRoot, METADATA_FILENAME);
}

export function parseCredentialAccount(
  account: string,
): { service: string; field: string } | undefined {
  const prefix = "credential/";
  if (!account.startsWith(prefix)) {
    return undefined;
  }
  const rest = account.slice(prefix.length);
  const slashIdx = rest.lastIndexOf("/");
  if (slashIdx < 1 || slashIdx === rest.length - 1) {
    return undefined;
  }
  return {
    service: rest.slice(0, slashIdx),
    field: rest.slice(slashIdx + 1),
  };
}

export function accountForRecord(
  record: Pick<CredentialRecord, "service" | "field">,
): string {
  return `credential/${record.service}/${record.field}`;
}

/**
 * Derive the `service`/`field` identity of any non-empty account.
 *
 * `credential/<service>/<field>` keeps its historical split. Every other
 * account still names one logical secret, so it is split on its last `/` when
 * it has a path (`oauth_app/<id>/client_secret`), then on its last `:`
 * (`mcp:<server>/headers`), and otherwise the whole account becomes the
 * service with `value` as the field. The identity addresses both the record and
 * the Psono ref, so one account always maps to one entry.
 */
export function parseAccountIdentity(
  account: string,
): { service: string; field: string } | undefined {
  const key = account.trim();
  if (key === "") {
    return undefined;
  }
  const legacy = parseCredentialAccount(key);
  if (legacy) {
    return legacy;
  }
  const slashIdx = key.lastIndexOf("/");
  if (slashIdx > 0 && slashIdx < key.length - 1) {
    return {
      service: key.slice(0, slashIdx),
      field: key.slice(slashIdx + 1),
    };
  }
  const colonIdx = key.lastIndexOf(":");
  if (colonIdx > 0 && colonIdx < key.length - 1) {
    return {
      service: key.slice(0, colonIdx),
      field: key.slice(colonIdx + 1),
    };
  }
  return { service: key, field: "value" };
}

/**
 * Account a record was written under: the explicit `account` when it does not
 * derive from `service`/`field`, the canonical `credential/<service>/<field>`
 * otherwise.
 */
export function recordAccount(
  record: Pick<CredentialRecord, "service" | "field" | "account">,
): string {
  const stored = record.account?.trim();
  return stored ? stored : accountForRecord(record);
}

function isRecord(value: unknown): value is CredentialRecord {
  if (typeof value !== "object" || value == null) {
    return false;
  }
  const record = value as Record<string, unknown>;
  return (
    typeof record.credentialId === "string" &&
    typeof record.service === "string" &&
    typeof record.field === "string" &&
    (record.account === undefined || typeof record.account === "string") &&
    (record.ref === undefined || typeof record.ref === "string") &&
    (record.kind === undefined ||
      record.kind === "value" ||
      record.kind === "file" ||
      record.kind === "json") &&
    (record.sourceField === undefined ||
      typeof record.sourceField === "string") &&
    Array.isArray(record.allowedTools) &&
    Array.isArray(record.allowedDomains) &&
    typeof record.createdAt === "number" &&
    typeof record.updatedAt === "number"
  );
}

export class CesMetadataStore {
  constructor(private readonly metadataPath: string) {}

  getPath(): string {
    return this.metadataPath;
  }

  getByAccount(account: string): CredentialRecord | undefined {
    const identity = parseAccountIdentity(account);
    if (!identity) {
      return undefined;
    }
    return this.load().credentials.find(
      (record) =>
        record.service === identity.service &&
        record.field === identity.field,
    );
  }

  setByAccount(account: string, record: CredentialRecord): boolean {
    const key = account.trim();
    const identity = parseAccountIdentity(key);
    if (!identity) {
      return false;
    }
    if (
      identity.service !== record.service ||
      identity.field !== record.field
    ) {
      return false;
    }
    const data = this.load();
    const copy: CredentialRecord = { ...record };
    if (key === accountForRecord(record)) {
      delete copy.account;
    } else {
      copy.account = key;
    }
    const idx = data.credentials.findIndex(
      (entry) =>
        entry.service === record.service && entry.field === record.field,
    );
    if (idx === -1) {
      data.credentials.push(copy);
    } else {
      data.credentials[idx] = copy;
    }
    this.save(data);
    return true;
  }

  deleteByAccount(account: string): "deleted" | "not-found" | "error" {
    const identity = parseAccountIdentity(account);
    if (!identity) {
      return "error";
    }
    const data = this.load();
    const idx = data.credentials.findIndex(
      (entry) =>
        entry.service === identity.service && entry.field === identity.field,
    );
    if (idx === -1) {
      return "not-found";
    }
    data.credentials.splice(idx, 1);
    this.save(data);
    return "deleted";
  }

  list(): Array<{ account: string; record: CredentialRecord }> {
    return this.load().credentials.map((record) => ({
      account: recordAccount(record),
      record,
    }));
  }

  private load(): MetadataFile {
    if (!existsSync(this.metadataPath)) {
      return { version: CURRENT_VERSION, credentials: [] };
    }
    try {
      const parsed = JSON.parse(readFileSync(this.metadataPath, "utf-8")) as {
        credentials?: unknown;
      };
      const credentials = Array.isArray(parsed.credentials)
        ? parsed.credentials.filter(isRecord)
        : [];
      return { version: CURRENT_VERSION, credentials };
    } catch {
      return { version: CURRENT_VERSION, credentials: [] };
    }
  }

  private save(data: MetadataFile): void {
    const dir = dirname(this.metadataPath);
    if (!existsSync(dir)) {
      mkdirSync(dir, { recursive: true });
    }
    const tmpPath = join(dir, `.tmp-${randomUUID()}`);
    writeFileSync(tmpPath, JSON.stringify(data, null, 2), "utf-8");
    renameSync(tmpPath, this.metadataPath);
  }
}

let processStore: CesMetadataStore | undefined;

export function initMetadataStore(cesDataRoot: string): CesMetadataStore {
  processStore = new CesMetadataStore(getMetadataPath(cesDataRoot));
  return processStore;
}

export function getMetadataStore(): CesMetadataStore {
  if (!processStore) {
    processStore = new CesMetadataStore(getMetadataPath(getCesDataRoot()));
  }
  return processStore;
}

/** Test-only: drop the process store so the next init uses a fresh path. */
export function resetMetadataStoreForTests(): void {
  processStore = undefined;
}
