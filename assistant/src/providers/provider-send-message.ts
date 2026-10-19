/**
 * Helper utilities for provider callsites that should stay decoupled from
 * provider SDK details. Includes provider resolution, timeout utilities,
 * and response extraction helpers.
 */

import {
  resolveCallSite,
  type ResolveCallSiteOpts,
} from "../config/llm-resolver.js";
import { getConfig } from "../config/loader.js";
import type { LLMCallSite } from "../config/schemas/llm.js";
import type { ProviderRouteAttribution } from "../util/errors.js";
import { getLogger } from "../util/logger.js";
import { tryResolveProviderForConnectionName } from "./connection-resolution.js";
import {
  LLM_GATEWAY_PROVIDER,
  resolveGatewayConnectionName,
} from "./gateway.js";
import { ensureConnectionSnapshot } from "./inference/connections.js";
import { initializeProviders, listProviders } from "./registry.js";
import { recordProviderRequestDiagnostics } from "./request-diagnostics.js";
import type {
  ContentBlock,
  Message,
  Provider,
  ProviderResponse,
  SendMessageOptions,
  ToolUseContent,
} from "./types.js";

const log = getLogger("provider-send-message");

export interface ConfiguredProviderResult {
  provider: Provider;
  configuredProviderName: string;
  /**
   * True when the profile's provider was an entry label and dispatch routed
   * through that row. The row's own credential already signed resolution, so
   * vendor-keyed preflights (which check the generic per-vendor key slot)
   * do not apply to this result.
   */
  entryRouted: boolean;
}

export type ConfiguredProviderOptions = Pick<
  ResolveCallSiteOpts,
  "model" | "conversationModel"
>;

/**
 * Cached promise for the lazy initialization path inside
 * `resolveConfiguredProvider`. When multiple concurrent callers enter before
 * providers are initialized, they all await the same promise instead of
 * each triggering a redundant `initializeProviders` call.
 */
let lazyInitPromise: Promise<void> | null = null;

export class CallSiteConfiguredProvider implements Provider {
  public readonly name: string;
  public readonly tokenEstimationProvider?: string;
  // Forward native web-search capability so it survives the wrapper chain
  // (callers like the advisor consult gate on it). Fixed at construction.
  public readonly supportsNativeWebSearch?: boolean;

  /**
   * Route the inner adapter signs with, stamped at connection resolution.
   * Forwarded live (not snapshotted) so consumers holding this wrapper —
   * e.g. the save-time probe's billing gate — read the row dispatch
   * actually selected.
   */
  get routeAttribution(): ProviderRouteAttribution | undefined {
    return this.inner.routeAttribution;
  }

  constructor(
    private readonly inner: Provider,
    private readonly callSite: LLMCallSite,
    private readonly model?: string,
    private readonly conversationModel?: string,
  ) {
    this.name = inner.name;
    this.tokenEstimationProvider = inner.tokenEstimationProvider;
    this.supportsNativeWebSearch = inner.supportsNativeWebSearch;
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
    const config = options?.config;
    // Each field falls back independently. Naming a call site per-call must
    // not suppress the stored model pin — they are orthogonal, and dropping
    // the pin would leave the transport resolving from the call-site default.
    return this.inner.sendMessage(messages, {
      ...options,
      config: {
        ...config,
        callSite: config?.callSite ?? this.callSite,
        ...(config?.model === undefined && this.model !== undefined
          ? { model: this.model }
          : {}),
        ...(config?.conversationModel === undefined &&
        this.conversationModel !== undefined
          ? { conversationModel: this.conversationModel }
          : {}),
      },
    });
  }
}

/**
 * Resolve the configured provider with full selection metadata.
 * If providers haven't been initialized yet (e.g. non-daemon code paths),
 * performs a one-shot `initializeProviders(getConfig())`.
 *
 * The alias is sourced from `resolveCallSite(callSite, config.llm, opts)`.
 * The `callSite` argument is required so the resolver can layer per-call-site
 * configuration; pass the closest matching call-site identifier from
 * `LLMCallSiteEnum` when adding a new caller. Pass `opts.model` to pin an
 * alias for this request (a scheduled run, a subagent role) and
 * `opts.conversationModel` for the interactive conversation selection.
 *
 * Returns `null` when no providers are available at all.
 */
export async function resolveConfiguredProvider(
  callSite: LLMCallSite,
  opts: ConfiguredProviderOptions = {},
): Promise<ConfiguredProviderResult | null> {
  const config = getConfig();

  if (listProviders().length === 0) {
    if (!lazyInitPromise) {
      lazyInitPromise = initializeProviders(config).finally(() => {
        lazyInitPromise = null;
      });
    }
    try {
      await lazyInitPromise;
    } catch {
      return null;
    }
  }

  await ensureConnectionSnapshot();
  const resolved = resolveCallSite(callSite, config.llm, opts);
  if (resolved.status === "disabled") {
    log.debug({ callSite }, "Call site is disabled; no provider resolved");
    return null;
  }
  const connectionName = resolveGatewayConnectionName();
  if (connectionName == null) {
    log.warn(
      { callSite, model: resolved.model, reason: "no_connection" },
      "No LLM gateway connection is configured — returning null so the call site can degrade",
    );
    return null;
  }

  const connectionProvider = await tryResolveProviderForConnectionName(
    connectionName,
    config,
    LLM_GATEWAY_PROVIDER,
    resolved.model,
  );
  if (!connectionProvider) {
    log.warn(
      {
        callSite,
        connectionName,
        model: resolved.model,
        reason: "credential_unavailable",
      },
      "Gateway connection resolved to no usable adapter — returning null so the call site can degrade",
    );
    return null;
  }
  recordProviderRequestDiagnostics({ connection_name: connectionName });
  return {
    provider: new CallSiteConfiguredProvider(
      connectionProvider,
      callSite,
      opts.model,
      opts.conversationModel,
    ),
    configuredProviderName: LLM_GATEWAY_PROVIDER,
    entryRouted: false,
  };
}

/**
 * Resolve the configured provider through the registry.
 * Thin wrapper around `resolveConfiguredProvider()` for callsites
 * that only need the Provider instance.
 *
 * `callSite` is required — see `resolveConfiguredProvider`. Returns `null`
 * when no providers are available.
 */
export async function getConfiguredProvider(
  callSite: LLMCallSite,
  opts: ConfiguredProviderOptions = {},
): Promise<Provider | null> {
  const result = await resolveConfiguredProvider(callSite, opts);
  return result?.provider ?? null;
}

/**
 * Create an AbortSignal that fires after `ms` milliseconds.
 * Returns the signal and a cleanup function to clear the timer.
 */
export function createTimeout(ms: number): {
  signal: AbortSignal;
  cleanup: () => void;
} {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), ms);
  return {
    signal: controller.signal,
    cleanup: () => clearTimeout(timer),
  };
}

/**
 * Extract the first text block's text from a ProviderResponse.
 * Returns empty string if no text block is found.
 */
export function extractText(response: ProviderResponse): string {
  const block = response.content.find(
    (b): b is Extract<ContentBlock, { type: "text" }> => b.type === "text",
  );
  return block?.text?.trim() ?? "";
}

/**
 * Extract all text blocks from a ProviderResponse and join them.
 */
export function extractAllText(response: ProviderResponse): string {
  const parts = response.content
    .filter(
      (b): b is Extract<ContentBlock, { type: "text" }> => b.type === "text",
    )
    .map((b) => b.text);
  // Join consecutive text blocks with a space, but skip the separator when
  // either side already has whitespace (avoids double-spacing).
  let result = parts[0] ?? "";
  for (let i = 1; i < parts.length; i++) {
    const prev = result[result.length - 1];
    const next = parts[i][0];
    if (
      prev &&
      next &&
      prev !== " " &&
      prev !== "\n" &&
      prev !== "\t" &&
      next !== " " &&
      next !== "\n" &&
      next !== "\t"
    ) {
      result += " ";
    }
    result += parts[i];
  }
  return result;
}

/**
 * Find the first tool_use block in a ProviderResponse.
 */
export function extractToolUse(
  response: ProviderResponse,
): ToolUseContent | undefined {
  return response.content.find(
    (b): b is ToolUseContent => b.type === "tool_use",
  );
}

/**
 * Build a single user message in the provider Message format.
 */
export function userMessage(text: string): Message {
  return { role: "user", content: [{ type: "text", text }] };
}
