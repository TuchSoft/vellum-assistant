/**
 * The libsodium primitives Psono needs.
 *
 * This is the only crypto surface in CES: Ed25519 (login signature), X25519
 * box (login payload), SecretBox (transport, share keys, entry payloads).
 * `decodeKeyBytes` normalizes the two key encodings Psono uses: raw 32-byte
 * keys and ASCII hex strings of 32-byte keys.
 */

import sodium from "libsodium-wrappers";

await sodium.ready;

export const NONCE_BYTES = 24;
const HEX_KEY = /^[0-9a-f]{64}$/i;

export function hexToBytes(hex: string): Uint8Array {
  return sodium.from_hex(hex);
}

export function bytesToHex(bytes: Uint8Array): string {
  return sodium.to_hex(bytes);
}

export function bytesToUtf8(bytes: Uint8Array): string {
  return sodium.to_string(bytes);
}

export function utf8ToBytes(value: string): Uint8Array {
  return sodium.from_string(value);
}

/** Generate an ephemeral X25519 key pair for one login session. */
export function generateBoxKeyPair(): {
  publicKey: Uint8Array;
  privateBytes: Uint8Array;
} {
  const pair = sodium.crypto_box_keypair();
  return { publicKey: pair.publicKey, privateBytes: pair.privateKey };
}

/** Sign a message with an Ed25519 seed (32 bytes). */
export function signDetached(
  message: Uint8Array,
  seed: Uint8Array,
): Uint8Array {
  const signingKey = sodium.crypto_sign_seed_keypair(seed);
  return sodium.crypto_sign_detached(message, signingKey.privateKey);
}

/** Verify an Ed25519 detached signature. */
export function verifyDetached(
  signature: Uint8Array,
  message: Uint8Array,
  publicKey: Uint8Array,
): boolean {
  return sodium.crypto_sign_verify_detached(signature, message, publicKey);
}

/** Open a crypto_box payload (16-byte MAC + ciphertext, nonce separate). */
export function boxOpen(
  ciphertext: Uint8Array,
  nonce: Uint8Array,
  senderPublicKey: Uint8Array,
  recipientPrivateKey: Uint8Array,
): Uint8Array {
  return sodium.crypto_box_open_easy(
    ciphertext,
    nonce,
    senderPublicKey,
    recipientPrivateKey,
  );
}

/** Open a SecretBox payload (16-byte MAC + ciphertext, nonce separate). */
export function secretBoxOpen(
  ciphertext: Uint8Array,
  nonce: Uint8Array,
  key: Uint8Array,
): Uint8Array {
  return sodium.crypto_secretbox_open_easy(ciphertext, nonce, key);
}

/**
 * Normalize a decrypted key: Psono returns some keys as raw 32-byte values and
 * others as their 64-character hex encoding.
 */
export function decodeKeyBytes(value: Uint8Array): Uint8Array {
  if (value.length !== 64) {
    return value;
  }
  let text: string;
  try {
    text = sodium.to_string(value);
  } catch {
    return value;
  }
  return HEX_KEY.test(text) ? sodium.from_hex(text) : value;
}
