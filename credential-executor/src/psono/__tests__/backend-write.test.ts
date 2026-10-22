import { beforeEach, describe, expect, test } from "bun:test";
import sodium from "libsodium-wrappers";

import {
  PsonoCredentialBackend,
  type PsonoClientSource,
  type RecordSource,
  type PsonoTreeSource,
} from "../backend.js";
import { bytesToHex, hexToBytes, secretBoxOpen, secretBoxSeal } from "../crypto.js";
import type { PsonoEntry, ShareHandle } from "../tree.js";
import type { PsonoShareContent, SecretPayload } from "../types.js";

await sodium.ready;

interface CreateCall {
  linkId: string;
  parentShareId: string;
  payload: SecretPayload;
}

class RewritingClient implements PsonoClientSource {
  readonly secrets = new Map<string, { key: Uint8Array; payload: SecretPayload }>();
  readonly createCalls: CreateCall[] = [];
  readonly deleted: string[] = [];
  private counter = 0;

  getStatus() {
    return {
      configured: true,
      sessionOpen: true,
      lastRefresh: null,
      lastError: null,
    };
  }

  async createSecret(input: {
    data: string;
    data_nonce: string;
    link_id: string;
    parent_share_id: string;
    callback_url: string;
    callback_user: string;
    callback_pass: string;
  }): Promise<{ secretId: string }> {
    const secretId = `secret-${++this.counter}`;
    // The fake keeps only the call metadata; the encrypted payload is opaque.
    this.createCalls.push({
      linkId: input.link_id,
      parentShareId: input.parent_share_id,
      payload: {},
    });
    this.secrets.set(secretId, {
      key: new Uint8Array(32),
      payload: { created: true },
    });
    return { secretId };
  }

  async updateSecret(
    secretId: string,
    payload: { data: string; data_nonce: string },
  ): Promise<void> {
    const record = this.secrets.get(secretId);
    if (!record) {
      throw new Error("unknown secret");
    }
    const opened = secretBoxOpen(
      hexToBytes(payload.data),
      hexToBytes(payload.data_nonce),
      record.key,
    );
    record.payload = JSON.parse(new TextDecoder().decode(opened)) as SecretPayload;
  }

  async deleteSecretLink(linkId: string): Promise<void> {
    this.deleted.push(linkId);
  }

  /** Load the real secret key from the share item, as the server would. */
  registerKey(secretId: string, keyHex: string): void {
    this.secrets.set(secretId, {
      key: hexToBytes(keyHex),
      payload: this.secrets.get(secretId)?.payload ?? {},
    });
  }
}

class MutableTree implements PsonoTreeSource {
  content: PsonoShareContent = {
    name: "Joanna-shared",
    items: [],
    folders: [],
  };
  readonly payloads = new Map<string, SecretPayload>();
  failShareWrite = false;

  async find(): Promise<PsonoEntry> {
    throw new Error("not used");
  }

  async readPayload(): Promise<SecretPayload> {
    throw new Error("not used");
  }

  async readRawPayload(entry: PsonoEntry): Promise<SecretPayload> {
    return this.payloads.get(entry.secretId) ?? {};
  }

  async openWritableShare(): Promise<ShareHandle> {
    const snapshot = structuredClone(this.content);
    return {
      shareId: "share-1",
      shareKey: new Uint8Array(32),
      content: snapshot,
      read: async () => structuredClone(this.content),
      update: async <T>(
        mutator: (content: PsonoShareContent) => T | Promise<T>,
      ): Promise<T> => {
        const current = structuredClone(this.content);
        const result = await mutator(current);
        if (this.failShareWrite) {
          throw new Error("share write failed");
        }
        this.content = current;
        return result;
      },
    };
  }

  invalidate(): void {}
}

const records: RecordSource = {
  getByAccount: () => undefined,
  list: () => [],
};

function backendWith(
  client: PsonoClientSource,
  tree: PsonoTreeSource,
): PsonoCredentialBackend {
  return new PsonoCredentialBackend({ client, tree, records });
}

/** Mirror the share items' secret keys into the fake client. */
function registerItems(client: RewritingClient, tree: MutableTree): void {
  for (const folder of tree.content.folders ?? []) {
    for (const item of folder.items ?? []) {
      if (item.secret_id && item.secret_key) {
        client.registerKey(item.secret_id, item.secret_key);
      }
    }
  }
}

describe("PsonoCredentialBackend writes", () => {
  let client: RewritingClient;
  let tree: MutableTree;

  beforeEach(() => {
    client = new RewritingClient();
    tree = new MutableTree();
  });

  test("creates an entry and links it into a folder", async () => {
    const backend = backendWith(client, tree);
    const result = await backend.createEntry(
      "_ces-write-test/entry-one",
      { title: "entry-one", password: "one" },
      "value",
    );

    expect(result.created).toBe(true);
    expect(client.createCalls).toHaveLength(1);
    expect(client.createCalls[0]!.parentShareId).toBe("share-1");

    const folder = tree.content.folders?.[0];
    expect(folder?.name).toBe("_ces-write-test");
    expect(folder?.items).toHaveLength(1);
    expect(folder?.items?.[0]?.name).toBe("entry-one");
    expect(folder?.items?.[0]?.type).toBe("website_password");
    expect(folder?.items?.[0]?.secret_key).toMatch(/^[0-9a-f]{64}$/);
  });

  test("creating the same ref twice updates instead of duplicating", async () => {
    const backend = backendWith(client, tree);
    await backend.createEntry("_ces-write-test/entry-one", { password: "one" });
    registerItems(client, tree);
    await backend.createEntry("_ces-write-test/entry-one", { password: "two" });

    expect(client.createCalls).toHaveLength(1);
    const items = tree.content.folders?.[0]?.items ?? [];
    expect(items).toHaveLength(1);
    expect(client.secrets.size).toBe(1);
  });

  test("a second entry does not drop the first item", async () => {
    const backend = backendWith(client, tree);
    await backend.createEntry("_ces-write-test/entry-one", { password: "one" });
    await backend.createEntry("_ces-write-test/entry-two", { password: "two" });

    const items = tree.content.folders?.[0]?.items ?? [];
    expect(items.map((item) => item.name).sort()).toEqual([
      "entry-one",
      "entry-two",
    ]);
  });

  test("updates an existing entry payload in place", async () => {
    const backend = backendWith(client, tree);
    await backend.createEntry("_ces-write-test/entry-one", {
      title: "entry-one",
      password: "one",
    });

    const item = tree.content.folders?.[0]?.items?.[0];
    client.registerKey(item!.secret_id!, item!.secret_key!);
    tree.payloads.set(item!.secret_id!, {
      website_password_title: "entry-one",
      website_password_password: "one",
    });

    const result = await backend.updateEntry("_ces-write-test/entry-one", {
      password: "two",
    });

    expect(result.created).toBe(false);
    expect(client.createCalls).toHaveLength(1);
    expect(client.secrets.get(item!.secret_id!)?.payload).toEqual({
      website_password_title: "entry-one",
      website_password_password: "two",
    });
  });

  test("rolls the orphan link back when the share write fails", async () => {
    const backend = backendWith(client, tree);
    tree.failShareWrite = true;

    await expect(
      backend.createEntry("_ces-write-test/entry-one", { password: "one" }),
    ).rejects.toThrow("share write failed");

    expect(client.createCalls).toHaveLength(1);
    expect(client.deleted).toHaveLength(1);
    expect(tree.content.folders).toEqual([]);
  });

  test("deletes the item and its link", async () => {
    const backend = backendWith(client, tree);
    await backend.createEntry("_ces-write-test/entry-one", { password: "one" });
    const item = tree.content.folders?.[0]?.items?.[0];

    const result = await backend.deleteEntry("_ces-write-test/entry-one");

    expect(result.deleted).toBe(true);
    expect(client.deleted).toEqual([item!.id!]);
    expect(tree.content.folders?.[0]?.items).toEqual([]);
  });

  test("deleting a missing entry is a no-op", async () => {
    const backend = backendWith(client, tree);
    const result = await backend.deleteEntry("_ces-write-test/missing");
    expect(result.deleted).toBe(false);
    expect(client.deleted).toEqual([]);
  });

  test("the generated secret key round-trips a payload", async () => {
    const key = sodium.crypto_secretbox_keygen();
    const sealed = secretBoxSeal(
      new TextEncoder().encode(JSON.stringify({ password: "value" })),
      key,
    );
    const opened = secretBoxOpen(
      sealed.ciphertext,
      sealed.nonce,
      key,
    );
    expect(JSON.parse(new TextDecoder().decode(opened))).toEqual({
      password: "value",
    });
    expect(bytesToHex(key)).toHaveLength(64);
  });
});
