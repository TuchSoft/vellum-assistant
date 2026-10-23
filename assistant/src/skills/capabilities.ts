import {
  GetSkillGrantsIpcResponseSchema,
  type SkillGrantIpc,
} from "@vellumai/gateway-client/gateway-ipc-contracts";
import {
  NO_SKILL_CAPABILITIES,
  type SkillCapabilities,
  type SkillCapability,
} from "@vellumai/service-contracts/skill-capabilities";

import { ipcCall } from "../ipc/gateway-client.js";
import { getLogger } from "../util/logger.js";

const log = getLogger("skill-capabilities");

/**
 * How long a resolved grant set is reused before the gateway is asked again.
 * Short on purpose: revoking a capability has to take effect promptly, and the
 * lookup only runs when a skill is about to act.
 */
const GRANT_CACHE_TTL_MS = 15_000;

/**
 * Per-attempt cap on the grant read. The grant is a small, indexed lookup; a
 * gateway that cannot answer within this budget is treated as unavailable, so
 * a wedged gateway never stalls tool execution.
 */
const GRANT_IPC_TIMEOUT_MS = 2_000;

/**
 * A capability lookup addresses one skill version. The version hash is what
 * binds a grant to skill content: the gateway stores grants per
 * `(skillId, versionHash)`, so a modified skill never inherits the grant for
 * the content that was reviewed.
 */
export interface SkillCapabilityLookup {
  skillId: string;
  versionHash?: string;
}

interface CachedCapabilities {
  capabilities: SkillCapabilities;
  expiresAt: number;
}

/**
 * Last resolved set per `(skillId, versionHash)`. Both hits and misses are
 * cached: a version with no grant is the common case and must not cost an IPC
 * round trip on every tool call.
 */
const capabilityCache = new Map<string, CachedCapabilities>();

/** In-flight reads, so concurrent callers share one gateway round trip. */
const inFlightReads = new Map<string, Promise<SkillCapabilities>>();

function capabilitiesFromList(
  capabilities: readonly SkillCapability[],
): SkillCapabilities {
  const set = new Set(capabilities);
  return {
    host_exec: set.has("host_exec"),
    vetted: set.has("vetted"),
    input_repairs: set.has("input_repairs"),
    computer_use_target: set.has("computer_use_target"),
  };
}

/**
 * The cache key, or null when the lookup cannot address a grant. Skill ids are
 * directory basenames; separators are rejected so an id can never address
 * another skill's entry.
 */
function lookupKey(input: SkillCapabilityLookup): string | null {
  const { skillId, versionHash } = input;
  if (!skillId || !versionHash) {
    return null;
  }
  if (skillId.includes("/") || skillId.includes("\\")) {
    return null;
  }
  return `${skillId}\0${versionHash}`;
}

function matchingGrant(
  grants: readonly SkillGrantIpc[],
  skillId: string,
  versionHash: string,
): SkillGrantIpc | undefined {
  return grants.find(
    (grant) => grant.skillId === skillId && grant.versionHash === versionHash,
  );
}

/**
 * Read the grant for one skill version from the gateway.
 *
 * Fail-closed in every direction: an unreachable gateway, a failed call, an
 * answer that does not match the contract, and a version with no row all
 * resolve to the empty set. The gateway answers an unreadable store with an
 * empty list for the same reason.
 */
async function readGrantCapabilities(
  skillId: string,
  versionHash: string,
): Promise<SkillCapabilities> {
  let response: unknown;
  try {
    response = await ipcCall(
      "get_skill_grants",
      { skillId, versionHash },
      GRANT_IPC_TIMEOUT_MS,
    );
  } catch (err) {
    log.warn(
      { err, skillId, versionHash },
      "Skill grant read failed; denying every capability",
    );
    return NO_SKILL_CAPABILITIES;
  }

  const parsed = GetSkillGrantsIpcResponseSchema.safeParse(response);
  if (!parsed.success) {
    log.warn(
      { skillId, versionHash, issues: parsed.error.issues },
      "Skill grant response does not match the contract; denying every capability",
    );
    return NO_SKILL_CAPABILITIES;
  }

  const grant = matchingGrant(parsed.data.grants, skillId, versionHash);
  if (!grant) {
    return NO_SKILL_CAPABILITIES;
  }

  return capabilitiesFromList(grant.capabilities);
}

/**
 * Resolve the capability set granted to one skill version.
 *
 * A capability is never inferred from the skill's own manifest nor from its
 * origin (`bundled` is provenance, not permission): it is granted in the
 * gateway for this exact content version, and anything unreadable or absent is
 * denied.
 */
export async function getSkillCapabilities(
  input: SkillCapabilityLookup,
): Promise<SkillCapabilities> {
  const key = lookupKey(input);
  if (key === null) {
    return NO_SKILL_CAPABILITIES;
  }

  const cached = capabilityCache.get(key);
  if (cached && cached.expiresAt > Date.now()) {
    return cached.capabilities;
  }

  const pending = inFlightReads.get(key);
  if (pending) {
    return pending;
  }

  const read = readGrantCapabilities(input.skillId, input.versionHash!)
    .then((capabilities) => {
      capabilityCache.set(key, {
        capabilities,
        expiresAt: Date.now() + GRANT_CACHE_TTL_MS,
      });
      return capabilities;
    })
    .finally(() => {
      inFlightReads.delete(key);
    });

  inFlightReads.set(key, read);
  return read;
}

/**
 * The last resolved set for one skill version, without waiting on the gateway.
 *
 * Fail-closed on a miss: an unresolved version has no capabilities. A miss
 * also starts a background read so the next caller sees the resolved set; the
 * only synchronous consumer is the computer-use routing hint, where the
 * fail-closed answer (the manifest's own target) is also the safe one.
 */
export function getCachedSkillCapabilities(
  input: SkillCapabilityLookup,
): SkillCapabilities {
  const key = lookupKey(input);
  if (key === null) {
    return NO_SKILL_CAPABILITIES;
  }

  const cached = capabilityCache.get(key);
  if (cached && cached.expiresAt > Date.now()) {
    return cached.capabilities;
  }

  void getSkillCapabilities(input).catch((err) => {
    log.warn(
      { err, ...input },
      "Background skill grant refresh failed; capabilities stay denied",
    );
  });

  return NO_SKILL_CAPABILITIES;
}

/** Whether one capability is granted for the given skill version. */
export async function hasSkillCapability(
  input: SkillCapabilityLookup,
  capability: SkillCapability,
): Promise<boolean> {
  return (await getSkillCapabilities(input))[capability];
}

/** Clear the memoized capability sets. Exported for tests. */
export function _clearSkillCapabilityCacheForTest(): void {
  capabilityCache.clear();
  inFlightReads.clear();
}
