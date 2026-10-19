/**
 * Vault secret registry: an in-memory snapshot of stored credential values
 * used to enrich tool-output redaction. When a redacted value byte-matches a
 * vault credential, the marker can name the service/field, the value prefix
 * (the identifying head of the key), and the value length, so the model can
 * tell credentials apart and reason about their shape without ever seeing
 * the value.
 *
 * Values live only in module memory and are never logged. The snapshot is
 * re-read from the secure backend on a TTL. Lookups are synchronous because
 * the tool-result path is synchronous; staleness is bounded by REFRESH_TTL_MS
 * and the format-based scanner patterns still catch registered-but-stale
 * secrets by shape.
 */

import { getLogger } from "../util/logger.js";
import { getSecureKeyResultAsync, listSecureKeysAsync } from "./secure-keys.js";

const log = getLogger("vault-secret-registry");

/** Re-read the vault snapshot at most this often. */
const REFRESH_TTL_MS = 60_000;

/**
 * Values shorter than this are not registered. Exact-match redaction of
 * short strings risks colliding with ordinary words; real API keys are far
 * longer. Format-based scanner patterns still cover short secrets by shape.
 */
const MIN_REGISTERED_LENGTH = 8;

export interface VaultCredentialInfo {
  /** Secure-backend account name ("credential/<service>/<field>"). */
  account: string;
  service?: string;
  field?: string;
}

/** Pluggable snapshot source so tests can substitute a fake vault. */
export interface VaultSnapshotSource {
  listAccounts(): Promise<{ accounts: string[]; unreachable: boolean }>;
  getValue(
    account: string,
  ): Promise<{ value: string | undefined; unreachable: boolean }>;
}

const defaultSource: VaultSnapshotSource = {
  listAccounts: () => listSecureKeysAsync(),
  getValue: (account) => getSecureKeyResultAsync(account),
};

let registry: Map<string, VaultCredentialInfo> | null = null;
let lastRefreshMs = 0;
let refreshInFlight: Promise<void> | null = null;
/** Test hook: suppresses the fire-and-forget default-source refresh. */
let backgroundRefreshDisabled = false;

function accountToServiceField(account: string): {
  service?: string;
  field?: string;
} {
  const parts = account.split("/");
  if (parts.length === 3 && parts[0] === "credential") {
    return { service: parts[1], field: parts[2] };
  }
  return {};
}

async function refreshRegistry(source: VaultSnapshotSource): Promise<void> {
  try {
    const listed = await source.listAccounts();
    if (listed.unreachable) {
      return;
    }
    const next = new Map<string, VaultCredentialInfo>();
    for (const account of listed.accounts) {
      const result = await source.getValue(account);
      if (result.unreachable || result.value === undefined) {
        continue;
      }
      if (result.value.length < MIN_REGISTERED_LENGTH) {
        continue;
      }
      next.set(result.value, {
        account,
        ...accountToServiceField(account),
      });
    }
    registry = next;
    lastRefreshMs = Date.now();
  } catch (err) {
    log.warn(
      { err },
      "Vault secret registry refresh failed; keeping previous snapshot",
    );
  }
}

function ensureFresh(): void {
  if (backgroundRefreshDisabled) {
    return;
  }
  if (refreshInFlight) {
    return;
  }
  if (registry !== null && Date.now() - lastRefreshMs < REFRESH_TTL_MS) {
    return;
  }
  refreshInFlight = refreshRegistry(defaultSource).finally(() => {
    refreshInFlight = null;
  });
}

/**
 * Synchronous snapshot access. Triggers a fire-and-forget refresh when the
 * snapshot is missing or stale; a call that arrives mid-refresh reads the
 * previous snapshot (or null on the first call after boot, which simply
 * falls back to format-based redaction).
 */
export function getVaultSnapshot(): ReadonlyMap<
  string,
  VaultCredentialInfo
> | null {
  ensureFresh();
  return registry;
}

/** Explicit refresh, primarily for tests. */
export async function refreshVaultRegistry(
  source: VaultSnapshotSource = defaultSource,
): Promise<void> {
  await refreshRegistry(source);
}

/** Reset all module state and suppress background refresh. Test-only. */
export function _resetVaultRegistryForTests(): void {
  registry = null;
  lastRefreshMs = 0;
  refreshInFlight = null;
  backgroundRefreshDisabled = true;
}

/** Re-enable the background refresh after a reset. Test-only. */
export function _enableBackgroundRefreshForTests(): void {
  backgroundRefreshDisabled = false;
}
