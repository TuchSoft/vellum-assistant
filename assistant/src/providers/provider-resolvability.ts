import { VALID_CONNECTION_PROVIDERS } from "./inference/auth.js";
import {
  isConnectionSnapshotLoaded,
  peekConnection,
} from "./inference/connections.js";

/**
 * Selection-time predicate for `ResolveCallSiteOpts.isResolvableProvider`:
 * a provider value dispatches when it is a known vendor/identity or names a
 * connection entry row. Reads the synchronous connection snapshot, so a cold
 * or unloaded snapshot is treated the same as an unavailable database: the
 * provider is assumed resolvable and dispatch soft-fails on its own.
 */
export function dispatchProviderResolvable(provider: string): boolean {
  if (VALID_CONNECTION_PROVIDERS.includes(provider)) {
    return true;
  }
  if (!isConnectionSnapshotLoaded()) {
    return true;
  }
  return peekConnection(provider) != null;
}
