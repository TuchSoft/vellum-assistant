/**
 * Skill capability grants, read and written through the gateway.
 *
 * The gateway owns the store: a grant is identified by `(skillId,
 * versionHash)` and a capability is usable only for the version it was granted
 * against. The routes are gateway-native (`/v1/permissions/skill-grants`) and
 * are not part of the generated SDK, so this module talks to the shared
 * gateway client directly and validates every payload with Zod before the UI
 * reads a field.
 *
 * Writes are never optimistic: the caller refetches after a successful write,
 * so the switches always reflect what the store actually holds.
 */

import { z } from "zod";

import { client } from "@/generated/gateway/client.gen";
import {
  ApiError,
  assertHasResponse,
  extractErrorMessage,
} from "@/utils/api-errors";

export const SKILL_CAPABILITIES = [
  "host_exec",
  "vetted",
  "input_repairs",
  "computer_use_target",
] as const;

export type SkillCapability = (typeof SKILL_CAPABILITIES)[number];

const SkillCapabilitySchema = z.enum(SKILL_CAPABILITIES);

const SkillGrantSchema = z.object({
  skillId: z.string(),
  versionHash: z.string(),
  capabilities: z.array(SkillCapabilitySchema),
  /** Principal that granted them; null records a grant made out of band. */
  grantedBy: z.string().nullable(),
  createdAt: z.number(),
  updatedAt: z.number(),
});

export type SkillGrant = z.infer<typeof SkillGrantSchema>;

const SkillGrantListSchema = z.object({ grants: z.array(SkillGrantSchema) });

const SkillGrantResponseSchema = z.object({ grant: SkillGrantSchema });

/** The principal the settings UI records on a write it performs. */
export const SETTINGS_GRANT_PRINCIPAL = "settings-ui";

function grantPath(skillId: string): string {
  return `/v1/permissions/skill-grants/${encodeURIComponent(skillId)}`;
}

/**
 * Every grant in the store, across every skill and version.
 *
 * A skill with no row has no capability. The store is read whole so the
 * settings card can classify each installed skill from one request instead of
 * one request per skill.
 */
export async function listSkillGrants(): Promise<SkillGrant[]> {
  const { data, error, response } = await client.get<unknown, unknown, false>({
    url: "/v1/permissions/skill-grants",
    throwOnError: false,
  });
  assertHasResponse(response, error, "Failed to load skill permissions.");
  if (!response.ok) {
    const message = extractErrorMessage(
      error,
      response,
      "Failed to load skill permissions.",
    );
    throw new ApiError(response.status, message);
  }
  const parsed = SkillGrantListSchema.safeParse(data);
  if (!parsed.success) {
    throw new ApiError(
      response.status,
      "The gateway returned an unreadable skill permission list.",
    );
  }
  return parsed.data.grants;
}

export interface PutSkillGrantInput {
  skillId: string;
  versionHash: string;
  capabilities: readonly SkillCapability[];
}

/**
 * Replace the capability set for one skill version.
 *
 * A write is the only way a capability is ever granted, and it also clears a
 * tombstone left by a previous revoke, so re-granting after a revoke works
 * without any extra step.
 */
export async function putSkillGrant(
  input: PutSkillGrantInput,
): Promise<SkillGrant> {
  const { data, error, response } = await client.put<unknown, unknown, false>({
    url: grantPath(input.skillId),
    body: {
      versionHash: input.versionHash,
      capabilities: input.capabilities,
      grantedBy: SETTINGS_GRANT_PRINCIPAL,
    },
    throwOnError: false,
  });
  assertHasResponse(response, error, "Failed to save skill permissions.");
  if (!response.ok) {
    const message = extractErrorMessage(
      error,
      response,
      "Failed to save skill permissions.",
    );
    throw new ApiError(response.status, message);
  }
  const parsed = SkillGrantResponseSchema.safeParse(data);
  if (!parsed.success) {
    throw new ApiError(
      response.status,
      "The gateway returned an unreadable skill permission.",
    );
  }
  return parsed.data.grant;
}

/**
 * Remove the grant for one skill version.
 *
 * The gateway records a tombstone for the version, so the startup seed never
 * reinstates a grant the user removed. The route answers 204 and is
 * idempotent, which is why a missing grant is not an error here.
 */
export async function deleteSkillGrant(
  skillId: string,
  versionHash: string,
): Promise<void> {
  const { error, response } = await client.delete<unknown, unknown, false>({
    url: grantPath(skillId),
    query: { versionHash },
    throwOnError: false,
  });
  assertHasResponse(response, error, "Failed to revoke skill permissions.");
  if (!response.ok && response.status !== 204) {
    const message = extractErrorMessage(
      error,
      response,
      "Failed to revoke skill permissions.",
    );
    throw new ApiError(response.status, message);
  }
}
