/**
 * Psono tree navigation.
 *
 * Walks every share `joanna` can read (individually shared entries and shared
 * folders) plus her own password datastores, decrypting share and datastore
 * keys, and builds an in-RAM index of `path -> entry`. The index expires after
 * a short TTL so a new share or a revocation is observed without a restart.
 */

import { getLogger } from "../logger.js";
import { hexToBytes, secretBoxOpen } from "./crypto.js";
import { notFound, unavailable } from "./errors.js";
import {
  PsonoDatastoreDetailSchema,
  PsonoDatastoreListSchema,
  PsonoSecretDetailSchema,
  PsonoShareDetailSchema,
  PsonoShareListSchema,
  normalizePayload,
  type PsonoShareRight,
  type SecretPayload,
} from "./types.js";

const TREE_TTL_MS = 60_000;

const log = getLogger("psono");

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
  post(path: string, body: unknown): Promise<unknown>;
  openUserKeyBox(ciphertextHex: string, nonceHex: string): Uint8Array;
  openAsymmetricBox(
    ciphertextHex: string,
    nonceHex: string,
    senderPublicKeyHex: string,
  ): Uint8Array;
  sealUserKeyBox(plaintext: Uint8Array): {
    ciphertextHex: string;
    nonceHex: string;
  };
}

type ShareRight = PsonoShareRight;

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

function isExpired(
  expirationDate: string | null | undefined,
  now: number,
): boolean {
  if (!expirationDate) {
    return false;
  }
  const at = Date.parse(expirationDate);
  return Number.isFinite(at) && at < now;
}

export class PsonoTree {
  private index?: EntryIndex;
  private indexPromise?: Promise<EntryIndex>;
  private indexBuiltAt = 0;
  private acceptedSinceBuild = false;
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

  /**
   * Return the current index, collapsing concurrent callers onto one build.
   *
   * Two references resolved in parallel would otherwise walk the whole share
   * tree twice. The second caller awaits the first build and reuses it; a
   * failed build rejects every waiter and clears the in-flight promise, so a
   * later call retries.
   */
  private async getIndex(): Promise<EntryIndex> {
    if (
      this.index &&
      this.now() - this.indexBuiltAt < this.ttlMs
    ) {
      return this.index;
    }
    if (!this.indexPromise) {
      this.indexPromise = this.buildIndex().finally(() => {
        this.indexPromise = undefined;
      });
    }
    return this.indexPromise;
  }

  private async buildIndex(): Promise<EntryIndex> {
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
    if (this.acceptedSinceBuild) {
      // A share was accepted while collecting: the server list changed, so the
      // next build must read it again rather than reuse this snapshot.
      this.acceptedSinceBuild = false;
      this.indexBuiltAt = 0;
    }
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

    let skippedPending = 0;
    let skippedExpired = 0;
    let skippedNoAccess = 0;
    let skippedKey = 0;
    let skippedPayload = 0;
    let accepted = 0;

    for (const right of list.data.shares) {
      // A share right that the recipient has not accepted yet has a null
      // accepted flag and a share key that cannot be opened with the user
      // secret key. It is pending, not an error, and must not hide the shares
      // that are usable.
      if (right.share_right_accepted === false) {
        continue;
      }
      if (right.share_right_read === false) {
        continue;
      }
      if (
        isExpired(
          right.expiration_date ?? right.share_right_expiration_date,
          this.now(),
        )
      ) {
        skippedExpired += 1;
        continue;
      }

      let shareKey: Uint8Array | undefined;
      if (right.share_right_accepted === null) {
        const pendingKey = this.openShareKey(right);
        if (!pendingKey) {
          skippedPending += 1;
          continue;
        }
        try {
          await this.acceptShare(right, pendingKey);
        } catch {
          skippedPending += 1;
          continue;
        }
        accepted += 1;
        shareKey = pendingKey;
      } else {
        shareKey = this.openShareKey(right);
      }

      if (!shareKey) {
        skippedKey += 1;
        continue;
      }

      const detailRaw = await this.client.request(
        `/share/${encodeURIComponent(right.id)}/`,
      );
      const detail = PsonoShareDetailSchema.safeParse(detailRaw);
      if (!detail.success) {
        skippedNoAccess += 1;
        continue;
      }
      if (detail.data.rights?.read === false) {
        skippedNoAccess += 1;
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
        skippedPayload += 1;
        continue;
      }
      if (!isRecord(data)) {
        skippedPayload += 1;
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

    const skipped =
      skippedPending +
      skippedExpired +
      skippedNoAccess +
      skippedKey +
      skippedPayload;
    if (accepted > 0) {
      this.acceptedSinceBuild = true;
    }
    if (skipped > 0 || accepted > 0) {
      log.debug(
        {
          accepted,
          skipped,
          skippedPending,
          skippedExpired,
          skippedNoAccess,
          skippedKey,
          skippedPayload,
        },
        "Processed Psono shares",
      );
    }
  }

  /**
   * Open a share key with whichever scheme the right is in.
   *
   * `share_right_key_type` is advisory: a server can label an
   * asymmetrically sealed key as `symmetric`. Try the declared scheme first,
   * then the other one when a sender public key makes it possible.
   */
  private openShareKey(right: ShareRight): Uint8Array | undefined {
    const senderPublicKey = right.share_right_create_user_public_key;
    const symmetric = (): Uint8Array =>
      this.client.openUserKeyBox(
        right.share_right_key,
        right.share_right_key_nonce,
      );
    const asymmetric = (): Uint8Array => {
      if (!senderPublicKey) {
        throw unavailable("Psono share right has no sender public key");
      }
      return this.client.openAsymmetricBox(
        right.share_right_key,
        right.share_right_key_nonce,
        senderPublicKey,
      );
    };

    const attempts =
      right.share_right_key_type === "symmetric"
        ? [symmetric, asymmetric]
        : [asymmetric, symmetric];
    for (const attempt of attempts) {
      try {
        return attempt();
      } catch {
        continue;
      }
    }
    return undefined;
  }

  /**
   * Accept a pending share right: re-seal its key with the user's secret key
   * and tell the server, so the right becomes a normal symmetric one.
   */
  private async acceptShare(
    right: ShareRight,
    shareKey: Uint8Array,
  ): Promise<void> {
    const sealed = this.client.sealUserKeyBox(shareKey);
    await this.client.post("/share/right/accept/", {
      share_right_id: right.share_right_id,
      key: sealed.ciphertextHex,
      key_nonce: sealed.nonceHex,
      key_type: "symmetric",
    });
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
