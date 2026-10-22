/**
 * Psono tree navigation.
 *
 * Walks every share `joanna` can read (individually shared entries and shared
 * folders) plus her own password datastores, decrypting share and datastore
 * keys, and builds an in-RAM index of `path -> entry`. The index expires after
 * a short TTL so a new share or a revocation is observed without a restart.
 */

import { hexToBytes, secretBoxOpen } from "./crypto.js";
import { notFound, unavailable } from "./errors.js";
import {
  PsonoDatastoreDetailSchema,
  PsonoDatastoreListSchema,
  PsonoSecretDetailSchema,
  PsonoShareDetailSchema,
  PsonoShareListSchema,
  normalizePayload,
  type SecretPayload,
} from "./types.js";

const TREE_TTL_MS = 60_000;

export interface PsonoEntry {
  /** Slash-separated logical path inside the visible tree. */
  path: string;
  name: string;
  type?: string;
  secretId: string;
  secretKey: Uint8Array;
  source: "share" | "datastore";
}

export interface EntryIndex {
  entries: PsonoEntry[];
  byPath: Map<string, PsonoEntry>;
}

export interface PsonoTreeClient {
  request(path: string): Promise<unknown>;
  openUserKeyBox(ciphertextHex: string, nonceHex: string): Uint8Array;
}

interface FolderItem {
  id?: string;
  type?: string;
  name?: string;
  secret_id?: string;
  secret_key?: string;
}

interface FolderNode {
  id?: string;
  name?: string;
  items?: FolderItem[];
  folders?: FolderNode[];
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value != null && typeof value === "object" && !Array.isArray(value);
}

function joinPath(...parts: Array<string | undefined>): string {
  return parts
    .flatMap((part) => (part ? part.split("/") : []))
    .map((part) => part.trim())
    .filter((part) => part.length > 0)
    .join("/");
}

function indexKey(path: string): string {
  return path.replace(/^\/+|\/+$/g, "").toLowerCase();
}

export class PsonoTree {
  private index?: EntryIndex;
  private indexBuiltAt = 0;
  private readonly ttlMs: number;

  constructor(
    private readonly client: PsonoTreeClient,
    private readonly now: () => number = Date.now,
    ttlMs = TREE_TTL_MS,
  ) {
    this.ttlMs = ttlMs;
  }

  invalidate(): void {
    this.index = undefined;
    this.indexBuiltAt = 0;
  }

  /** Resolve a logical reference to a visible entry. */
  async find(ref: string): Promise<PsonoEntry> {
    const index = await this.getIndex();
    const normalized = indexKey(ref);
    if (!normalized) {
      throw notFound();
    }

    const exact = index.byPath.get(normalized);
    if (exact) {
      return exact;
    }

    const byName = index.entries.filter(
      (entry) => indexKey(entry.name) === normalized,
    );
    if (byName.length === 1) {
      return byName[0]!;
    }

    const suffix = `.${normalized}`;
    const bySuffix = index.entries.filter((entry) => {
      const key = indexKey(entry.path);
      return key === normalized || key.endsWith(`/${normalized}`) || key.endsWith(suffix);
    });
    if (bySuffix.length === 1) {
      return bySuffix[0]!;
    }

    throw notFound();
  }

  /** Read and decrypt an entry's payload. */
  async readPayload(entry: PsonoEntry): Promise<SecretPayload> {
    const body = PsonoSecretDetailSchema.safeParse(
      await this.client.request(`/secret/${encodeURIComponent(entry.secretId)}/`),
    );
    if (!body.success) {
      throw unavailable("Psono secret response has an unexpected shape");
    }
    let opened: Uint8Array;
    try {
      opened = secretBoxOpen(
        hexToBytes(body.data.data),
        hexToBytes(body.data.data_nonce),
        entry.secretKey,
      );
    } catch {
      throw unavailable("Psono secret payload could not be decrypted");
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(new TextDecoder().decode(opened));
    } catch {
      throw unavailable("Psono secret payload is not JSON");
    }
    if (!isRecord(parsed)) {
      throw unavailable("Psono secret payload is not an object");
    }
    return normalizePayload(parsed, entry.type ?? body.data.type);
  }

  private async getIndex(): Promise<EntryIndex> {
    if (
      this.index &&
      this.now() - this.indexBuiltAt < this.ttlMs
    ) {
      return this.index;
    }

    const entries: PsonoEntry[] = [];
    const byPath = new Map<string, PsonoEntry>();

    const add = (entry: Omit<PsonoEntry, "path"> & { path: string }): void => {
      const stablePath = joinPath(entry.path);
      const key = indexKey(stablePath);
      if (!key || byPath.has(key)) {
        return;
      }
      const value: PsonoEntry = { ...entry, path: stablePath };
      entries.push(value);
      byPath.set(key, value);
    };

    await this.collectShares(add);
    await this.collectDatastores(add);

    this.index = { entries, byPath };
    this.indexBuiltAt = this.now();
    return this.index;
  }

  private async collectShares(
    add: (entry: PsonoEntry) => void,
  ): Promise<void> {
    const listRaw = await this.client.request("/share/");
    const list = PsonoShareListSchema.safeParse(listRaw);
    if (!list.success) {
      throw unavailable("Psono share list has an unexpected shape");
    }

    for (const right of list.data.shares) {
      if (right.share_right_accepted === false) {
        continue;
      }
      if (right.share_right_read === false) {
        continue;
      }

      let shareKey: Uint8Array;
      try {
        shareKey = this.client.openUserKeyBox(
          right.share_right_key,
          right.share_right_key_nonce,
        );
      } catch {
        continue;
      }

      const detailRaw = await this.client.request(
        `/share/${encodeURIComponent(right.id)}/`,
      );
      const detail = PsonoShareDetailSchema.safeParse(detailRaw);
      if (!detail.success) {
        continue;
      }
      if (detail.data.rights?.read === false) {
        continue;
      }

      let data: SecretPayload;
      try {
        data = JSON.parse(
          new TextDecoder().decode(
            secretBoxOpen(
              hexToBytes(detail.data.data),
              hexToBytes(detail.data.data_nonce),
              shareKey,
            ),
          ),
        ) as SecretPayload;
      } catch {
        continue;
      }
      if (!isRecord(data)) {
        continue;
      }

      if (typeof data["secret_id"] === "string" && typeof data["secret_key"] === "string") {
        const name =
          typeof data["name"] === "string" ? data["name"] : right.id;
        add({
          path: name,
          name,
          type: typeof data["type"] === "string" ? data["type"] : undefined,
          secretId: data["secret_id"],
          secretKey: hexToBytes(data["secret_key"]),
          source: "share",
        });
        continue;
      }

      const rootName = typeof data["name"] === "string" ? data["name"] : right.id;
      this.walkFolder(data as unknown as FolderNode, rootName, "share", add);
    }
  }

  private async collectDatastores(
    add: (entry: PsonoEntry) => void,
  ): Promise<void> {
    const listRaw = await this.client.request("/datastore/");
    const list = PsonoDatastoreListSchema.safeParse(listRaw);
    if (!list.success) {
      throw unavailable("Psono datastore list has an unexpected shape");
    }

    for (const datastore of list.data.datastores) {
      if (datastore.type !== "password") {
        continue;
      }
      const detailRaw = await this.client.request(
        `/datastore/${encodeURIComponent(datastore.id)}/`,
      );
      const detail = PsonoDatastoreDetailSchema.safeParse(detailRaw);
      if (!detail.success) {
        continue;
      }

      let datastoreKey: Uint8Array;
      try {
        datastoreKey = this.client.openUserKeyBox(
          detail.data.secret_key,
          detail.data.secret_key_nonce,
        );
      } catch {
        continue;
      }

      let data: unknown;
      try {
        data = JSON.parse(
          new TextDecoder().decode(
            secretBoxOpen(
              hexToBytes(detail.data.data),
              hexToBytes(detail.data.data_nonce),
              datastoreKey,
            ),
          ),
        );
      } catch {
        continue;
      }
      if (!isRecord(data)) {
        continue;
      }

      const rootName = detail.data.description ?? datastore.description ?? "datastore";
      this.walkFolder(data as unknown as FolderNode, rootName, "datastore", add);
    }
  }

  private walkFolder(
    node: FolderNode,
    prefix: string,
    source: "share" | "datastore",
    add: (entry: PsonoEntry) => void,
  ): void {
    for (const item of node.items ?? []) {
      if (
        typeof item.secret_id !== "string" ||
        typeof item.secret_key !== "string" ||
        typeof item.name !== "string"
      ) {
        continue;
      }
      add({
        path: joinPath(prefix, item.name),
        name: item.name,
        type: typeof item.type === "string" ? item.type : undefined,
        secretId: item.secret_id,
        secretKey: hexToBytes(item.secret_key),
        source,
      });
    }
    for (const folder of node.folders ?? []) {
      const name = typeof folder.name === "string" ? folder.name : undefined;
      this.walkFolder(folder, joinPath(prefix, name), source, add);
    }
  }
}
