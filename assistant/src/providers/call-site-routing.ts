import type { ProvidersConfig } from "./registry.js";
import type {
  Message,
  Provider,
  ProviderResponse,
  SendMessageOptions,
} from "./types.js";

/**
 * Pass-through wrapper kept for the satellite construction path.
 *
 * Every inference call now goes through the single LLM gateway connection, so
 * there is no per-call transport selection left to do. The wrapper stays as a
 * named seam while the remaining callers are migrated.
 */
export class CallSiteRoutingProvider implements Provider {
  public readonly tokenEstimationProvider?: string;
  public readonly supportsNativeWebSearch?: boolean;
  public readonly countInputTokens?: NonNullable<Provider["countInputTokens"]>;

  get name(): string {
    return this.inner.name;
  }

  get routeAttribution() {
    return this.inner.routeAttribution;
  }

  constructor(
    private readonly inner: Provider,
    _resolveByConnection?: unknown,
    _defaultRouteAttribution?: unknown,
  ) {
    this.tokenEstimationProvider = inner.tokenEstimationProvider;
    this.supportsNativeWebSearch = inner.supportsNativeWebSearch;
    if (inner.countInputTokens) {
      this.countInputTokens = inner.countInputTokens.bind(inner);
    }
  }

  supportsNativeWebSearchFor(options?: SendMessageOptions): boolean {
    return this.inner.supportsNativeWebSearchFor
      ? this.inner.supportsNativeWebSearchFor(options)
      : this.inner.supportsNativeWebSearch === true;
  }

  sendMessage(
    messages: Message[],
    options?: SendMessageOptions,
  ): Promise<ProviderResponse> {
    return this.inner.sendMessage(messages, options);
  }
}

/** Wrap a base provider; transport selection is a no-op on the gateway. */
export function wrapWithCallSiteRouting(
  base: Provider,
  _config: ProvidersConfig,
): Provider {
  return base;
}
