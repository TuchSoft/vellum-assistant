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

import { randomUUID } from "node:crypto";

import type { CredentialRecord } from "@vellumai/service-contracts/credential-rpc";

import type { PsonoStatus } from "./client.js";
import { TtlCache } from "./cache.js";
import {
  bytesToHex,
  generateSecretKey,
  hexToBytes,
  secretBoxSeal,
  utf8ToBytes,
} from "./crypto.js";
import { denied, notFound } from "./errors.js";
import { loadMaterialFromEnv } from "./material.js";
import { PsonoClient } from "./client.js";
import {
  PsonoTree,
  type PsonoEntry,
  type ShareHandle,
} from "./tree.js";
import {
  selectField,
  type PsonoShareContent,
  type PsonoShareFolder,
  type PsonoShareItem,
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

/** Narrow client surface the backend needs (status and writes). */
export interface PsonoStatusSource {
  getStatus(): PsonoStatus;
}

export interface PsonoWriteClient {
  createSecret(input: {
    data: string;
    data_nonce: string;
    link_id: string;
    parent_share_id: string;
    callback_url: string;
    callback_user: string;
    callback_pass: string;
  }): Promise<{ secretId: string }>;
  updateSecret(
    secretId: string,
    payload: { data: string; data_nonce: string },
  ): Promise<void>;
  deleteSecretLink(linkId: string): Promise<void>;
}

export interface PsonoClientSource extends PsonoStatusSource, PsonoWriteClient {}

/** Narrow tree surface the backend needs. */
export interface PsonoTreeSource {
  find(ref: string): Promise<PsonoEntry>;
  readPayload(entry: PsonoEntry): Promise<SecretPayload>;
  readRawPayload(entry: PsonoEntry): Promise<SecretPayload>;
  openWritableShare(): Promise<ShareHandle>;
  invalidate(): void;
}

export interface PsonoBackendOptions {
  client: PsonoClientSource;
  tree: PsonoTreeSource;
  records: RecordSource;
  now?: () => number;
  valueTtlMs?: number;
}

export interface EntryWriteResult {
  created: boolean;
}

export interface EntryDeleteResult {
  deleted: boolean;
}

/** Psono entry type used for each logical record kind. */
function psonoTypeForKind(kind: RecordKind): string {
  switch (kind) {
    case "file":
      return "file";
    case "json":
      return "note";
    default:
      return "website_password";
  }
}

/**
 * Prefix payload keys with the entry type, which is how Psono stores them and
 * what `normalizePayload` strips again on read.
 */
function toPsonoPayload(
  type: string,
  fields: SecretPayload,
): SecretPayload {
  const prefix = `${type}_`;
  const payload: SecretPayload = {};
  for (const [key, value] of Object.entries(fields)) {
    payload[key.startsWith(prefix) ? key : `${prefix}${key}`] = value;
  }
  return payload;
}

function splitRef(ref: string): { folderPath: string[]; name: string } {
  const parts = ref
    .split("/")
    .map((part) => part.trim())
    .filter((part) => part.length > 0);
  if (parts.length === 0) {
    throw denied("Psono reference is invalid");
  }
  return {
    folderPath: parts.slice(0, -1),
    name: parts[parts.length - 1]!,
  };
}

function findFolder(
  root: PsonoShareContent,
  path: string[],
): PsonoShareFolder | undefined {
  let current: PsonoShareFolder = root;
  for (const segment of path) {
    const next = (current.folders ?? []).find(
      (folder) => folder.deleted !== true && folder.name === segment,
    );
    if (!next) {
      return undefined;
    }
    current = next;
  }
  return current;
}

function ensureFolder(
  root: PsonoShareContent,
  path: string[],
): PsonoShareFolder {
  let current: PsonoShareFolder = root;
  for (const segment of path) {
    if (!Array.isArray(current.folders)) {
      current.folders = [];
    }
    let next = current.folders.find(
      (folder) => folder.deleted !== true && folder.name === segment,
    );
    if (!next) {
      next = { id: randomUUID(), name: segment };
      current.folders.push(next);
    }
    current = next;
  }
  return current;
}

/**
 * Drop the share root segment when a ref is fully qualified.
 *
 * Refs name the shared folder (`Joanna-shared/stack/...`), while the writable
 * share payload is already rooted at that folder. Removing the leading segment
 * keeps the write in the folder the index reports.
 */
function relativeFolderPath(
  content: PsonoShareContent,
  folderPath: string[],
): string[] {
  const root = normalizeRef(content.name ?? "");
  if (root && folderPath.length > 0 && normalizeRef(folderPath[0]!) === root) {
    return folderPath.slice(1);
  }
  return folderPath;
}

function findItem(
  folder: PsonoShareFolder,
  name: string,
): PsonoShareItem | undefined {
  const target = name.toLowerCase();
  return (folder.items ?? []).find(
    (item) => item.deleted !== true && item.name?.toLowerCase() === target,
  );
}

function itemEntry(
  item: PsonoShareItem,
  type: string | undefined,
): PsonoEntry | undefined {
  if (
    typeof item.secret_id !== "string" ||
    typeof item.secret_key !== "string" ||
    typeof item.name !== "string"
  ) {
    return undefined;
  }
  return {
    path: item.name,
    name: item.name,
    type: item.type ?? type,
    secretId: item.secret_id,
    secretKey: hexToBytes(item.secret_key),
    source: "share",
  };
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
  private readonly client: PsonoClientSource;
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

  /**
   * Create or update an entry from its logical ref.
   *
   * The ref's last segment is the entry name; the preceding segments are a
   * folder path relative to the writable share root, created on demand. An
   * existing entry with the same name is updated, never duplicated.
   */
  async createEntry(
    ref: string,
    fields: SecretPayload,
    kind: RecordKind = "value",
  ): Promise<EntryWriteResult> {
    return this.upsertEntry(ref, fields, kind);
  }

  /** Update an entry; creates it when the ref does not exist yet. */
  async updateEntry(
    ref: string,
    fields: SecretPayload,
    kind: RecordKind = "value",
  ): Promise<EntryWriteResult> {
    return this.upsertEntry(ref, fields, kind);
  }

  /** Delete an entry from the share, then delete the backing secret. */
  async deleteEntry(ref: string): Promise<EntryDeleteResult> {
    const handle = await this.tree.openWritableShare();
    const { folderPath, name } = splitRef(ref);

    let removed: PsonoShareItem | undefined;
    const result = await handle.update((content) => {
      const folder = findFolder(
        content,
        relativeFolderPath(content, folderPath),
      );
      const item = folder ? findItem(folder, name) : undefined;
      if (!folder || !item || !Array.isArray(folder.items)) {
        return { deleted: false };
      }
      folder.items = folder.items.filter((candidate) => candidate !== item);
      removed = item;
      return { deleted: true };
    });

    if (removed && typeof removed.id === "string") {
      await this.client.deleteSecretLink(removed.id);
    }
    this.invalidate();
    return result;
  }

  private async upsertEntry(
    ref: string,
    fields: SecretPayload,
    kind: RecordKind,
  ): Promise<EntryWriteResult> {
    const handle = await this.tree.openWritableShare();
    const { folderPath, name } = splitRef(ref);
    const createdLinkIds: string[] = [];

    try {
      const result = await handle.update(async (content) => {
        const folder = ensureFolder(
          content,
          relativeFolderPath(content, folderPath),
        );
        const existing = findItem(folder, name);

        if (existing) {
          await this.updateExistingItem(existing, fields, kind);
          return { created: false };
        }

        if (!Array.isArray(folder.items)) {
          folder.items = [];
        }
        const type = psonoTypeForKind(kind);
        const secretKey = generateSecretKey();
        const sealed = secretBoxSeal(
          utf8ToBytes(JSON.stringify(toPsonoPayload(type, fields))),
          secretKey,
        );
        const linkId = randomUUID();
        const { secretId } = await this.client.createSecret({
          data: bytesToHex(sealed.ciphertext),
          data_nonce: bytesToHex(sealed.nonce),
          link_id: linkId,
          parent_share_id: handle.shareId,
          callback_url: "",
          callback_user: "",
          callback_pass: "",
        });
        createdLinkIds.push(linkId);
        folder.items.push({
          id: linkId,
          name,
          type,
          secret_id: secretId,
          secret_key: bytesToHex(secretKey),
          urlfilter: "",
        });
        return { created: true };
      });
      this.invalidate();
      return result;
    } catch (err) {
      // The share write failed after the secret existed on the server: remove
      // the orphan link so a retry does not leave a dangling entry behind.
      for (const linkId of createdLinkIds) {
        try {
          await this.client.deleteSecretLink(linkId);
        } catch {
          // Best effort: the original error is the one worth surfacing.
        }
      }
      throw err;
    }
  }

  private async updateExistingItem(
    item: PsonoShareItem,
    fields: SecretPayload,
    kind: RecordKind,
  ): Promise<void> {
    const type = item.type ?? psonoTypeForKind(kind);
    const entry = itemEntry(item, type);
    if (!entry) {
      throw denied("Psono share item is not usable");
    }
    const current = await this.tree.readRawPayload(entry);
    const merged: SecretPayload = {
      ...current,
      ...toPsonoPayload(type, fields),
    };
    const sealed = secretBoxSeal(
      utf8ToBytes(JSON.stringify(merged)),
      entry.secretKey,
    );
    await this.client.updateSecret(entry.secretId, {
      data: bytesToHex(sealed.ciphertext),
      data_nonce: bytesToHex(sealed.nonce),
    });
  }

  invalidate(): void {
    this.payloads.clear();
    this.values.clear();
    this.refs = undefined;
    this.tree.invalidate();
  }

  /**
   * Read a whole entry by its logical ref without consulting the credential
   * map.
   *
   * Used to verify a write before the corresponding record points at the ref,
   * and by the one-time migration.
   */
  async readEntryPayload(ref: string): Promise<SecretPayload> {
    const entry = await this.tree.find(ref);
    return this.getPayload(entry);
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
    // Value records name the payload field explicitly: migrated entries keep
    // the value in `password` while the credential field is the service name.
    const sourceField =
      kind === "value" ? (record.sourceField ?? record.field) : record.field;
    const value = this.select(payload, sourceField, kind);
    const result: ResolvedValue = { value, kind, ref: record.ref! };
    this.values.set(cacheKey, result);
    return result;
  }

  /** Resolve a `service/field` record to raw bytes. */
  async resolveFile(service: string, field: string): Promise<ResolvedFile> {
    const record = this.getRecord(service, field);
    const kind: RecordKind = record.kind ?? "value";
    const payload = await this.getByRef(record.ref!);
    const sourceField =
      kind === "value" ? (record.sourceField ?? record.field) : record.field;
    const value = this.select(payload, sourceField, kind);
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
