import { describe, expect, test } from "bun:test";
import sodium from "libsodium-wrappers";

import { secretBoxOpen } from "../crypto.js";
import { PsonoTree, type PsonoTreeClient } from "../tree.js";
import {
  PsonoShareListSchema,
  type PsonoShareRight,
} from "../types.js";

await sodium.ready;

const SECRET_KEY_HEX = "33".repeat(32);

interface ShareRightFixture extends PsonoShareRight {
  id: string;
}

function shareRight(
  overrides: Partial<ShareRightFixture> = {},
): ShareRightFixture {
  return {
    id: "share-1",
    share_right_id: "right-1",
    share_right_key: "aabb",
    share_right_key_nonce: "ccdd",
    share_right_read: true,
    share_right_accepted: true,
    ...overrides,
  };
}

function sealShare(
  payload: Record<string, unknown>,
  key: Uint8Array,
): { data: string; data_nonce: string } {
  const nonce = sodium.randombytes_buf(sodium.crypto_secretbox_NONCEBYTES);
  const ciphertext = sodium.crypto_secretbox_easy(
    sodium.from_string(JSON.stringify(payload)),
    nonce,
    key,
  );
  return {
    data: sodium.to_hex(ciphertext),
    data_nonce: sodium.to_hex(nonce),
  };
}

interface AcceptCall {
  path: string;
  body: Record<string, unknown>;
}

class FakeClient implements PsonoTreeClient {
  readonly details = new Map<string, unknown>();
  readonly acceptedKey = sodium.crypto_secretbox_keygen();
  readonly userSecretKey = sodium.crypto_secretbox_keygen();
  readonly userKeyPair = sodium.crypto_box_keypair();
  readonly senderKeyPair = sodium.crypto_box_keypair();
  readonly acceptCalls: AcceptCall[] = [];
  shareListCalls = 0;
  shareListGate?: Promise<void>;
  shares: ShareRightFixture[];

  constructor(shares: ShareRightFixture[]) {
    this.shares = shares;
  }

  async request(path: string): Promise<unknown> {
    if (path === "/share/") {
      this.shareListCalls += 1;
      if (this.shareListGate) {
        await this.shareListGate;
      }
      return { shares: this.shares };
    }
    if (path === "/datastore/") {
      return { datastores: [] };
    }
    const match = /^\/share\/(.+)\/$/.exec(path);
    if (match) {
      const detail = this.details.get(decodeURIComponent(match[1]!));
      if (detail === undefined) {
        throw new Error("missing fixture");
      }
      return detail;
    }
    throw new Error(`unexpected request ${path}`);
  }

  async post(path: string, body: unknown): Promise<unknown> {
    this.acceptCalls.push({ path, body: body as Record<string, unknown> });
    const shareRightId = (body as { share_right_id?: string }).share_right_id;
    for (const share of this.shares) {
      if (share.share_right_id === shareRightId) {
        share.share_right_accepted = true;
        share.share_right_key = String(
          (body as { key?: string }).key ?? share.share_right_key,
        );
        share.share_right_key_nonce = String(
          (body as { key_nonce?: string }).key_nonce ??
            share.share_right_key_nonce,
        );
        share.share_right_key_type = "symmetric";
      }
    }
    return {};
  }

  async createSecret(): Promise<{ secretId: string }> {
    throw new Error("createSecret is not part of the read fixtures");
  }

  async updateSecret(): Promise<void> {
    throw new Error("updateSecret is not part of the read fixtures");
  }

  async deleteSecretLink(): Promise<void> {
    throw new Error("deleteSecretLink is not part of the read fixtures");
  }

  async updateShare(): Promise<void> {
    throw new Error("updateShare is not part of the read fixtures");
  }

  openUserKeyBox(): Uint8Array {
    return this.acceptedKey;
  }

  openAsymmetricBox(
    ciphertextHex: string,
    nonceHex: string,
    senderPublicKeyHex: string,
  ): Uint8Array {
    return sodium.crypto_box_open_easy(
      sodium.from_hex(ciphertextHex),
      sodium.from_hex(nonceHex),
      sodium.from_hex(senderPublicKeyHex),
      this.userKeyPair.privateKey,
    );
  }

  sealUserKeyBox(plaintext: Uint8Array): {
    ciphertextHex: string;
    nonceHex: string;
  } {
    const nonce = sodium.randombytes_buf(sodium.crypto_secretbox_NONCEBYTES);
    return {
      ciphertextHex: sodium.to_hex(
        sodium.crypto_secretbox_easy(plaintext, nonce, this.userSecretKey),
      ),
      nonceHex: sodium.to_hex(nonce),
    };
  }

  addEntry(shareId: string, name: string): void {
    this.details.set(shareId, {
      id: shareId,
      ...sealShare(
        { name, secret_id: `secret-${shareId}`, secret_key: SECRET_KEY_HEX },
        this.acceptedKey,
      ),
      rights: { read: true },
    });
  }

  /** Build a pending (asymmetric) share right for a share id. */
  pendingShare(id: string, overrides: Partial<ShareRightFixture> = {}): ShareRightFixture {
    const nonce = sodium.randombytes_buf(sodium.crypto_box_NONCEBYTES);
    const sealed = sodium.crypto_box_easy(
      this.acceptedKey,
      nonce,
      this.userKeyPair.publicKey,
      this.senderKeyPair.privateKey,
    );
    return shareRight({
      id,
      share_right_id: `right-${id}`,
      share_right_key: sodium.to_hex(sealed),
      share_right_key_nonce: sodium.to_hex(nonce),
      share_right_key_type: "symmetric",
      share_right_create_user_public_key: sodium.to_hex(
        this.senderKeyPair.publicKey,
      ),
      share_right_accepted: null,
      ...overrides,
    });
  }
}

describe("PsonoShareRightSchema", () => {
  test("accepts null in every share flag", () => {
    const parsed = PsonoShareListSchema.safeParse({
      shares: [
        shareRight({
          share_right_accepted: null,
          share_right_read: null,
          share_right_write: null,
          share_right_grant: null,
        }),
      ],
    });
    expect(parsed.success).toBe(true);
  });

  test("requires the share right id", () => {
    const { share_right_id: _omit, ...withoutId } = shareRight();
    expect(
      PsonoShareListSchema.safeParse({ shares: [withoutId] }).success,
    ).toBe(false);
  });

  test("keeps the optional key type and sender public key", () => {
    const parsed = PsonoShareListSchema.safeParse({
      shares: [
        shareRight({
          share_right_key_type: "asymmetric",
          share_right_create_user_public_key: "ab".repeat(32),
        }),
      ],
    });
    expect(parsed.success).toBe(true);
    if (parsed.success) {
      expect(parsed.data.shares[0]!.share_right_key_type).toBe("asymmetric");
      expect(parsed.data.shares[0]!.share_right_create_user_public_key).toBe(
        "ab".repeat(32),
      );
    }
  });
});

describe("PsonoTree share collection", () => {
  test("skips a pending share whose key cannot be opened either way", async () => {
    const client = new FakeClient([
      shareRight({ id: "pending", share_right_accepted: null }),
    ]);
    client.openUserKeyBox = () => {
      throw new Error("unopenable");
    };
    const tree = new PsonoTree(client);
    await expect(tree.find("anything")).rejects.toMatchObject({
      kind: "not_found",
    });
    expect(client.acceptCalls).toHaveLength(0);
  });

  test("accepts a pending asymmetric share and indexes it", async () => {
    const client = new FakeClient([]);
    client.shares = [client.pendingShare("fresh")];
    client.addEntry("fresh", "FRESH");

    const tree = new PsonoTree(client);
    const entry = await tree.find("FRESH");

    expect(entry.secretId).toBe("secret-fresh");
    expect(client.acceptCalls).toHaveLength(1);
    const call = client.acceptCalls[0]!;
    expect(call.path).toBe("/share/right/accept/");
    expect(call.body["share_right_id"]).toBe("right-fresh");
    expect(call.body["key_type"]).toBe("symmetric");
    expect(typeof call.body["key"]).toBe("string");
    expect(typeof call.body["key_nonce"]).toBe("string");

    // The accepted key is re-sealed for the user secret key.
    const opened = secretBoxOpen(
      sodium.from_hex(call.body["key"] as string),
      sodium.from_hex(call.body["key_nonce"] as string),
      client.userSecretKey,
    );
    expect(opened).toEqual(client.acceptedKey);
  });

  test("builds the index once for concurrent lookups", async () => {
    const client = new FakeClient([shareRight({ id: "usable" })]);
    client.addEntry("usable", "VALID");
    let release!: () => void;
    client.shareListGate = new Promise<void>((resolve) => {
      release = resolve;
    });

    const tree = new PsonoTree(client);
    const pending = Promise.all([tree.find("VALID"), tree.find("VALID")]);
    await Promise.resolve();
    release();

    const [first, second] = await pending;
    expect(first.secretId).toBe("secret-usable");
    expect(second.secretId).toBe(first.secretId);
    expect(client.shareListCalls).toBe(1);
  });

  test("does not repeat the accept on a second build", async () => {
    const client = new FakeClient([]);
    client.shares = [client.pendingShare("fresh")];
    client.addEntry("fresh", "FRESH");

    const tree = new PsonoTree(client, Date.now, 0);
    await tree.find("FRESH");
    await tree.find("FRESH");
    expect(client.acceptCalls).toHaveLength(1);
  });

  test("returns only the usable shares from a mixed list", async () => {
    const client = new FakeClient([
      shareRight({ id: "usable", share_right_accepted: true }),
    ]);
    client.addEntry("usable", "VALID");

    const tree = new PsonoTree(client);
    const entry = await tree.find("VALID");
    expect(entry.secretId).toBe("secret-usable");
    expect(entry.source).toBe("share");
    expect(client.acceptCalls).toHaveLength(0);
  });

  test("skips a share whose key cannot be opened", async () => {
    const client = new FakeClient([
      shareRight({ id: "broken", share_right_accepted: true }),
    ]);
    client.openUserKeyBox = () => {
      throw new Error("unopenable");
    };
    client.addEntry("broken", "BROKEN");

    const tree = new PsonoTree(client);
    await expect(tree.find("BROKEN")).rejects.toMatchObject({
      kind: "not_found",
    });
  });

  test("keeps skipping accepted=false and read=false", async () => {
    const client = new FakeClient([
      shareRight({ id: "not-accepted", share_right_accepted: false }),
      shareRight({ id: "read-only", share_right_read: false }),
    ]);

    const tree = new PsonoTree(client);
    await expect(tree.find("anything")).rejects.toMatchObject({
      kind: "not_found",
    });
    expect(client.acceptCalls).toHaveLength(0);
  });

  test("does not accept an expired pending share", async () => {
    const client = new FakeClient([]);
    client.shares = [
      client.pendingShare("old", {
        share_right_expiration_date: new Date(
          Date.now() - 60_000,
        ).toISOString(),
      }),
    ];
    client.addEntry("old", "OLD");

    const tree = new PsonoTree(client);
    await expect(tree.find("OLD")).rejects.toMatchObject({
      kind: "not_found",
    });
    expect(client.acceptCalls).toHaveLength(0);
  });

  test("treats an absent accepted flag as accepted", async () => {
    const client = new FakeClient([shareRight({ id: "legacy" })]);
    delete (client.shares[0] as Partial<ShareRightFixture>).share_right_accepted;
    client.addEntry("legacy", "LEGACY");

    const tree = new PsonoTree(client);
    await expect(tree.find("LEGACY")).resolves.toMatchObject({
      secretId: "secret-legacy",
    });
    expect(client.acceptCalls).toHaveLength(0);
  });
});
