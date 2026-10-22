import { describe, expect, test } from "bun:test";
import sodium from "libsodium-wrappers";

import { PsonoTree, type PsonoTreeClient } from "../tree.js";
import { PsonoShareListSchema } from "../types.js";

await sodium.ready;

const SECRET_KEY_HEX = "33".repeat(32);

interface ShareRightFixture {
  id: string;
  share_right_key?: string;
  share_right_key_nonce?: string;
  share_right_read?: boolean | null;
  share_right_write?: boolean | null;
  share_right_grant?: boolean | null;
  share_right_accepted?: boolean | null;
}

function shareRight(overrides: Partial<ShareRightFixture> = {}): ShareRightFixture {
  return {
    id: "share-1",
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

class FakeClient implements PsonoTreeClient {
  readonly details = new Map<string, unknown>();
  readonly acceptedKey = sodium.crypto_secretbox_keygen();

  constructor(readonly shares: ShareRightFixture[]) {}

  async request(path: string): Promise<unknown> {
    if (path === "/share/") {
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

  openUserKeyBox(): Uint8Array {
    return this.acceptedKey;
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
});

describe("PsonoTree share collection", () => {
  test("skips a pending share (accepted null) without failing the list", async () => {
    const client = new FakeClient([
      shareRight({ id: "pending", share_right_accepted: null }),
    ]);
    const tree = new PsonoTree(client);
    await expect(tree.find("anything")).rejects.toMatchObject({
      kind: "not_found",
    });
  });

  test("returns only the usable shares from a mixed list", async () => {
    const client = new FakeClient([
      shareRight({ id: "pending", share_right_accepted: null }),
      shareRight({ id: "usable", share_right_accepted: true }),
    ]);
    client.addEntry("usable", "VALID");

    const tree = new PsonoTree(client);
    const entry = await tree.find("VALID");
    expect(entry.secretId).toBe("secret-usable");
    expect(entry.source).toBe("share");
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
  });

  test("treats an absent accepted flag as accepted", async () => {
    const client = new FakeClient([shareRight({ id: "legacy" })]);
    delete (client.shares[0] as Partial<ShareRightFixture>).share_right_accepted;
    client.addEntry("legacy", "LEGACY");

    const tree = new PsonoTree(client);
    await expect(tree.find("LEGACY")).resolves.toMatchObject({
      secretId: "secret-legacy",
    });
  });
});
