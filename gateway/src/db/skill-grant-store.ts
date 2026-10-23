/**
 * Store for the capabilities granted to a skill version.
 *
 * A row is identified by `(skill_id, version_hash)`: the grant is bound to the
 * skill content, so editing a skill produces a new version that starts from
 * the empty set. Capabilities are stored as a JSON array of canonical names
 * (`@vellumai/service-contracts/skill-capabilities`) and are normalized on
 * both write and read: unknown names are dropped, duplicates collapse, and the
 * order is the contract's.
 *
 * Reads used by the assistant go through {@link listSkillGrantsSafe}, which
 * treats an unreadable store as "no grants" rather than an error. The
 * fail-closed direction matters: the assistant denies a capability it cannot
 * read, so a broken store must never look like a grant.
 */

import {
  SKILL_CAPABILITIES,
  SkillCapabilitySchema,
  type SkillCapability,
} from "@vellumai/service-contracts/skill-capabilities";
import { and, eq } from "drizzle-orm";
import { z } from "zod";

import { getLogger } from "../logger.js";
import { getGatewayDb } from "./connection.js";
import { skillGrants } from "./schema.js";

const log = getLogger("skill-grant-store");

const StoredCapabilitiesSchema = z.array(SkillCapabilitySchema);

export interface SkillGrant {
  skillId: string;
  versionHash: string;
  capabilities: SkillCapability[];
  grantedBy: string | null;
  createdAt: number;
  updatedAt: number;
}

export interface SkillGrantFilters {
  skillId?: string;
  versionHash?: string;
}

export interface UpsertSkillGrantInput {
  skillId: string;
  versionHash: string;
  capabilities: readonly SkillCapability[];
  /** Principal granting them. Absent records "granted out of band" (null). */
  grantedBy?: string | null;
}

/** Drop duplicates and order the capabilities as the contract declares them. */
export function normalizeSkillCapabilities(
  capabilities: readonly SkillCapability[],
): SkillCapability[] {
  const wanted = new Set(capabilities);
  return SKILL_CAPABILITIES.filter((capability) => wanted.has(capability));
}

function parseStoredCapabilities(
  json: string,
  skillId: string,
  versionHash: string,
): SkillCapability[] {
  let decoded: unknown;
  try {
    decoded = JSON.parse(json);
  } catch {
    log.warn(
      { skillId, versionHash },
      "Unreadable skill grant capabilities; treating the grant as empty",
    );
    return [];
  }

  const parsed = StoredCapabilitiesSchema.safeParse(decoded);
  if (!parsed.success) {
    log.warn(
      { skillId, versionHash },
      "Invalid skill grant capabilities; treating the grant as empty",
    );
    return [];
  }

  return normalizeSkillCapabilities(parsed.data);
}

function toSkillGrant(row: typeof skillGrants.$inferSelect): SkillGrant {
  return {
    skillId: row.skillId,
    versionHash: row.versionHash,
    capabilities: parseStoredCapabilities(
      row.capabilitiesJson,
      row.skillId,
      row.versionHash,
    ),
    grantedBy: row.grantedBy ?? null,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}

function whereForFilters(filters: SkillGrantFilters) {
  const conditions = [];
  if (filters.skillId !== undefined) {
    conditions.push(eq(skillGrants.skillId, filters.skillId));
  }
  if (filters.versionHash !== undefined) {
    conditions.push(eq(skillGrants.versionHash, filters.versionHash));
  }
  return conditions.length > 0 ? and(...conditions) : undefined;
}

/** Every grant matching the filters, ordered by skill id then version. */
export function listSkillGrants(filters: SkillGrantFilters = {}): SkillGrant[] {
  const where = whereForFilters(filters);
  const query = getGatewayDb().select().from(skillGrants);
  const rows = where ? query.where(where).all() : query.all();

  return rows
    .map(toSkillGrant)
    .sort((a, b) =>
      a.skillId === b.skillId
        ? a.versionHash.localeCompare(b.versionHash)
        : a.skillId.localeCompare(b.skillId),
    );
}

/**
 * {@link listSkillGrants}, but an unreadable store reads as no grants.
 *
 * This is the read path the assistant uses. A store that cannot be read (a
 * missing table, a closed connection, a failed query) must not surface as an
 * error the caller could mistake for "ask again later": it resolves to the
 * empty list, so every capability stays denied.
 */
export function listSkillGrantsSafe(
  filters: SkillGrantFilters = {},
): SkillGrant[] {
  try {
    return listSkillGrants(filters);
  } catch (err) {
    log.warn(
      { err, ...filters },
      "Skill grant store unreadable; returning no grants",
    );
    return [];
  }
}

/** The grant for one skill version, or null when none exists. */
export function getSkillGrant(
  skillId: string,
  versionHash: string,
): SkillGrant | null {
  const row = getGatewayDb()
    .select()
    .from(skillGrants)
    .where(
      and(
        eq(skillGrants.skillId, skillId),
        eq(skillGrants.versionHash, versionHash),
      ),
    )
    .get();

  return row ? toSkillGrant(row) : null;
}

/**
 * Grant `capabilities` to one skill version, replacing whatever that version
 * was granted before.
 */
export function upsertSkillGrant(input: UpsertSkillGrantInput): SkillGrant {
  const now = Date.now();
  const capabilities = normalizeSkillCapabilities(input.capabilities);
  const capabilitiesJson = JSON.stringify(capabilities);
  const grantedBy = input.grantedBy ?? null;

  getGatewayDb()
    .insert(skillGrants)
    .values({
      skillId: input.skillId,
      versionHash: input.versionHash,
      capabilitiesJson,
      grantedBy,
      createdAt: now,
      updatedAt: now,
    })
    .onConflictDoUpdate({
      target: [skillGrants.skillId, skillGrants.versionHash],
      set: { capabilitiesJson, grantedBy, updatedAt: now },
    })
    .run();

  const stored = getSkillGrant(input.skillId, input.versionHash);
  if (!stored) {
    throw new Error(
      `Skill grant for ${input.skillId}@${input.versionHash} disappeared after write`,
    );
  }
  return stored;
}

/** Drop one skill version's grant. Returns true when a row was removed. */
export function deleteSkillGrant(
  skillId: string,
  versionHash: string,
): boolean {
  const removed = getGatewayDb()
    .delete(skillGrants)
    .where(
      and(
        eq(skillGrants.skillId, skillId),
        eq(skillGrants.versionHash, versionHash),
      ),
    )
    .returning({ skillId: skillGrants.skillId })
    .all();

  return removed.length > 0;
}
