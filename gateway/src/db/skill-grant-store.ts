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
import { skillGrants, skillGrantTombstones } from "./schema.js";

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

export interface SkillGrantTombstone {
  skillId: string;
  versionHash: string;
  revokedAt: number;
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
 *
 * A write also clears any tombstone for the version: an explicit grant is the
 * human decision the tombstone was waiting for, so a later revocation has to be
 * a new DELETE rather than the ghost of the previous one.
 */
export function upsertSkillGrant(input: UpsertSkillGrantInput): SkillGrant {
  const now = Date.now();
  const capabilities = normalizeSkillCapabilities(input.capabilities);
  const capabilitiesJson = JSON.stringify(capabilities);
  const grantedBy = input.grantedBy ?? null;

  getGatewayDb().transaction(() => {
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

    getGatewayDb()
      .delete(skillGrantTombstones)
      .where(
        and(
          eq(skillGrantTombstones.skillId, input.skillId),
          eq(skillGrantTombstones.versionHash, input.versionHash),
        ),
      )
      .run();
  });

  const stored = getSkillGrant(input.skillId, input.versionHash);
  if (!stored) {
    throw new Error(
      `Skill grant for ${input.skillId}@${input.versionHash} disappeared after write`,
    );
  }
  return stored;
}

/**
 * Drop one skill version's grant and record that it was revoked.
 *
 * The tombstone is written whether or not a grant existed: deleting a version
 * that only had a default is how a user refuses that default, and the record is
 * what keeps the seed from handing it back. Returns true when a grant row was
 * removed.
 */
export function deleteSkillGrant(
  skillId: string,
  versionHash: string,
): boolean {
  const now = Date.now();

  return getGatewayDb().transaction((): boolean => {
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

    getGatewayDb()
      .insert(skillGrantTombstones)
      .values({ skillId, versionHash, revokedAt: now })
      .onConflictDoUpdate({
        target: [
          skillGrantTombstones.skillId,
          skillGrantTombstones.versionHash,
        ],
        set: { revokedAt: now },
      })
      .run();

    return removed.length > 0;
  });
}

/** Every tombstone, ordered by skill id then version. */
export function listSkillGrantTombstones(
  filters: SkillGrantFilters = {},
): SkillGrantTombstone[] {
  const conditions = [];
  if (filters.skillId !== undefined) {
    conditions.push(eq(skillGrantTombstones.skillId, filters.skillId));
  }
  if (filters.versionHash !== undefined) {
    conditions.push(eq(skillGrantTombstones.versionHash, filters.versionHash));
  }

  const query = getGatewayDb().select().from(skillGrantTombstones);
  const rows =
    conditions.length > 0 ? query.where(and(...conditions)).all() : query.all();

  return rows
    .map((row) => ({
      skillId: row.skillId,
      versionHash: row.versionHash,
      revokedAt: row.revokedAt,
    }))
    .sort((a, b) =>
      a.skillId === b.skillId
        ? a.versionHash.localeCompare(b.versionHash)
        : a.skillId.localeCompare(b.skillId),
    );
}

/** Whether one skill version's grant was revoked. */
export function isSkillGrantRevoked(
  skillId: string,
  versionHash: string,
): boolean {
  const row = getGatewayDb()
    .select({ skillId: skillGrantTombstones.skillId })
    .from(skillGrantTombstones)
    .where(
      and(
        eq(skillGrantTombstones.skillId, skillId),
        eq(skillGrantTombstones.versionHash, versionHash),
      ),
    )
    .get();

  return row !== undefined;
}
