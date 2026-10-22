/**
 * Read-only credential backend over Psono.
 *
 * Records in the CES metadata store map `service/field` to a logical `ref`.
 * The backend resolves that ref through the Psono tree, opens the entry, and
 * serves either one field (`resolve`), the whole payload (`KV v2`), or bytes
 * (`files`). Values are cached in RAM for 60 seconds.
 *
 * This backend is additive: the RPC CRUD path keeps using the existing
 * `keys.enc` backend.
 */

import type { CredentialRecord } from "@vellumai/service-contracts/credential-rpc";

import type { PsonoStatus } from "./client.js";
import { TtlCache } from "./cache.js";
import { notFound } from "./errors.js";
import { loadMaterialFromEnv } from "./material.js";
import { PsonoClient } from "./client.js";
import { PsonoTree, type PsonoEntry } from "./tree.js";
import {
  selectField,
  type SecretPayload,
} from "./types.js";

const VALUE_TTL_MS = 60_000;

export type RecordKind = "value" | "file" | "json";

export interface ResolvedValue {
  value: string;
  kind: RecordKind;
  ref: string;
}

export interface ResolvedFile {
  bytes: Uint8Array<ArrayBuffer>;
  kind: RecordKind;
  ref: string;
}

export interface RecordSource {
  getByAccount(account: string): CredentialRecord | undefined;
  list(): Array<{ account: string; record: CredentialRecord }>;
}

/** Narrow client surface the backend needs (status only). */
export interface PsonoStatusSource {
  getStatus(): PsonoStatus;
}

/** Narrow tree surface the backend needs. */
export interface PsonoTreeSource {
  find(ref: string): Promise<PsonoEntry>;
  readPayload(entry: PsonoEntry): Promise<SecretPayload>;
  invalidate(): void;
}

export interface PsonoBackendOptions {
  client: PsonoStatusSource;
  tree: PsonoTreeSource;
  records: RecordSource;
  now?: () => number;
  valueTtlMs?: number;
}

function normalizeRef(ref: string): string {
  return ref.replace(/^\/+|\/+$/g, "").toLowerCase();
}

function toValueString(value: unknown): string | undefined {
  if (typeof value === "string") {
    return value;
  }
  if (typeof value === "number" || typeof value === "boolean") {
    return String(value);
  }
  if (value != null && typeof value === "object") {
    return JSON.stringify(value);
  }
  return undefined;
}

export class PsonoCredentialBackend {
  private readonly client: PsonoStatusSource;
  private readonly tree: PsonoTreeSource;
  private readonly records: RecordSource;
  private readonly now: () => number;
  private readonly payloads: TtlCache<SecretPayload>;
  private readonly values: TtlCache<ResolvedValue>;
  private refs?: Set<string>;
  private refsBuiltAt = 0;
  private readonly refsTtlMs = 60_000;

  constructor(options: PsonoBackendOptions) {
    this.client = options.client;
    this.records = options.records;
    this.now = options.now ?? Date.now;
    this.tree = options.tree;
    this.payloads = new TtlCache<SecretPayload>(
      options.valueTtlMs ?? VALUE_TTL_MS,
      this.now,
    );
    this.values = new TtlCache<ResolvedValue>(
      options.valueTtlMs ?? VALUE_TTL_MS,
      this.now,
    );
  }

  getStatus(): PsonoStatus {
    return this.client.getStatus();
  }

  invalidate(): void {
    this.payloads.clear();
    this.values.clear();
    this.refs = undefined;
    this.tree.invalidate();
  }

  /** Read a whole entry by its logical ref, as a KV v2 field map. */
  async getByRef(ref: string): Promise<SecretPayload> {
    const knownRefs = this.getKnownRefs();
    if (!knownRefs.has(normalizeRef(ref))) {
      throw notFound();
    }
    const entry = await this.tree.find(ref);
    return this.getPayload(entry);
  }

  /** Resolve a `service/field` record to its value. */
  async resolve(service: string, field: string): Promise<ResolvedValue> {
    const record = this.getRecord(service, field);
    const kind: RecordKind = record.kind ?? "value";
    const cacheKey = `${normalizeRef(record.ref!)}|${field}|${kind}`;
    const cached = this.values.get(cacheKey);
    if (cached) {
      return cached;
    }

    const payload = await this.getByRef(record.ref!);
    const value = this.select(payload, record.field, kind);
    const result: ResolvedValue = { value, kind, ref: record.ref! };
    this.values.set(cacheKey, result);
    return result;
  }

  /** Resolve a `service/field` record to raw bytes. */
  async resolveFile(service: string, field: string): Promise<ResolvedFile> {
    const record = this.getRecord(service, field);
    const kind: RecordKind = record.kind ?? "value";
    const payload = await this.getByRef(record.ref!);
    const value = this.select(payload, record.field, kind);
    return {
      bytes: new TextEncoder().encode(value),
      kind,
      ref: record.ref!,
    };
  }

  private getRecord(service: string, field: string): CredentialRecord & {
    ref: string;
  } {
    const record = this.records.getByAccount(`credential/${service}/${field}`);
    if (!record || typeof record.ref !== "string" || record.ref.trim() === "") {
      throw notFound();
    }
    return { ...record, ref: record.ref };
  }

  private select(
    payload: SecretPayload,
    field: string,
    kind: RecordKind,
  ): string {
    if (kind === "json") {
      return JSON.stringify(payload);
    }
    const selected = selectField(payload, field);
    const value = toValueString(selected);
    if (value === undefined) {
      throw notFound();
    }
    return value;
  }

  private async getPayload(entry: PsonoEntry): Promise<SecretPayload> {
    const cached = this.payloads.get(entry.secretId);
    if (cached) {
      return cached;
    }
    const payload = await this.tree.readPayload(entry);
    this.payloads.set(entry.secretId, payload);
    return payload;
  }

  private getKnownRefs(): Set<string> {
    if (this.refs && this.now() - this.refsBuiltAt < this.refsTtlMs) {
      return this.refs;
    }
    const refs = new Set<string>();
    for (const { record } of this.records.list()) {
      if (typeof record.ref === "string" && record.ref.trim() !== "") {
        refs.add(normalizeRef(record.ref));
      }
    }
    this.refs = refs;
    this.refsBuiltAt = this.now();
    return refs;
  }
}

/**
 * Build the read-only backend from `PSONO_MATERIAL_FILE`.
 *
 * Returns `undefined` when the material is not configured; new endpoints then
 * answer `unavailable` instead of failing at startup.
 */
export function createPsonoBackendFromEnv(
  records: RecordSource,
): PsonoCredentialBackend | undefined {
  const material = loadMaterialFromEnv();
  if (!material) {
    return undefined;
  }
  const client = new PsonoClient({
    material,
    serverPublicKeyHex:
      material.serverPublicKeyHex ??
      (process.env["PSONO_SERVER_PUBLIC_KEY"]?.trim() || undefined),
  });
  const tree = new PsonoTree(client);
  return new PsonoCredentialBackend({ client, tree, records });
}
