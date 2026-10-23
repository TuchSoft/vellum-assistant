/**
 * Declares the installed skill versions to the gateway.
 *
 * The gateway owns the grant store and the defaults that seed it, but only the
 * assistant can see the skill directories, so only the assistant can say which
 * `(skillId, versionHash)` pairs exist right now. It declares those facts at
 * startup and whenever the catalog changes; the gateway decides which
 * capabilities each declared version starts with.
 *
 * This module never grants anything. A declaration that fails, is refused, or
 * arrives after a revocation changes nothing: the capability a skill actually
 * runs with still comes from `getSkillCapabilities` (fail-closed).
 *
 * Cost is kept off the hot path: a declaration hashes the skill directories, so
 * calls are coalesced behind a short debounce, a repeated declaration of the
 * same set is dropped, and only one call is in flight at a time. A catalog
 * change that lands while a declaration is running asks for one more pass
 * instead of hashing in parallel.
 */

import {
  type DeclareSkillVersionsIpcParams,
  DeclareSkillVersionsIpcResponseSchema,
} from "@vellumai/gateway-client/gateway-ipc-contracts";

import { loadSkillCatalog } from "../config/skills.js";
import { ipcCall } from "../ipc/gateway-client.js";
import { getLogger } from "../util/logger.js";
import { computeSkillVersionHash } from "./version-hash.js";

const log = getLogger("skill-grant-declaration");

/** Per-call cap. The declaration is a bounded write; a wedged gateway is skipped. */
const DECLARE_TIMEOUT_MS = 5_000;

/** Coalesce a burst of catalog changes (an install touches several files). */
const DECLARE_DEBOUNCE_MS = 500;

/**
 * Backoff for a gateway that is not listening yet. At daemon start the gateway
 * process comes up after the assistant, so the first declaration can arrive
 * before the socket exists; these attempts cover that window and then stop.
 */
const RETRY_DELAYS_MS = [2_000, 5_000, 10_000, 30_000, 60_000];

export type SkillVersionDeclaration =
  DeclareSkillVersionsIpcParams["skills"][number];

export type SkillDeclarationOutcome = "declared" | "unchanged" | "failed";

/** The last set the gateway accepted, so a repeat declaration costs nothing. */
let lastDeclaredFingerprint: string | null = null;
let declarationInFlight: Promise<SkillDeclarationOutcome> | null = null;
let rerunRequested = false;
let debounceTimer: ReturnType<typeof setTimeout> | null = null;

/**
 * Every installed skill with the version hash of its current content.
 *
 * A skill whose directory cannot be hashed is skipped rather than declared with
 * a guessed hash: an unknown version must stay denied, and a wrong hash would
 * address someone else's grant. A catalog that cannot be read at all yields an
 * empty list for the same reason: the declaration is advisory, so a broken
 * catalog must never turn into an error on a boot or a skill change.
 */
export function collectInstalledSkillVersions(): SkillVersionDeclaration[] {
  const declared: SkillVersionDeclaration[] = [];

  let catalog: ReturnType<typeof loadSkillCatalog>;
  try {
    catalog = loadSkillCatalog();
  } catch (err) {
    log.warn({ err }, "Cannot read the skill catalog; declaring no versions");
    return declared;
  }

  for (const skill of catalog) {
    try {
      declared.push({
        skillId: skill.id,
        versionHash: computeSkillVersionHash(skill.directoryPath),
      });
    } catch (err) {
      log.warn(
        { err, skillId: skill.id, directoryPath: skill.directoryPath },
        "Cannot hash skill content; leaving it undeclared",
      );
    }
  }

  return declared;
}

function fingerprintOf(skills: readonly SkillVersionDeclaration[]): string {
  return skills
    .map((skill) => `${skill.skillId}@${skill.versionHash}`)
    .sort()
    .join("\n");
}

async function runDeclaration(): Promise<SkillDeclarationOutcome> {
  const skills = collectInstalledSkillVersions();
  const fingerprint = fingerprintOf(skills);

  if (fingerprint === lastDeclaredFingerprint) {
    return "unchanged";
  }

  let response: unknown;
  try {
    response = await ipcCall(
      "declare_skill_versions",
      { skills },
      DECLARE_TIMEOUT_MS,
    );
  } catch (err) {
    log.warn({ err }, "Skill version declaration failed");
    return "failed";
  }

  if (response === undefined) {
    log.warn(
      { skills: skills.length },
      "Skill version declaration got no answer; capabilities stay as they are",
    );
    return "failed";
  }

  const parsed = DeclareSkillVersionsIpcResponseSchema.safeParse(response);
  if (!parsed.success) {
    log.warn(
      { issues: parsed.error.issues },
      "Skill version declaration answer does not match the contract; ignoring it",
    );
    return "failed";
  }

  lastDeclaredFingerprint = fingerprint;
  log.info(
    {
      declared: skills.length,
      seeded: parsed.data.seeded.length,
      skipped: parsed.data.skipped.length,
    },
    "Declared installed skill versions",
  );
  return "declared";
}

/**
 * Declare the installed skill versions, sharing one call between concurrent
 * callers.
 *
 * A caller that knows the catalog changed uses {@link requestDeclaration}
 * instead: this entry point answers an in-flight declaration rather than
 * queueing another hash pass behind it.
 */
export async function declareInstalledSkillVersions(): Promise<SkillDeclarationOutcome> {
  if (declarationInFlight) {
    return declarationInFlight;
  }

  declarationInFlight = (async (): Promise<SkillDeclarationOutcome> => {
    let outcome: SkillDeclarationOutcome = "unchanged";
    do {
      rerunRequested = false;
      outcome = await runDeclaration();
    } while (rerunRequested && outcome !== "failed");
    return outcome;
  })();

  try {
    return await declarationInFlight;
  } finally {
    declarationInFlight = null;
  }
}

/**
 * Declare after a known catalog change: join an in-flight declaration and ask
 * for one more pass once it finishes, so the change is never dropped.
 */
function requestDeclaration(): Promise<SkillDeclarationOutcome> {
  if (declarationInFlight) {
    rerunRequested = true;
    return declarationInFlight;
  }
  return declareInstalledSkillVersions();
}

function scheduleRetry(attempt: number): void {
  const delay = RETRY_DELAYS_MS[attempt];
  if (delay === undefined) {
    log.warn(
      "Gateway never accepted the skill version declaration; capabilities stay denied until the catalog changes",
    );
    return;
  }

  const timer = setTimeout(() => {
    void declareInstalledSkillVersions().then((outcome) => {
      if (outcome === "failed") {
        scheduleRetry(attempt + 1);
      }
    });
  }, delay);
  timer.unref?.();
}

/**
 * Re-declare after the skill catalog changed. Fire-and-forget: callers are on
 * request paths and must not wait on the gateway.
 */
export function notifySkillCatalogChanged(reason: string): void {
  if (debounceTimer !== null) {
    return;
  }

  log.debug({ reason }, "Scheduled skill version declaration");
  const timer = setTimeout(() => {
    debounceTimer = null;
    void requestDeclaration()
      .then((outcome) => {
        if (outcome === "failed") {
          scheduleRetry(0);
        }
      })
      .catch((err) => {
        log.warn({ err }, "Skill version declaration threw");
      });
  }, DECLARE_DEBOUNCE_MS);
  timer.unref?.();
  debounceTimer = timer;
}

/**
 * Declare at daemon startup, retrying while the gateway is still coming up.
 * Never blocks boot: the first call runs in the background.
 */
export function startSkillVersionDeclaration(): void {
  void requestDeclaration()
    .then((outcome) => {
      if (outcome === "failed") {
        scheduleRetry(0);
      }
    })
    .catch((err) => {
      log.warn({ err }, "Startup skill version declaration threw");
    });
}

/** @internal Test-only: clear the memoized fingerprint and pending timers. */
export function _resetSkillVersionDeclarationForTest(): void {
  lastDeclaredFingerprint = null;
  declarationInFlight = null;
  rerunRequested = false;
  if (debounceTimer !== null) {
    clearTimeout(debounceTimer);
    debounceTimer = null;
  }
}
