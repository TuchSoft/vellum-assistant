import { describe, expect, test } from "bun:test";
import sodium from "libsodium-wrappers";

import {
  boxOpen,
  bytesToHex,
  decodeKeyBytes,
  generateBoxKeyPair,
  hexToBytes,
  secretBoxOpen,
  secretBoxSeal,
  signDetached,
  utf8ToBytes,
  verifyDetached,
} from "../crypto.js";

await sodium.ready;

// RFC 8032, Ed25519 test vector 1.
const SEED_HEX =
  "9d61b19deffd5a60ba844af492ec2cc44449c5697b326919703bac031cae7f60";
const PUBLIC_HEX =
  "d75a980182b10ab7d54bfed3c964073a0ee172f3daa62325af021a68f707511a";
const SIGNATURE_HEX =
  "e5564300c360ac729086e2cc806e828a84877f1eb8e5d974d873e065224901555fb8821590a33bacc61e39701cf9b46bd25bf5f0595bbe24655141438e7a100b";

describe("ed25519", () => {
  test("matches the RFC 8032 vector", () => {
    const signature = signDetached(utf8ToBytes(""), hexToBytes(SEED_HEX));
    expect(bytesToHex(signature)).toBe(SIGNATURE_HEX);
  });

  test("verifies the RFC 8032 vector and rejects a tampered message", () => {
    expect(
      verifyDetached(
        hexToBytes(SIGNATURE_HEX),
        utf8ToBytes(""),
        hexToBytes(PUBLIC_HEX),
      ),
    ).toBe(true);
    expect(
      verifyDetached(
        hexToBytes(SIGNATURE_HEX),
        utf8ToBytes("x"),
        hexToBytes(PUBLIC_HEX),
      ),
    ).toBe(false);
  });
});

describe("box", () => {
  test("opens a fixed nonce payload from another key pair", () => {
    const sender = generateBoxKeyPair();
    const recipient = generateBoxKeyPair();
    const nonce = hexToBytes("00".repeat(sodium.crypto_box_NONCEBYTES));
    const message = utf8ToBytes("hello box");

    const ciphertext = sodium.crypto_box_easy(
      message,
      nonce,
      recipient.publicKey,
      sender.privateBytes,
    );

    expect(
      boxOpen(
        ciphertext,
        nonce,
        sender.publicKey,
        recipient.privateBytes,
      ),
    ).toEqual(message);
  });
});

describe("secretbox", () => {
  const key = hexToBytes(
    "000102030405060708090a0b0c0d0e0f101112131415161718191a1b1c1d1e1f",
  );
  const nonce = hexToBytes("000102030405060708090a0b0c0d0e0f1011121314151617");

  test("opens a fixed nonce payload", () => {
    const message = utf8ToBytes("hello secretbox");
    const ciphertext = sodium.crypto_secretbox_easy(message, nonce, key);
    expect(secretBoxOpen(ciphertext, nonce, key)).toEqual(message);
  });

  test("rejects a tampered ciphertext", () => {
    const ciphertext = sodium.crypto_secretbox_easy(
      utf8ToBytes("hello"),
      nonce,
      key,
    );
    ciphertext[0] = ciphertext[0]! ^ 0xff;
    expect(() => secretBoxOpen(ciphertext, nonce, key)).toThrow();
  });

  test("seals with a fresh nonce and round-trips", () => {
    const message = utf8ToBytes("share key");
    const first = secretBoxSeal(message, key);
    const second = secretBoxSeal(message, key);

    expect(first.nonce).toHaveLength(sodium.crypto_secretbox_NONCEBYTES);
    expect(first.nonce).not.toEqual(second.nonce);
    expect(secretBoxOpen(first.ciphertext, first.nonce, key)).toEqual(message);
  });
});

describe("asymmetric box with fixed keys", () => {
  test("opens a payload sealed to the recipient public key", () => {
    const sender = sodium.crypto_box_seed_keypair(
      new Uint8Array(32).fill(0x11),
    );
    const recipient = sodium.crypto_box_seed_keypair(
      new Uint8Array(32).fill(0x22),
    );
    const nonce = hexToBytes("ab".repeat(sodium.crypto_box_NONCEBYTES));
    const message = hexToBytes("33".repeat(32));

    const ciphertext = sodium.crypto_box_easy(
      message,
      nonce,
      recipient.publicKey,
      sender.privateKey,
    );

    expect(
      boxOpen(ciphertext, nonce, sender.publicKey, recipient.privateKey),
    ).toEqual(message);
  });
});

describe("decodeKeyBytes", () => {
  test("decodes a hex-encoded 32-byte key", () => {
    const raw = new Uint8Array(32).fill(7);
    expect(decodeKeyBytes(utf8ToBytes(bytesToHex(raw)))).toEqual(raw);
  });

  test("leaves a raw 32-byte key untouched", () => {
    const raw = new Uint8Array(32).fill(9);
    expect(decodeKeyBytes(raw)).toEqual(raw);
  });
});
