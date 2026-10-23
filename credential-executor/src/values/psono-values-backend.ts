/**
 * `keys.enc`-compatible backend served from Psono.
 *
 * The RPC CRUD contract is unchanged: `get` / `set` / `delete` / `list` take an
 * account string. `credential/<service>/<field>` accounts keep their historical
 * mapping; every other account (`mcp:<server>:headers`,
 * `oauth_app/<id>/client_secret`, ...) derives a stable `service`/`field`
 * identity, so it addresses one Psono entry like any credential. Values live in
 * Psono entries named by the record's `ref`; the CES metadata store keeps the
 * mapping and the account it was written under.
 *
 * `set` upserts the Psono entry and the record, `delete` removes both, and
 * `list` returns records that have a ref. The encrypted key store is not
 * touched: it stays the rollback path while `CES_VALUES_BACKEND=keys`.
 */

import { randomUUID } from "node:crypto";

import type { CredentialRecord } from "@vellumai/service-contracts/credential-rpc";
import type {
  SecureKeyBackend,
  SecureKeyDeleteResult,
} from "@vellumai/credential-storage";

import { asPsonoError } from "../psono/errors.js";
import { defaultStackRef } from "../psono/refs.js";
import type { SecretPayload } from "../psono/types.js";
import {
  parseAccountIdentity,
  type CesMetadataStore,
} from "../records/metadata-store.js";

/** Payload field that holds a migrated value. */
export const VALUE_SOURCE_FIELD = "password";

/** Narrow Psono surface the values backend needs. */
export interface PsonoValuesSource {
  resolve(service: string, field: string): Promise<{ value: string }>;
  resolveFile(service: string, field: string): Promise<{ bytes: Uint8Array }>;
  createEntry(
    ref: string,
    fields: SecretPayload,
    kind?: "value" | "file" | "json",
  ): Promise<unknown>;
  deleteEntry(ref: string): Promise<{ deleted: boolean }>;
  invalidate(): void;
}

export interface PsonoValuesBackendOptions {
  psono: PsonoValuesSource;
  records: CesMetadataStore;
  now?: () => number;
}

function isNotFound(err: unknown): boolean {
  return asPsonoError(err).kind === "not_found";
}

export class PsonoValuesBackend implements SecureKeyBackend {
  private readonly psono: PsonoValuesSource;
  private readonly records: CesMetadataStore;
  private readonly now: () => number;

  constructor(options: PsonoValuesBackendOptions) {
    this.psono = options.psono;
    this.records = options.records;
    this.now = options.now ?? Date.now;
  }

  async get(account: string): Promise<string | undefined> {
    const record = this.records.getByAccount(account);
    if (!record || typeof record.ref !== "string" || record.ref === "") {
      return undefined;
    }
    try {
      if (record.kind === "file") {
        const file = await this.psono.resolveFile(record.service, record.field);
        return new TextDecoder().decode(file.bytes);
      }
      const resolved = await this.psono.resolve(record.service, record.field);
      return resolved.value;
    } catch (err) {
      if (isNotFound(err)) {
        return undefined;
      }
      throw err;
    }
  }

  async set(account: string, value: string): Promise<boolean> {
    const identity = parseAccountIdentity(account);
    if (!identity) {
      return false;
    }
    const existing = this.records.getByAccount(account);
    const ref =
      existing?.ref && existing.ref.trim() !== ""
        ? existing.ref
        : defaultStackRef(identity.service, identity.field);

    await this.psono.createEntry(
      ref,
      {
        title: `${identity.service}/${identity.field}`,
        [VALUE_SOURCE_FIELD]: value,
      },
      "value",
    );
    this.psono.invalidate();

    const updatedAt = this.now();
    const record: CredentialRecord = {
      ...existing,
      credentialId: existing?.credentialId ?? randomUUID(),
      service: identity.service,
      field: identity.field,
      ref,
      kind: "value",
      sourceField: VALUE_SOURCE_FIELD,
      createdAt: existing?.createdAt ?? updatedAt,
      updatedAt,
    };
    return this.records.setByAccount(account, record);
  }

  async delete(account: string): Promise<SecureKeyDeleteResult> {
    const record = this.records.getByAccount(account);
    if (!record) {
      return "not-found";
    }
    const ref =
      record.ref && record.ref.trim() !== ""
        ? record.ref
        : defaultStackRef(record.service, record.field);
    try {
      await this.psono.deleteEntry(ref);
    } catch (err) {
      if (!isNotFound(err)) {
        return "error";
      }
    }
    this.psono.invalidate();
    const removed = this.records.deleteByAccount(account);
    return removed === "deleted" ? "deleted" : "error";
  }

  async list(): Promise<string[]> {
    return this.records
      .list()
      .filter(
        ({ record }) =>
          typeof record.ref === "string" && record.ref.trim() !== "",
      )
      .map(({ account }) => account)
      .sort();
  }
}
