/**
 * Boundary schemas and payload helpers for Psono responses.
 *
 * Every HTTP body is parsed with Zod before any field is read. The payload of
 * a decrypted secret is free-form JSON (its shape depends on the Psono entry
 * type), so it is validated as an unknown record and normalized separately.
 */

import { z } from "zod";

const HexSchema = z.string().regex(/^[0-9a-f]+$/i);

export const PsonoInfoResponseSchema = z
  .object({
    info: z.string(),
    signature: z.string(),
    verify_key: z.string().optional(),
  })
  .passthrough();
export type PsonoInfoResponse = z.infer<typeof PsonoInfoResponseSchema>;

export const PsonoServerInfoSchema = z
  .object({
    public_key: HexSchema,
  })
  .passthrough();

export const PsonoLoginResponseSchema = z
  .object({
    login_info: z.string(),
    login_info_nonce: z.string(),
    login_info_signature: z.string(),
    server_session_public_key: HexSchema,
  })
  .passthrough();
export type PsonoLoginResponse = z.infer<typeof PsonoLoginResponseSchema>;

const PsonoUserSchema = z
  .object({
    username: z.string().optional(),
    public_key: HexSchema.optional(),
    private_key: z.string().optional(),
    private_key_nonce: z.string().optional(),
    secret_key: z.string().optional(),
    secret_key_nonce: z.string().optional(),
  })
  .passthrough();

export const PsonoSessionPayloadSchema = z
  .object({
    token: z.string(),
    session_secret_key: z.string(),
    session_valid_till: z.string().optional(),
    api_key_restrict_to_secrets: z.boolean().optional(),
    api_key_read: z.boolean().optional(),
    api_key_write: z.boolean().optional(),
    user: PsonoUserSchema,
  })
  .passthrough();
export type PsonoSessionPayload = z.infer<typeof PsonoSessionPayloadSchema>;

export const PsonoShareRightSchema = z
  .object({
    id: z.string(),
    share_right_id: z.string(),
    share_right_key: z.string(),
    share_right_key_nonce: z.string(),
    share_right_key_type: z.string().nullable().optional(),
    share_right_create_user_public_key: z.string().optional(),
    share_right_read: z.boolean().nullable().optional(),
    share_right_write: z.boolean().nullable().optional(),
    share_right_grant: z.boolean().nullable().optional(),
    share_right_accepted: z.boolean().nullable().optional(),
    expiration_date: z.string().nullable().optional(),
    share_right_expiration_date: z.string().nullable().optional(),
  })
  .passthrough();

export const PsonoShareListSchema = z
  .object({
    shares: z.array(PsonoShareRightSchema),
  })
  .passthrough();
export type PsonoShareRight = z.infer<typeof PsonoShareRightSchema>;

export const PsonoShareDetailSchema = z
  .object({
    id: z.string(),
    data: z.string(),
    data_nonce: z.string(),
    rights: z
      .object({
        read: z.boolean().optional(),
        write: z.boolean().optional(),
        grant: z.boolean().optional(),
      })
      .passthrough()
      .optional(),
  })
  .passthrough();

export const PsonoSecretDetailSchema = z
  .object({
    data: z.string(),
    data_nonce: z.string(),
    type: z.string().optional(),
  })
  .passthrough();

export const PsonoCreateSecretResponseSchema = z
  .object({
    secret_id: z.string(),
  })
  .passthrough();
export type PsonoCreateSecretResponse = z.infer<
  typeof PsonoCreateSecretResponseSchema
>;

/**
 * Share and secret mutations answer with a small acknowledgement object. The
 * exact keys are not part of the contract, so only the envelope is checked.
 */
export const PsonoMutationResponseSchema = z.object({}).passthrough();

export const PsonoDatastoreSchema = z
  .object({
    id: z.string(),
    type: z.string(),
    description: z.string().optional(),
  })
  .passthrough();

export const PsonoDatastoreListSchema = z
  .object({
    datastores: z.array(PsonoDatastoreSchema),
  })
  .passthrough();

export const PsonoDatastoreDetailSchema = z
  .object({
    data: z.string(),
    data_nonce: z.string(),
    secret_key: z.string(),
    secret_key_nonce: z.string(),
    type: z.string().optional(),
    description: z.string().optional(),
  })
  .passthrough();

/** Fields that describe an entry rather than hold its value. */
export const PAYLOAD_METADATA_FIELDS = new Set([
  "tags",
  "custom_fields",
  "password_hash",
]);

/** One entry reference inside a share folder tree. */
export interface PsonoShareItem {
  id?: string;
  name?: string;
  type?: string;
  secret_id?: string;
  secret_key?: string;
  urlfilter?: string;
  deleted?: boolean;
  [key: string]: unknown;
}

/** A folder node inside the decrypted share content. */
export interface PsonoShareFolder {
  id?: string;
  name?: string;
  items?: PsonoShareItem[];
  folders?: PsonoShareFolder[];
  deleted?: boolean;
  [key: string]: unknown;
}

/** The decrypted content of a share (its root is a folder). */
export type PsonoShareContent = PsonoShareFolder;

export type SecretPayload = Record<string, unknown>;

/**
 * Strip the Psono entry type prefix from payload keys, so a
 * `website_password_password` field is exposed as `password`.
 */
export function normalizePayload(
  payload: SecretPayload,
  type: string | undefined,
): SecretPayload {
  if (!type) {
    return { ...payload };
  }
  const prefix = `${type}_`;
  const normalized: SecretPayload = {};
  for (const [key, value] of Object.entries(payload)) {
    normalized[key.startsWith(prefix) ? key.slice(prefix.length) : key] = value;
  }
  return normalized;
}

function customFieldValue(
  payload: SecretPayload,
  field: string,
): unknown | undefined {
  const custom = payload["custom_fields"];
  if (!Array.isArray(custom)) {
    return undefined;
  }
  for (const entry of custom) {
    if (
      entry != null &&
      typeof entry === "object" &&
      "name" in entry &&
      "value" in entry &&
      (entry as { name: unknown }).name === field
    ) {
      return (entry as { value: unknown }).value;
    }
  }
  return undefined;
}

/**
 * Select the value a record's logical `field` names.
 *
 * Order: exact key, type-prefixed suffix (unique match), custom field, then a
 * single non-metadata scalar for the generic `value` field.
 */
export function selectField(
  payload: SecretPayload,
  field: string,
): unknown | undefined {
  if (Object.prototype.hasOwnProperty.call(payload, field)) {
    return payload[field];
  }

  const suffix = `_${field}`;
  const matches = Object.keys(payload).filter(
    (key) => key.endsWith(suffix) && !PAYLOAD_METADATA_FIELDS.has(key),
  );
  if (matches.length === 1) {
    return payload[matches[0]!];
  }

  const custom = customFieldValue(payload, field);
  if (custom !== undefined) {
    return custom;
  }

  if (field === "value") {
    const scalars = Object.entries(payload).filter(
      ([key, value]) =>
        !PAYLOAD_METADATA_FIELDS.has(key) &&
        (typeof value === "string" || typeof value === "number"),
    );
    if (scalars.length === 1) {
      return scalars[0]![1];
    }
  }

  return undefined;
}
