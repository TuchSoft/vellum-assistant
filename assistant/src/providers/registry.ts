import { type LLMConfig } from "../config/schemas/llm.js";
import { ProviderNotConfiguredError } from "../util/errors.js";
import { getLogger } from "../util/logger.js";
import {
  isAnthropicDelegatingGateway,
  isAnthropicModel,
} from "./anthropic-gateway-shared.js";
import {
  resolveGatewayConnectionName,
  resolveGatewayModel,
} from "./gateway.js";
import { createAdapterFromConnection } from "./inference/adapter-factory.js";
// ---------------------------------------------------------------------------
// Per-connection provider cache (mix-and-match support)
// ---------------------------------------------------------------------------
import type { ProviderConnection } from "./inference/auth.js";
import {
  effectiveConnectionAuth,
  ROUTING_IDENTITY_PROVIDERS,
} from "./inference/auth.js";
import {
  ensureConnectionSnapshot,
  peekConnection,
} from "./inference/connections.js";
import { resolveAuth } from "./inference/resolve-auth.js";
import { PROVIDER_CATALOG } from "./model-catalog.js";
import type { Provider } from "./types.js";
import { UsageTrackingProvider } from "./usage-tracking.js";

const log = getLogger("provider-registry");

const providers = new Map<string, Provider>();
const routingSources = new Map<string, "user-key" | "managed-proxy">();
const NATIVE_WEB_SEARCH_PROVIDER_IDS = new Set(["anthropic", "openai"]);

/**
 * A cached per-connection provider and the wall-clock time it goes stale.
 *
 * The credential store is the source of truth for a connection's API key; a
 * resolved provider bakes that key into its auth headers and is only a cache of
 * it. `expiresAt` bounds how long a cached provider is trusted before the key
 * is re-read from the store, so a credential rotated out-of-band (e.g. the
 * platform reprovisioning the assistant API key) is picked up on its own — in
 * every process that holds this cache, with no cross-process invalidation.
 */
interface CachedConnectionProvider {
  provider: Provider;
  expiresAt: number;
}

/**
 * How long a resolved per-connection provider is served from cache before it is
 * re-resolved from the credential store. Bounds credential staleness in any
 * process holding the cache (the daemon and each sidecar worker) to this
 * window. Kept short enough that a rotated key self-heals quickly, long enough
 * that repeated resolutions within a burst still reuse one adapter.
 */
const CONNECTION_PROVIDER_CACHE_TTL_MS = 60_000;

/** Per-connection provider cache, keyed by connection name, effective provider, and model. */
const connectionProviders = new Map<string, CachedConnectionProvider>();

function getConnectionProviderCacheKey(
  connection: ProviderConnection,
  model: string,
  effectiveProvider: string,
): string {
  // `effectiveProvider` differs from `connection.provider` only for the
  // provider-agnostic Vellum-managed connection, where one connection name
  // serves multiple upstreams — include it so those entries don't collide.
  return `${connection.name}\u0000${effectiveProvider}\u0000${model}`;
}

function registerProvider(name: string, provider: Provider): void {
  providers.set(name, new UsageTrackingProvider(provider));
}

export function getProvider(name: string): Provider {
  const provider = providers.get(name);
  if (!provider) {
    throw new ProviderNotConfiguredError(name, listProviders());
  }
  return provider;
}

export function listProviders(): string[] {
  return Array.from(providers.keys());
}

export function getProviderRoutingSource(
  name: string,
): "user-key" | "managed-proxy" | undefined {
  return routingSources.get(name);
}

export interface ProvidersConfig {
  services: {
    inference: Record<string, never>;
    "image-generation": {
      provider: string;
      model: string;
    };
    "web-search": {
      provider: string;
    };
  };
  llm: LLMConfig;
  timeouts?: { providerStreamTimeoutSec?: number };
}

function resolveModel(config: ProvidersConfig): string {
  return resolveGatewayModel(config.llm);
}

export function isNativeWebSearchCapableProvider(
  providerName: string,
  model: string,
): boolean {
  if (NATIVE_WEB_SEARCH_PROVIDER_IDS.has(providerName)) {
    return true;
  }
  if (isAnthropicDelegatingGateway(providerName) && isAnthropicModel(model)) {
    return true;
  }
  return false;
}

export function shouldUseNativeWebSearch(
  _config: ProvidersConfig,
  _providerName: string,
  _model: string,
): boolean {
  // The gateway transport does not expose provider-native web search; the
  // daemon executes the search tool itself.
  return false;
}

/**
 * Resolve provider credentials. User key takes precedence; managed proxy is
 * used as a fallback when platform prerequisites are available.
 *
 * The routing decision is now derived from credential availability rather than
 * the removed `services.inference.mode` config field.
 */
export async function initializeProviders(
  config: ProvidersConfig,
): Promise<void> {
  providers.clear();
  routingSources.clear();
  connectionProviders.clear();

  await ensureConnectionSnapshot();
  const connectionName = resolveGatewayConnectionName();
  if (connectionName == null) {
    log.info("No LLM gateway connection configured yet");
    return;
  }
  const connection = peekConnection(connectionName);
  if (connection == null) {
    log.warn(
      { connectionName },
      "Gateway connection row is missing from the snapshot",
    );
    return;
  }
  const provider = await resolveProviderFromConnection(connection, config, {
    model: resolveGatewayModel(config.llm),
  });
  if (provider == null) {
    log.warn(
      { connectionName },
      "Gateway connection resolved to no adapter; calls will degrade",
    );
    return;
  }
  registerProvider(connectionName, provider);
  routingSources.set(connectionName, "user-key");
  log.info({ connectionName }, "Gateway provider initialized");
}

// ---------------------------------------------------------------------------
// Per-connection provider resolution (mix-and-match support)
// ---------------------------------------------------------------------------

/**
 * Resolve a provider instance for a named `provider_connection`.
 *
 * Results are cached in `connectionProviders` to avoid redundant vault reads
 * for repeated calls to the same connection. A cached provider bakes in the
 * credential it resolved, so each entry carries a TTL
 * ({@link CONNECTION_PROVIDER_CACHE_TTL_MS}): once it expires the credential is
 * re-read from the store, bounding how long an out-of-band key rotation stays
 * stale. Entries are also cleared eagerly on connection mutations and boot.
 *
 * Returns null when:
 *   - The connection doesn't exist in the DB
 *   - Auth resolution fails (missing credential, platform unavailable, v2 type)
 *   - The provider/auth combination yields no usable adapter
 */
export async function resolveProviderFromConnection(
  connection: ProviderConnection,
  config: ProvidersConfig,
  opts: { model?: string; providerOverride?: string } = {},
): Promise<Provider | null> {
  // The provider-agnostic Vellum-managed connection carries only the `vellum`
  // sentinel on its row, so callers pass the resolved profile's provider here.
  // For every other connection this is `undefined` and the effective provider
  // is the connection's own — no behavior change.
  const effectiveProvider = opts.providerOverride ?? connection.provider;
  const model = opts.model ?? resolveModel(config);
  // Routing identities must already be translated to a factory id
  // (`resolveRoutingIdentity`). `chatgpt` has no factory and must not
  // reach adapter construction. `vellum` is a catalog factory, so it is
  // a valid effectiveProvider after that translation.
  if (
    ROUTING_IDENTITY_PROVIDERS.has(effectiveProvider) &&
    !PROVIDER_CATALOG.some((entry) => entry.id === effectiveProvider)
  ) {
    throw new Error(
      `resolveProviderFromConnection received unresolved routing identity "${effectiveProvider}": translate to a real upstream before adapter construction`,
    );
  }
  const cacheKey = getConnectionProviderCacheKey(
    connection,
    model,
    effectiveProvider,
  );
  const cached = connectionProviders.get(cacheKey);
  if (cached && cached.expiresAt > Date.now()) {
    return cached.provider;
  }
  // A stale entry is a miss: fall through to re-resolve. The credential is
  // re-read from the store below, so a key rotated since the entry was cached
  // is picked up here rather than served stale forever.

  const authResult = await resolveAuth(
    effectiveConnectionAuth(connection),
    effectiveProvider,
    { baseUrl: connection.baseUrl },
  );
  if (!authResult.ok) {
    const err = authResult.error;
    if (err.code === "not_implemented") {
      log.warn(
        { connectionName: connection.name, authType: err.authType },
        `Auth type '${err.authType}' is not yet implemented (v2). ` +
          "Update the connection to use 'api_key', 'platform', or 'none'.",
      );
    } else if (err.code === "credential_not_found") {
      log.warn(
        { connectionName: connection.name, credential: err.credential },
        `Credential '${err.credential}' not found in vault for connection '${connection.name}'.`,
      );
    } else {
      log.warn(
        { connectionName: connection.name },
        `Platform auth unavailable for connection '${connection.name}'.`,
      );
    }
    return null;
  }

  const streamTimeoutMs =
    (config.timeouts?.providerStreamTimeoutSec ?? 1800) * 1000;
  const useNativeWebSearch = shouldUseNativeWebSearch(
    config,
    effectiveProvider,
    model,
  );

  const provider = createAdapterFromConnection(
    connection,
    authResult.resolved,
    {
      model,
      streamTimeoutMs,
      useNativeWebSearch,
      provider: effectiveProvider,
    },
  );

  if (provider) {
    connectionProviders.set(cacheKey, {
      provider,
      expiresAt: Date.now() + CONNECTION_PROVIDER_CACHE_TTL_MS,
    });
  }

  return provider;
}

/** Clear per-connection provider cache (called by initializeProviders on boot). */
export function clearConnectionProviderCache(): void {
  connectionProviders.clear();
}
