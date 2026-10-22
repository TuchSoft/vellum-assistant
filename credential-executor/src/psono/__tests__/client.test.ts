import { describe, expect, test } from "bun:test";
import sodium from "libsodium-wrappers";

import { PsonoClient } from "../client.js";
import type { PsonoMaterial } from "../material.js";

await sodium.ready;

const API_KEY_SECRET = hex(32, 1);

function hex(fill: number, pattern: number): string {
  return sodium.to_hex(new Uint8Array(fill).fill(pattern));
}

function seal(value: Uint8Array, key: Uint8Array): { text: string; nonce: string } {
  const nonce = sodium.randombytes_buf(sodium.crypto_secretbox_NONCEBYTES);
  return {
    text: sodium.to_hex(sodium.crypto_secretbox_easy(value, nonce, key)),
    nonce: sodium.to_hex(nonce),
  };
}

interface FakeServer {
  fetchImpl: typeof fetch;
  acceptCalls: Array<Record<string, unknown>>;
  userSecretKey: Uint8Array;
  userBoxPrivateBytes: Uint8Array;
  userKeyPair: { publicKey: Uint8Array; privateBytes: Uint8Array };
}

function createFakeServer(): FakeServer {
  const serverSigning = sodium.crypto_sign_seed_keypair(new Uint8Array(32).fill(5));
  const serverBox = sodium.crypto_box_keypair();
  const userSecretKey = sodium.crypto_secretbox_keygen();
  const userBox = sodium.crypto_box_keypair();
  const userBoxPrivateBytes = userBox.privateKey;
  const userKeyPair = {
    publicKey: sodium.crypto_scalarmult_base(userBoxPrivateBytes),
    privateBytes: userBox.privateKey,
  };
  const userSecretSealed = seal(
    userSecretKey,
    sodium.from_hex(API_KEY_SECRET),
  );
  const userPrivateSealed = seal(
    userBoxPrivateBytes,
    sodium.from_hex(API_KEY_SECRET),
  );

  const sessionSecretKey = sodium.crypto_secretbox_keygen();
  const acceptCalls: Array<Record<string, unknown>> = [];

  const infoJson = JSON.stringify({
    public_key: sodium.to_hex(serverBox.publicKey),
  });

  const fetchImpl = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input);
    if (url.endsWith("/info/")) {
      const signature = sodium.crypto_sign_detached(
        sodium.from_string(infoJson),
        serverSigning.privateKey,
      );
      return Response.json({
        info: infoJson,
        signature: sodium.to_hex(signature),
        verify_key: sodium.to_hex(serverSigning.publicKey),
      });
    }

    if (url.endsWith("/api-key/login/")) {
      const body = JSON.parse(String(init?.body)) as { info: string };
      const loginInfo = JSON.parse(body.info) as {
        session_public_key: string;
      };
      const sessionKeyPair = sodium.crypto_box_keypair();
      const payload = JSON.stringify({
        token: "session-token",
        session_secret_key: sodium.to_hex(sessionSecretKey),
        user: {
          username: "joanna",
          public_key: sodium.to_hex(userKeyPair.publicKey),
          secret_key: userSecretSealed.text,
          secret_key_nonce: userSecretSealed.nonce,
          private_key: userPrivateSealed.text,
          private_key_nonce: userPrivateSealed.nonce,
        },
      });
      const loginInfoNonce = sodium.randombytes_buf(
        sodium.crypto_box_NONCEBYTES,
      );
      const ciphertext = sodium.crypto_box_easy(
        sodium.from_string(payload),
        loginInfoNonce,
        sodium.from_hex(loginInfo.session_public_key),
        sessionKeyPair.privateKey,
      );
      const signature = sodium.crypto_sign_detached(
        sodium.from_string(sodium.to_hex(ciphertext)),
        serverSigning.privateKey,
      );
      return Response.json({
        login_info: sodium.to_hex(ciphertext),
        login_info_nonce: sodium.to_hex(loginInfoNonce),
        login_info_signature: sodium.to_hex(signature),
        server_session_public_key: sodium.to_hex(sessionKeyPair.publicKey),
      });
    }

    if (url.endsWith("/share/right/accept/")) {
      const envelope = JSON.parse(String(init?.body)) as {
        text: string;
        nonce: string;
      };
      const plaintext = sodium.crypto_secretbox_open_easy(
        sodium.from_hex(envelope.text),
        sodium.from_hex(envelope.nonce),
        sessionSecretKey,
      );
      acceptCalls.push(
        JSON.parse(new TextDecoder().decode(plaintext)) as Record<
          string,
          unknown
        >,
      );
      return Response.json(
        seal(
          sodium.from_string(JSON.stringify({ ok: true })),
          sessionSecretKey,
        ),
      );
    }

    return new Response("not found", { status: 404 });
  }) as typeof fetch;

  return {
    fetchImpl,
    acceptCalls,
    userSecretKey,
    userBoxPrivateBytes,
    userKeyPair,
  };
}

function testMaterial(): PsonoMaterial {
  return {
    apiKeyId: "api-key-id",
    apiKeyPrivateKeyHex: hex(32, 3),
    apiKeySecretKeyHex: API_KEY_SECRET,
    serverUrl: "https://psono.example",
  };
}

describe("PsonoClient session material", () => {
  test("opens a session and keeps the user private key usable", async () => {
    const material = testMaterial();
    const server = createFakeServer();
    const client = new PsonoClient({ material, fetchImpl: server.fetchImpl });

    await client.login();
    expect(client.getStatus().sessionOpen).toBe(true);

    const sender = sodium.crypto_box_keypair();
    const nonce = sodium.randombytes_buf(sodium.crypto_box_NONCEBYTES);
    const message = sodium.randombytes_buf(32);
    const ciphertext = sodium.crypto_box_easy(
      message,
      nonce,
      server.userKeyPair.publicKey,
      sender.privateKey,
    );

    expect(
      client.openAsymmetricBox(
        sodium.to_hex(ciphertext),
        sodium.to_hex(nonce),
        sodium.to_hex(sender.publicKey),
      ),
    ).toEqual(message);
  });

  test("re-seals a share key with the user secret key", async () => {
    const material = testMaterial();
    const server = createFakeServer();
    const client = new PsonoClient({ material, fetchImpl: server.fetchImpl });
    await client.login();

    const shareKey = sodium.randombytes_buf(32);
    const sealed = client.sealUserKeyBox(shareKey);
    expect(
      sodium.crypto_secretbox_open_easy(
        sodium.from_hex(sealed.ciphertextHex),
        sodium.from_hex(sealed.nonceHex),
        server.userSecretKey,
      ),
    ).toEqual(shareKey);
  });

  test("posts an accept body and decrypts the response", async () => {
    const material = testMaterial();
    const server = createFakeServer();
    const client = new PsonoClient({ material, fetchImpl: server.fetchImpl });

    const response = await client.post("/share/right/accept/", {
      share_right_id: "right-1",
      key: "aa",
      key_nonce: "bb",
      key_type: "symmetric",
    });

    expect(response).toEqual({ ok: true });
    expect(server.acceptCalls).toEqual([
      {
        share_right_id: "right-1",
        key: "aa",
        key_nonce: "bb",
        key_type: "symmetric",
      },
    ]);
  });
});
