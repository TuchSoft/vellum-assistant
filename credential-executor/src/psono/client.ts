/**
 * Psono session client (read-only).
 *
 * Login uses the API key: an ephemeral X25519 pair, an Ed25519 signature over
 * the login info, a pinned verification of the server signature, and a
 * SecretBox transport for every session response. The session is renewed
 * automatically once; a second failure is a typed error.
 */

import { getLogger } from "../logger.js";
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
} from "./crypto.js";
import {
  denied,
  unavailable,
  unauthorized,
  type PsonoError,
  asPsonoError,
} from "./errors.js";
import type { PsonoMaterial } from "./material.js";
import {
  PsonoInfoResponseSchema,
  PsonoLoginResponseSchema,
  PsonoServerInfoSchema,
  PsonoSessionPayloadSchema,
  type PsonoSessionPayload,
} from "./types.js";

const SESSION_DURATION_SECONDS = 3600;
const SESSION_REFRESH_MARGIN_MS = 30_000;
const DEFAULT_TIMEOUT_MS = 10_000;

export interface PsonoStatus {
  configured: boolean;
  sessionOpen: boolean;
  lastRefresh: string | null;
  lastError: string | null;
}

export interface PsonoClientOptions {
  material: PsonoMaterial;
  /** Pinned Ed25519 public key of the server (hex). */
  serverPublicKeyHex?: string;
  fetchImpl?: typeof fetch;
  now?: () => number;
  timeoutMs?: number;
  sessionDurationSeconds?: number;
}

interface Session {
  token: string;
  secretKey: Uint8Array;
  userSecretKey: Uint8Array;
  userBoxPrivateBytes: Uint8Array;
  expiresAt: number;
}

const log = getLogger("psono");

export class PsonoClient {
  private readonly material: PsonoMaterial;
  private readonly fetchImpl: typeof fetch;
  private readonly now: () => number;
  private readonly timeoutMs: number;
  private readonly sessionDurationSeconds: number;
  private serverPublicKeyHex?: string;
  private session?: Session;
  private loginPromise?: Promise<void>;
  private lastRefresh: string | null = null;
  private lastError: string | null = null;

  constructor(options: PsonoClientOptions) {
    this.material = options.material;
    this.serverPublicKeyHex = options.serverPublicKeyHex;
    this.fetchImpl = options.fetchImpl ?? fetch;
    this.now = options.now ?? Date.now;
    this.timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    this.sessionDurationSeconds =
      options.sessionDurationSeconds ?? SESSION_DURATION_SECONDS;
  }

  getStatus(): PsonoStatus {
    const sessionOpen =
      this.session !== undefined &&
      this.now() < this.session.expiresAt - SESSION_REFRESH_MARGIN_MS;
    return {
      configured: true,
      sessionOpen,
      lastRefresh: this.lastRefresh,
      lastError: this.lastError,
    };
  }

  /** Drop the in-memory session; the next request logs in again. */
  invalidateSession(): void {
    this.session = undefined;
  }

  /**
   * Open a SecretBox encrypted with the user's secret key (share keys and
   * datastore keys) and return the decoded 32-byte key.
   */
  openUserKeyBox(ciphertextHex: string, nonceHex: string): Uint8Array {
    const session = this.session;
    if (!session) {
      throw unauthorized("Psono session is not open");
    }
    const opened = secretBoxOpen(
      hexToBytes(ciphertextHex),
      hexToBytes(nonceHex),
      session.userSecretKey,
    );
    return decodeKeyBytes(opened);
  }

  /**
   * Open a box encrypted to the user's public key (a pending share key) with
   * the user's private key, and return the decoded 32-byte key.
   */
  openAsymmetricBox(
    ciphertextHex: string,
    nonceHex: string,
    senderPublicKeyHex: string,
  ): Uint8Array {
    const session = this.session;
    if (!session) {
      throw unauthorized("Psono session is not open");
    }
    const opened = boxOpen(
      hexToBytes(ciphertextHex),
      hexToBytes(nonceHex),
      hexToBytes(senderPublicKeyHex),
      session.userBoxPrivateBytes,
    );
    return decodeKeyBytes(opened);
  }

  /**
   * Seal a 32-byte key with the user's secret key, in the two hex fields Psono
   * stores for a symmetric share right.
   */
  sealUserKeyBox(plaintext: Uint8Array): {
    ciphertextHex: string;
    nonceHex: string;
  } {
    const session = this.session;
    if (!session) {
      throw unauthorized("Psono session is not open");
    }
    const sealed = secretBoxSeal(plaintext, session.userSecretKey);
    return {
      ciphertextHex: bytesToHex(sealed.ciphertext),
      nonceHex: bytesToHex(sealed.nonce),
    };
  }

  /** Establish a session and return the decrypted user secret key. */
  async login(): Promise<void> {
    try {
      const sessionKey = generateBoxKeyPair();
      const info = JSON.stringify({
        api_key_id: this.material.apiKeyId,
        session_public_key: bytesToHex(sessionKey.publicKey),
        session_duration: this.sessionDurationSeconds,
        device_description: "vellum-credential-executor",
      });
      const signature = signDetached(
        utf8ToBytes(info),
        hexToBytes(this.material.apiKeyPrivateKeyHex),
      );

      const response = await this.rawFetch(
        "/api-key/login/",
        {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ info, signature: bytesToHex(signature) }),
        },
        false,
      );

      if (!response.ok) {
        throw response.status === 401 || response.status === 403
          ? unauthorized("Psono rejected the API key")
          : unavailable(`Psono login failed (${response.status})`);
      }

      const body = PsonoLoginResponseSchema.safeParse(await response.json());
      if (!body.success) {
        throw unavailable("Psono login response has an unexpected shape");
      }

      const serverPublicKey = await this.getServerPublicKey();
      const signedPayload = utf8ToBytes(body.data.login_info);
      const signatureValid = verifyDetached(
        hexToBytes(body.data.login_info_signature),
        signedPayload,
        hexToBytes(serverPublicKey),
      );
      if (!signatureValid) {
        throw unauthorized("Psono login signature is not valid");
      }

      const opened = boxOpen(
        hexToBytes(body.data.login_info),
        hexToBytes(body.data.login_info_nonce),
        hexToBytes(body.data.server_session_public_key),
        sessionKey.privateBytes,
      );
      const payloadResult = PsonoSessionPayloadSchema.safeParse(
        JSON.parse(new TextDecoder().decode(opened)),
      );
      if (!payloadResult.success) {
        throw unavailable("Psono session payload has an unexpected shape");
      }
      const payload: PsonoSessionPayload = payloadResult.data;

      const userSecretKey = this.decryptUserSecretKey(payload);
      const userBoxPrivateBytes = this.decryptUserBoxPrivateBytes(payload);
      const secretKey = decodeKeyBytes(hexToBytes(payload.session_secret_key));

      this.session = {
        token: payload.token,
        secretKey,
        userSecretKey,
        userBoxPrivateBytes,
        expiresAt: this.now() + this.sessionDurationSeconds * 1000,
      };
      this.lastRefresh = new Date(this.now()).toISOString();
      this.lastError = null;
      log.info("Psono session opened");
    } catch (err) {
      const typed = asPsonoError(err);
      this.lastError = typed.message;
      this.session = undefined;
      log.warn({ kind: typed.kind }, "Psono login failed");
      throw typed;
    }
  }

  /**
   * GET a session endpoint and return the decrypted JSON body.
   *
   * On an authentication failure the session is re-opened once.
   */
  async request(path: string, retryOnAuth = true): Promise<unknown> {
    return this.send(path, undefined, retryOnAuth);
  }

  /**
   * POST a JSON body to a session endpoint and return the decrypted response.
   *
   * The body is sealed with the session secret key: Psono's request parser
   * accepts only the `{text, nonce}` envelope for session endpoints.
   */
  async post(
    path: string,
    body: unknown,
    retryOnAuth = true,
  ): Promise<unknown> {
    return this.send(path, body, retryOnAuth);
  }

  private async send(
    path: string,
    body: unknown,
    retryOnAuth: boolean,
  ): Promise<unknown> {
    await this.ensureSession();

    let response: Response;
    try {
      const sealedBody =
        body === undefined
          ? undefined
          : secretBoxSeal(
              utf8ToBytes(JSON.stringify(body)),
              this.session!.secretKey,
            );
      response = await this.rawFetch(
        path,
        {
          method: body === undefined ? "GET" : "POST",
          headers: {
            Authorization: `Token ${this.session!.token}`,
            ...(body === undefined
              ? {}
              : { "content-type": "application/json" }),
          },
          ...(sealedBody === undefined
            ? {}
            : {
                body: JSON.stringify({
                  text: bytesToHex(sealedBody.ciphertext),
                  nonce: bytesToHex(sealedBody.nonce),
                }),
              }),
        },
        true,
      );
    } catch (err) {
      throw this.recordError(asPsonoError(err));
    }

    if (response.status === 401 || response.status === 403) {
      this.invalidateSession();
      if (retryOnAuth) {
        await this.ensureSession();
        return this.send(path, body, false);
      }
      throw this.recordError(unauthorized("Psono session rejected"));
    }

    const decoded = await this.decodeBody(response);
    if (!response.ok) {
      throw this.recordError(this.mapHttpError(response.status, decoded));
    }
    this.lastError = null;
    return decoded;
  }

  /**
   * Open the session, collapsing concurrent callers onto a single login.
   *
   * Two KV requests can arrive while the session is closed (Antirion resolves
   * its providers in parallel). The second caller awaits the first login
   * instead of starting a competing one. A failed login rejects every waiter
   * and clears the in-flight promise, so a later request retries.
   */
  private async ensureSession(): Promise<void> {
    if (
      this.session &&
      this.now() < this.session.expiresAt - SESSION_REFRESH_MARGIN_MS
    ) {
      return;
    }
    if (!this.loginPromise) {
      this.loginPromise = this.login().finally(() => {
        this.loginPromise = undefined;
      });
    }
    await this.loginPromise;
  }

  private decryptUserSecretKey(payload: PsonoSessionPayload): Uint8Array {
    const user = payload.user;
    if (!user.secret_key || !user.secret_key_nonce) {
      throw unavailable("Psono session did not include the user secret key");
    }
    const decrypted = secretBoxOpen(
      hexToBytes(user.secret_key),
      hexToBytes(user.secret_key_nonce),
      hexToBytes(this.material.apiKeySecretKeyHex),
    );
    return decodeKeyBytes(decrypted);
  }

  /**
   * The user's X25519 private key, sealed with the API key secret key for the
   * same login that carries the user secret key.
   */
  private decryptUserBoxPrivateBytes(payload: PsonoSessionPayload): Uint8Array {
    const user = payload.user;
    if (!user.private_key || !user.private_key_nonce) {
      throw unavailable("Psono session did not include the user private key");
    }
    const decrypted = secretBoxOpen(
      hexToBytes(user.private_key),
      hexToBytes(user.private_key_nonce),
      hexToBytes(this.material.apiKeySecretKeyHex),
    );
    return decodeKeyBytes(decrypted);
  }

  private async getServerPublicKey(): Promise<string> {
    const response = await this.rawFetch("/info/", { method: "GET" }, false);
    if (!response.ok) {
      throw unavailable(`Psono /info/ failed (${response.status})`);
    }
    const envelope = PsonoInfoResponseSchema.safeParse(await response.json());
    if (!envelope.success) {
      throw unavailable("Psono /info/ response has an unexpected shape");
    }
    let parsedInfo: unknown;
    try {
      parsedInfo = JSON.parse(envelope.data.info);
    } catch {
      throw unavailable("Psono /info/ payload is not JSON");
    }
    const info = PsonoServerInfoSchema.safeParse(parsedInfo);
    if (!info.success) {
      throw unavailable("Psono /info/ has no usable public key");
    }

    // `verify_key` is the key that signs both the /info/ payload and login
    // responses. Fall back to `info.public_key` for servers that expose only
    // that field.
    const verifyKeyHex = envelope.data.verify_key ?? info.data.public_key;
    const infoSignatureValid = verifyDetached(
      hexToBytes(envelope.data.signature),
      utf8ToBytes(envelope.data.info),
      hexToBytes(verifyKeyHex),
    );
    if (!infoSignatureValid) {
      throw unauthorized("Psono /info/ signature is not valid");
    }

    // The pinned key may be either the server identity key (`public_key`, as
    // the test material carries it) or the login verification key
    // (`verify_key`). Either way the login signature is verified with the key
    // that signed the /info/ envelope, never with the pin itself: pinning the
    // box key alone would not authenticate the verification key.
    const pinned = this.serverPublicKeyHex?.trim().toLowerCase();
    if (pinned) {
      const matches =
        pinned === verifyKeyHex.toLowerCase() ||
        pinned === info.data.public_key.toLowerCase();
      if (!matches) {
        throw unauthorized("Psono server public key does not match the pinned key");
      }
      return verifyKeyHex;
    }

    this.serverPublicKeyHex = verifyKeyHex;
    log.warn(
      "PSONO_SERVER_PUBLIC_KEY is not set; using the login verification key from /info/",
    );
    return verifyKeyHex;
  }

  private async rawFetch(
    path: string,
    init: RequestInit,
    withSession: boolean,
  ): Promise<Response> {
    const signal =
      typeof AbortSignal.timeout === "function"
        ? AbortSignal.timeout(this.timeoutMs)
        : undefined;
    try {
      return await this.fetchImpl(`${this.material.serverUrl}${path}`, {
        ...init,
        signal,
      });
    } catch (err) {
      if (withSession) {
        throw this.recordError(unavailable("Psono is unavailable"));
      }
      throw asPsonoError(err);
    }
  }

  private async decodeBody(response: Response): Promise<unknown> {
    let body: unknown;
    try {
      body = await response.json();
    } catch {
      if (!response.ok) {
        return undefined;
      }
      throw this.recordError(unavailable("Psono returned a non-JSON body"));
    }

    if (
      body != null &&
      typeof body === "object" &&
      typeof (body as { text?: unknown }).text === "string" &&
      typeof (body as { nonce?: unknown }).nonce === "string"
    ) {
      try {
        const opened = secretBoxOpen(
          hexToBytes((body as { text: string }).text),
          hexToBytes((body as { nonce: string }).nonce),
          this.session!.secretKey,
        );
        return JSON.parse(new TextDecoder().decode(opened));
      } catch {
        throw this.recordError(
          unavailable("Psono response could not be decrypted"),
        );
      }
    }

    return body;
  }

  private mapHttpError(status: number, body: unknown): PsonoError {
    const messages: string[] = [];
    if (body != null && typeof body === "object") {
      for (const value of Object.values(body as Record<string, unknown>)) {
        if (Array.isArray(value)) {
          messages.push(...value.filter((item) => typeof item === "string"));
        } else if (typeof value === "string") {
          messages.push(value);
        }
      }
    }
    const joined = messages.join(" ");
    if (/NO_PERMISSION|MALFORMED|NOT_EXIST/i.test(joined)) {
      return denied();
    }
    if (status >= 500) {
      return unavailable(`Psono is unavailable (${status})`);
    }
    if (status === 401 || status === 403) {
      return unauthorized();
    }
    return denied(`Psono rejected the request (${status})`);
  }

  private recordError(err: PsonoError): PsonoError {
    this.lastError = err.message;
    return err;
  }
}
