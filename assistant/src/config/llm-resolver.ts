import { getLogger } from "../util/logger.js";
import { CALL_SITE_DEFAULTS } from "./call-site-defaults.js";
import {
  getCatalogEntry,
  isKnownAlias,
  listCatalogEntries,
} from "./llm-catalog.js";
import {
  type ContextWindow,
  ContextWindowSchema,
  type LLMCallSite,
  type LLMConfig,
} from "./schemas/llm.js";

/**
 * Resolves the gateway alias for a call site.
 *
 * Selection is a single-winner chain (high to low):
 *   1. `opts.model` — an explicit pin for this request (scheduled run,
 *      subagent role, plugin-selected alias). A pin naming an unknown alias is
 *      a hard error: it was written deliberately and silently downgrading it
 *      would hide a broken configuration.
 *   2. `llm.callSites[callSite].model`, then the shipped
 *      `CALL_SITE_DEFAULTS[callSite].model`. An unknown alias here is reported
 *      through `onResolutionFallback` and selection continues.
 *   3. `opts.conversationModel` — the interactive conversation's selection.
 *      Background callers omit it, so scheduled and job runs are unaffected by
 *      whichever model a conversation is using.
 *   4. `llm.defaultModel`.
 *
 * When the alias a call site names is missing from the catalog, resolution
 * degrades instead of failing: it walks `llm.defaultModel`, then the shipped
 * call-site default, then the interactive selection, then a deterministic
 * catalog chat alias (`main`, else the first chat entry). The outcome carries
 * `degraded`/`reason` so callers can surface the situation, and the missing
 * alias is logged once per call site and alias rather than on every request.
 *
 * The resolved config carries no model parameters: max tokens, temperature
 * and reasoning effort live on the gateway alias. Keeping them out of the
 * request is what lets those defaults apply.
 *
 * Synchronous: the catalog is read from its in-memory snapshot. The only side
 * effect is the deduplicated degradation log line.
 */

export type ResolutionSource =
  | "pinned"
  | "call_site"
  | "chat"
  | "default"
  | "fallback";

export type ResolutionFallbackReason = "unknown_alias";

/** Why a call site could not use the alias it names. */
export type DegradationReason = "call_site_alias_missing" | "catalog_empty";

const log = getLogger("config/llm-resolver");

/** One warning per call site and missing alias, not one per request. */
const loggedDegradations = new Set<string>();

function logDegradationOnce(
  callSite: LLMCallSite,
  requested: string,
  reason: DegradationReason,
  effectiveModel: string,
): void {
  const key = `${callSite}\u0000${requested}\u0000${reason}`;
  if (loggedDegradations.has(key)) {
    return;
  }
  loggedDegradations.add(key);
  log.warn(
    { callSite, requested, reason, effectiveModel },
    `Call site "${callSite}" names alias "${requested}", which is not in the gateway catalog (${reason}). Using "${effectiveModel}".`,
  );
}

/** Test-only seam: forget deduplicated degradation warnings. */
export function __resetDegradationLogForTests(): void {
  loggedDegradations.clear();
}

/** Test-only seam: how many distinct degradation warnings were logged. */
export function __degradationLogCountForTests(): number {
  return loggedDegradations.size;
}

export interface ResolveCallSiteOpts {
  /** Explicit alias for this request; wins over the call-site default. */
  model?: string;
  /** Interactive conversation selection, used only when no alias wins above. */
  conversationModel?: string;
  /** Invoked once per rung whose alias could not be used. */
  onResolutionFallback?: (info: {
    callSite: LLMCallSite;
    requested: string;
    reason: ResolutionFallbackReason;
  }) => void;
}

export interface ResolvedCallConfig {
  model: string;
  disableCache: boolean;
  contextWindow: ContextWindow;
}

export type CallSiteResolution =
  | {
      status: "ok";
      callSite: LLMCallSite;
      model: string;
      source: ResolutionSource;
      /** True when the configured alias was missing and a fallback won. */
      degraded: boolean;
      /** Why the configured alias could not be used; null when not degraded. */
      reason: DegradationReason | null;
      config: ResolvedCallConfig;
    }
  | { status: "disabled"; callSite: LLMCallSite };

/**
 * Display/edit view of a call-site resolution. `configuredModel` is the
 * user's pin (null means inherit), `effectiveModel` is the alias that will
 * actually be sent, and `degraded` reports that the two differ because the
 * pinned alias disappeared from the catalog.
 */
export interface CallSiteOutcome {
  callSite: LLMCallSite;
  enabled: boolean;
  configuredModel: string | null;
  effectiveModel: string | null;
  source: ResolutionSource | "disabled";
  degraded: boolean;
  reason: DegradationReason | null;
}

export class ModelNotInCatalogError extends Error {
  constructor(
    readonly alias: string,
    readonly callSite: LLMCallSite,
    readonly available: string[],
  ) {
    super(
      `Model "${alias}" is not in the gateway catalog (call site "${callSite}"). Available aliases: ${available.join(", ")}.`,
    );
    this.name = "ModelNotInCatalogError";
  }
}

export class DisabledCallSiteError extends Error {
  constructor(readonly callSite: LLMCallSite) {
    super(`Call site "${callSite}" is disabled.`);
    this.name = "DisabledCallSiteError";
  }
}

function aliasAvailable(llm: LLMConfig, alias: string): boolean {
  return isKnownAlias(alias) || llm.catalogOverrides?.[alias] != null;
}

function availableAliases(llm: LLMConfig): string[] {
  const aliases = new Set<string>();
  for (const entry of listCatalogEntries()) {
    aliases.add(entry.alias);
  }
  for (const alias of Object.keys(llm.catalogOverrides ?? {})) {
    aliases.add(alias);
  }
  return [...aliases].sort();
}

function isDisabled(callSite: LLMCallSite, llm: LLMConfig): boolean {
  return (
    llm.callSites?.[callSite]?.enabled === false ||
    CALL_SITE_DEFAULTS[callSite]?.enabled === false
  );
}

/**
 * The alias used when the one a call site names is absent from the catalog.
 * Order matters: the workspace default, then the shipped call-site default,
 * then the interactive selection, then a deterministic chat alias.
 */
function degradedAlias(
  callSite: LLMCallSite,
  llm: LLMConfig,
  conversationModel: string | undefined,
): { model: string; source: ResolutionSource; reason: DegradationReason } {
  if (aliasAvailable(llm, llm.defaultModel)) {
    return {
      model: llm.defaultModel,
      source: "default",
      reason: "call_site_alias_missing",
    };
  }
  const shipped = CALL_SITE_DEFAULTS[callSite]?.model;
  if (shipped != null && aliasAvailable(llm, shipped)) {
    return {
      model: shipped,
      source: "call_site",
      reason: "call_site_alias_missing",
    };
  }
  const chatModel = conversationModel?.trim();
  if (
    chatModel != null &&
    chatModel.length > 0 &&
    aliasAvailable(llm, chatModel)
  ) {
    return {
      model: chatModel,
      source: "chat",
      reason: "call_site_alias_missing",
    };
  }
  const chatEntries = listCatalogEntries("chat");
  const preferred =
    chatEntries.find((entry) => entry.alias === "main") ??
    chatEntries[0] ??
    listCatalogEntries()[0];
  if (preferred != null) {
    return {
      model: preferred.alias,
      source: "fallback",
      reason: "call_site_alias_missing",
    };
  }
  // No catalog at all (first boot before the fetch, or an empty gateway):
  // keep the workspace default so the request still has a model to send.
  return {
    model: llm.defaultModel,
    source: "default",
    reason: "catalog_empty",
  };
}

function mergeContextWindow(
  callSite: LLMCallSite,
  llm: LLMConfig,
): ContextWindow {
  const shipped = CALL_SITE_DEFAULTS[callSite]?.contextWindow;
  const workspace = llm.callSites?.[callSite]?.contextWindow;
  const merged = deepMerge(
    ContextWindowSchema.parse({}) as unknown as Record<string, unknown>,
    shipped as Record<string, unknown> | undefined,
    workspace as Record<string, unknown> | undefined,
  );
  return ContextWindowSchema.parse(merged);
}

export function resolveCallSite(
  callSite: LLMCallSite,
  llm: LLMConfig,
  opts: ResolveCallSiteOpts = {},
): CallSiteResolution {
  if (isDisabled(callSite, llm)) {
    return { status: "disabled", callSite };
  }

  const report = (requested: string) =>
    opts.onResolutionFallback?.({
      callSite,
      requested,
      reason: "unknown_alias",
    });

  const build = (
    model: string,
    source: ResolutionSource,
    degraded = false,
    reason: DegradationReason | null = null,
  ): CallSiteResolution => ({
    status: "ok",
    callSite,
    model,
    source,
    degraded,
    reason,
    config: {
      model,
      disableCache:
        llm.callSites?.[callSite]?.disableCache ??
        CALL_SITE_DEFAULTS[callSite]?.disableCache ??
        false,
      contextWindow: mergeContextWindow(callSite, llm),
    },
  });

  const degrade = (requested: string): CallSiteResolution => {
    const fallback = degradedAlias(callSite, llm, opts.conversationModel);
    logDegradationOnce(callSite, requested, fallback.reason, fallback.model);
    return build(fallback.model, fallback.source, true, fallback.reason);
  };

  const pinned = opts.model?.trim();
  if (pinned != null && pinned.length > 0) {
    if (!aliasAvailable(llm, pinned)) {
      throw new ModelNotInCatalogError(pinned, callSite, availableAliases(llm));
    }
    return build(pinned, "pinned");
  }

  const configured = llm.callSites?.[callSite]?.model;
  if (configured != null) {
    if (aliasAvailable(llm, configured)) {
      return build(configured, "call_site");
    }
    report(configured);
    return degrade(configured);
  }

  const shipped = CALL_SITE_DEFAULTS[callSite]?.model;
  if (shipped != null) {
    if (aliasAvailable(llm, shipped)) {
      return build(shipped, "call_site");
    }
    report(shipped);
    return degrade(shipped);
  }

  const chatModel = opts.conversationModel?.trim();
  if (chatModel != null && chatModel.length > 0) {
    if (aliasAvailable(llm, chatModel)) {
      return build(chatModel, "chat");
    }
    report(chatModel);
  }

  if (aliasAvailable(llm, llm.defaultModel)) {
    return build(llm.defaultModel, "default");
  }

  return degrade(chatModel?.length ? chatModel : llm.defaultModel);
}

/** Resolved config for a call site; throws when the call site is disabled. */
export function resolveCallSiteConfig(
  callSite: LLMCallSite,
  llm: LLMConfig,
  opts: ResolveCallSiteOpts = {},
): ResolvedCallConfig {
  const resolution = resolveCallSite(callSite, llm, opts);
  if (resolution.status === "disabled") {
    throw new DisabledCallSiteError(callSite);
  }
  return resolution.config;
}

/**
 * Structured resolution for settings surfaces: the configured pin, the alias
 * that will actually be used, and whether the two diverge because the pin is
 * missing from the catalog.
 */
export function resolveCallSiteOutcome(
  callSite: LLMCallSite,
  llm: LLMConfig,
  opts: ResolveCallSiteOpts = {},
): CallSiteOutcome {
  const configuredModel = llm.callSites?.[callSite]?.model ?? null;
  const resolution = resolveCallSite(callSite, llm, opts);
  if (resolution.status === "disabled") {
    return {
      callSite,
      enabled: false,
      configuredModel,
      effectiveModel: null,
      source: "disabled",
      degraded: false,
      reason: null,
    };
  }
  return {
    callSite,
    enabled: true,
    configuredModel,
    effectiveModel: resolution.model,
    source: resolution.source,
    degraded: resolution.degraded,
    reason: resolution.reason,
  };
}

/**
 * The winning alias and its rung, or null for a disabled call site. Used by
 * display and attribution paths that must not throw.
 */
export function resolveEffectiveModel(
  callSite: LLMCallSite,
  llm: LLMConfig,
  opts: ResolveCallSiteOpts = {},
): { model: string; source: ResolutionSource } | null {
  try {
    const resolution = resolveCallSite(callSite, llm, opts);
    return resolution.status === "disabled"
      ? null
      : { model: resolution.model, source: resolution.source };
  } catch {
    return null;
  }
}

/** Whether a call site is disabled by the workspace or by its shipped default. */
export function isCallSiteDisabled(
  callSite: LLMCallSite,
  llm: LLMConfig,
): boolean {
  return isDisabled(callSite, llm);
}

/**
 * The code-owned default alias for a call site, or undefined when the site
 * inherits (`mainAgent`, `workflowLeaf`).
 */
export function shippedCallSiteModel(
  callSite: LLMCallSite,
): string | undefined {
  return CALL_SITE_DEFAULTS[callSite]?.model;
}

/** Every alias the catalog knows about, including config-local overrides. */
export function knownAliases(llm: LLMConfig): string[] {
  return availableAliases(llm);
}

/** Catalog entry for an alias, with config-local overrides applied. */
export function effectiveCatalogEntry(
  llm: LLMConfig,
  alias: string,
): {
  alias: string;
  maxInputTokens?: number;
  maxOutputTokens?: number;
  supportsVision: boolean;
  supportsTools: boolean;
  supportsReasoning?: boolean;
} | null {
  const entry = getCatalogEntry(alias);
  const override = llm.catalogOverrides?.[alias];
  if (entry == null && override == null) {
    return null;
  }
  const supportsReasoning =
    override?.supportsReasoning ?? entry?.supportsReasoning;
  return {
    alias,
    maxInputTokens: override?.maxInputTokens ?? entry?.maxInputTokens,
    maxOutputTokens: override?.maxOutputTokens ?? entry?.maxOutputTokens,
    supportsVision: override?.supportsVision ?? entry?.supportsVision ?? false,
    supportsTools: override?.supportsTools ?? entry?.supportsTools ?? false,
    ...(supportsReasoning != null ? { supportsReasoning } : {}),
  };
}

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return (
    typeof value === "object" &&
    value !== null &&
    !Array.isArray(value) &&
    Object.getPrototypeOf(value) === Object.prototype
  );
}

function deepMerge(
  ...sources: (Record<string, unknown> | undefined)[]
): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const source of sources) {
    if (source == null) {
      continue;
    }
    for (const [key, value] of Object.entries(source)) {
      if (value === undefined) {
        continue;
      }
      const existing = out[key];
      out[key] = isPlainObject(value)
        ? deepMerge(isPlainObject(existing) ? existing : {}, value)
        : value;
    }
  }
  return out;
}
