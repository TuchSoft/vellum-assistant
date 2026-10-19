/**
 * Route definitions for model configuration, embedding configuration,
 * conversation search, message content, LLM
 * context inspection, and queued message deletion.
 *
 * GET    /v1/model                      — current model info
 * PUT    /v1/model/image-gen            — set image-gen model
 * GET    /v1/config/embeddings          — current embedding config
 * PUT    /v1/config/embeddings          - set embedding provider/model/baseUrl
 * GET    /v1/config                     — full raw workspace config
 * PATCH  /v1/config                     — deep-merge partial config
 * PUT    /v1/config/llm/profiles/:name  — replace an inference profile
 * GET    /v1/conversations/search       — search conversations
 * GET    /v1/messages/:id/content       — full message content
 * GET    /v1/messages/:id/llm-context   — LLM request logs for a message
 * GET    /v1/llm-request-logs/:id/payload — raw payload for a single log
 * GET    /v1/llm-request-logs/:id/context — normalized context for a single log
 * DELETE /v1/messages/queued/:id        — delete queued message
 * POST   /v1/messages/queued/:id/steer — steer to a queued message
 */

import { z } from "zod";

import { LlmContextResponseSchema } from "../../api/responses/llm-context-response.js";
import {
  type LatencyBreakdown,
  LatencyBreakdownSchema,
  LLMRequestLogEntrySchema,
} from "../../api/responses/llm-request-log-entry.js";
import { scrubNulledAcpAgentLeaves } from "../../config/acp-agent-write.js";
import {
  ChatSettingsPatchSchema,
  scrubNulledChatSettings,
  validateChatSettingsWrite,
} from "../../config/chat-settings.js";
import {
  deepMergeOverwrite,
  fillContextDefaultsForMissingKeys,
  getConfig,
  getDeploymentContextDefaults,
  invalidateConfigCache,
  loadRawConfig,
  saveRawConfig,
  setNestedValue,
  withSuppressedConfigDiskWrites,
  withSuppressedConfigDiskWritesSync,
} from "../../config/loader.js";
import { AssistantConfigSchema } from "../../config/schema.js";
import { getSchemaAtPath } from "../../config/schema-utils.js";
import { AutoArchiveConfigSchema } from "../../config/schemas/conversations.js";
import { LLMCallSiteConfig } from "../../config/schemas/llm.js";
import { VALID_MEMORY_EMBEDDING_PROVIDERS } from "../../config/schemas/memory-storage.js";
import { NotificationsConfigSchema } from "../../config/schemas/notifications.js";
import { ServiceModeSchema } from "../../config/schemas/services.js";
import { isSidebarDoneEnabled } from "../../config/sidebar-done-gate.js";
import { getConfigWatcher } from "../../daemon/config-watcher.js";
import {
  getEmbeddingConfigInfo,
  setEmbeddingConfig,
} from "../../daemon/handlers/config-embeddings.js";
import { dropTunnelRecordsForNewUrl } from "../../daemon/handlers/config-ingress.js";
import {
  getModelInfo,
  type ModelSetContext,
  setImageGenModel,
} from "../../daemon/handlers/config-model.js";
import {
  getMessageContent,
  performConversationSearch,
} from "../../daemon/handlers/conversation-history.js";
import {
  deleteQueuedMessage,
  steerToMessage,
} from "../../daemon/handlers/conversations.js";
import {
  CONFIG_RELOAD_DEBOUNCE_MS,
  log,
} from "../../daemon/handlers/shared.js";
import { rescheduleHeartbeatIfTimezoneChanged } from "../../heartbeat/heartbeat-service.js";
import { overlayWorkspaceMcpForConfigRead } from "../../mcp/workspace-mcp-config.js";
import {
  getAssistantMessageIdsInTurn,
  getConversation,
  getMessageById,
} from "../../persistence/conversation-crud.js";
import { getConversationByKey } from "../../persistence/conversation-key-store.js";
import {
  type ConversationKind,
  resolveConversationKind,
} from "../../persistence/conversation-types.js";
import { clearEmbeddingBackendCache } from "../../persistence/embeddings/embedding-backend.js";
import { resolveOpenAICompatibleBaseUrl } from "../../persistence/embeddings/embedding-openai.js";
import { getLlmRequestLogSource } from "../../persistence/llm-request-log-source.js";
import { type LogRow } from "../../persistence/llm-request-log-store.js";
import { getMemoryRecallLogByMessageIds } from "../../plugins/defaults/memory/memory-recall-log-store.js";
import { getMemoryV3SelectionForInspectorByMessageIds } from "../../plugins/defaults/memory/v3/selection-log-store.js";
import {} from "../../providers/inference/connections.js";
import { initializeProviders } from "../../providers/registry.js";
import { validateAllowlistFile } from "../../security/secret-allowlist.js";
import { extractReportedCostUsd } from "../../usage/pricing.js";
import {
  resolvePricingForUsage,
  usesAnthropicPricingRules,
} from "../../util/pricing.js";
import { resolveActorPrincipalIdForLocalGuardian } from "../local-actor-identity.js";
import { publishConfigChanged } from "../sync/resource-sync-events.js";
import {
  BadRequestError,
  ForbiddenError,
  InternalError,
  NotFoundError,
} from "./errors.js";
import {
  type LlmContextSummary,
  normalizeLlmContextPayloads,
} from "./llm-context-normalization.js";
import { assertLlmRequestLoggingEnabled } from "./llm-request-logs-access.js";
import type { RouteDefinition, RouteHandlerArgs } from "./types.js";

const validEmbeddingProviderSet = new Set<string>(
  VALID_MEMORY_EMBEDDING_PROVIDERS,
);

type LlmContextNormalizationResult = ReturnType<
  typeof normalizeLlmContextPayloads
>;

type LlmContextSummaryResponse = NonNullable<
  Omit<NonNullable<LlmContextNormalizationResult["summary"]>, "provider">
> & {
  provider: string;
};

type LlmContextRouteResult = Omit<LlmContextNormalizationResult, "summary"> & {
  summary?: LlmContextSummaryResponse;
};

import { ACTOR_PRINCIPALS } from "../auth/route-policy.js";

function attachEstimatedCost(
  summary: LlmContextSummary,
  responsePayload?: unknown,
): LlmContextSummary {
  // A cost the provider reported for this request is authoritative, so it
  // supersedes the token-based estimate and is used even when token counts
  // are absent from the summary.
  if (responsePayload !== undefined) {
    const reportedCostUsd = extractReportedCostUsd(responsePayload);
    if (reportedCostUsd !== null) {
      return { ...summary, estimatedCostUsd: reportedCostUsd };
    }
  }

  const { provider, model, inputTokens, outputTokens } = summary;
  if (!model || inputTokens == null || outputTokens == null) {
    return summary;
  }

  const cacheCreation = summary.cacheCreationInputTokens ?? 0;
  const cacheRead = summary.cacheReadInputTokens ?? 0;
  // `inputTokens` carries provider-shape-dependent cache accounting. Anthropic
  // Messages responses (native and OpenRouter `anthropic/*`) report `input_tokens`
  // already net of cache — cache-creation/read are separate, additive buckets —
  // so the full-rate portion IS `inputTokens`. OpenAI/Gemini report a total
  // prompt-token count with cached tokens as a subset, so the full-rate portion
  // is the total minus cache. `usesAnthropicPricingRules` selects the same
  // response shapes the pricing layer treats as Anthropic (keyed on the stored
  // transport provider + model), so it also distinguishes the cache accounting.
  const directInputTokens = usesAnthropicPricingRules(provider, model)
    ? Math.max(inputTokens, 0)
    : Math.max(inputTokens - cacheCreation - cacheRead, 0);

  const result = resolvePricingForUsage(provider, model, {
    directInputTokens,
    outputTokens,
    cacheCreationInputTokens: cacheCreation,
    cacheReadInputTokens: cacheRead,
    anthropicCacheCreation: null,
  });

  return { ...summary, estimatedCostUsd: result.estimatedCostUsd };
}

function applyStoredProviderToLlmContextResult(
  normalized: LlmContextNormalizationResult,
  provider: string | null,
  responsePayload?: unknown,
): LlmContextRouteResult {
  if (!provider) {
    const summary = normalized.summary
      ? attachEstimatedCost(normalized.summary, responsePayload)
      : undefined;
    return { ...normalized, summary } as LlmContextRouteResult;
  }

  const mergedSummary = normalized.summary
    ? { ...normalized.summary, provider }
    : { provider };
  const summary = attachEstimatedCost(
    mergedSummary as LlmContextSummary,
    responsePayload,
  );
  return { ...normalized, summary };
}

/**
 * `full` returns the complete normalized entry including request/response
 * sections; `summary` omits the sections so list responses stay small —
 * sections for a single call are fetched lazily through
 * `/v1/llm-request-logs/{logId}/context`.
 */
type LlmContextView = "full" | "summary";

function resolveLlmContextView(view: string | undefined): LlmContextView {
  if (view === undefined || view === "full") {
    return "full";
  }
  if (view === "summary") {
    return "summary";
  }
  throw new BadRequestError(
    `Invalid view parameter: ${view}. Expected "full" or "summary".`,
  );
}

/**
 * Parse the stored `latency_breakdown` JSON into a validated
 * {@link LatencyBreakdown}. Returns `null` for the common no-data case and
 * for malformed/legacy rows — a bad blob must never break the inspector.
 */
function parseLatencyBreakdown(raw: string | null): LatencyBreakdown | null {
  if (!raw) {
    return null;
  }
  try {
    const parsed = LatencyBreakdownSchema.safeParse(JSON.parse(raw));
    return parsed.success ? parsed.data : null;
  } catch {
    return null;
  }
}

function normalizeLlmContextLog(
  log: LogRow,
  view: LlmContextView = "full",
): LlmContextRouteResult & {
  id: string;
  requestPayload: null;
  responsePayload: null;
  createdAt: number;
  agentLoopExitReason: string | null;
  callSite: string | null;
  latency: LatencyBreakdown | null;
} {
  let requestPayload: unknown;
  try {
    requestPayload = JSON.parse(log.requestPayload);
  } catch {
    requestPayload = log.requestPayload;
  }
  let responsePayload: unknown;
  try {
    responsePayload = JSON.parse(log.responsePayload);
  } catch {
    responsePayload = log.responsePayload;
  }
  const normalized = normalizeLlmContextPayloads({
    requestPayload,
    responsePayload,
    createdAt: log.createdAt,
  });
  const result = applyStoredProviderToLlmContextResult(
    normalized,
    log.provider,
    responsePayload,
  );
  return {
    id: log.id,
    requestPayload: null,
    responsePayload: null,
    createdAt: log.createdAt,
    // Agent-loop exit reason for the iteration that produced this call,
    // stamped onto the most-recent unstamped log by
    // `conversation-agent-loop-handlers.ts` after the loop yields. Only the
    // terminal call in each loop iteration carries a value; non-terminal calls
    // land here as `null`.
    agentLoopExitReason: log.agentLoopExitReason ?? null,
    // Logical call site (`mainAgent`, `compactionAgent`,
    // `syntheticAgentErrorMessage`, …). Exposed to the inspector so synthetic
    // rows can be rendered distinctly without re-deriving the kind from
    // other fields — the frontend branches on this value alone, and the
    // existing `agent_loop_exit_reason` column tells it WHICH error fired.
    callSite: log.callSite ?? null,
    // Daemon-measured first-token latency waterfall, stamped on the row at
    // record time (like `callSite`) rather than derived from the payloads.
    latency: parseLatencyBreakdown(log.latencyBreakdown),
    ...result,
    ...(view === "summary"
      ? { requestSections: undefined, responseSections: undefined }
      : {}),
  };
}

// ---------------------------------------------------------------------------
// Model set context — derived directly from the config watcher singleton
// ---------------------------------------------------------------------------

function getModelSetContext(): ModelSetContext {
  const watcher = getConfigWatcher();
  return {
    suppressConfigReload: watcher.suppressConfigReload,
    setSuppressConfigReload(value: boolean) {
      watcher.suppressConfigReload = value;
    },
    updateConfigFingerprint() {
      withSuppressedConfigDiskWritesSync(() => watcher.updateFingerprint());
    },
    debounceTimers: watcher.timers,
  };
}

// ---------------------------------------------------------------------------
// Handlers
// ---------------------------------------------------------------------------

async function handleGetModel() {
  return getModelInfo();
}

async function handleSetImageGenModel({ body }: RouteHandlerArgs) {
  if (!body || typeof body !== "object") {
    throw new BadRequestError("Request body is required");
  }
  const { modelId } = body as { modelId?: string };
  if (!modelId || typeof modelId !== "string") {
    throw new BadRequestError("Missing required field: modelId");
  }
  try {
    setImageGenModel(modelId, getModelSetContext());
    return { ok: true };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    throw new InternalError(`Failed to set image gen model: ${message}`);
  }
}

async function handleGetEmbeddingConfig() {
  return getEmbeddingConfigInfo();
}

async function handleSetEmbeddingConfig({ body }: RouteHandlerArgs) {
  if (!body || typeof body !== "object") {
    throw new BadRequestError("Request body is required");
  }
  const { provider, model, baseUrl, dimensions } = body as {
    provider?: string;
    model?: string;
    baseUrl?: string;
    dimensions?: number | null;
  };
  if (!provider || typeof provider !== "string") {
    throw new BadRequestError("Missing required field: provider");
  }
  if (!validEmbeddingProviderSet.has(provider)) {
    throw new BadRequestError(
      `Invalid provider "${provider}". Valid providers: ${[...validEmbeddingProviderSet].join(", ")}`,
    );
  }
  if (model !== undefined && typeof model !== "string") {
    throw new BadRequestError("Field 'model' must be a string");
  }
  if (baseUrl !== undefined && typeof baseUrl !== "string") {
    throw new BadRequestError("Field 'baseUrl' must be a string");
  }
  if (
    typeof baseUrl === "string" &&
    baseUrl !== "" &&
    !resolveOpenAICompatibleBaseUrl(baseUrl)
  ) {
    throw new BadRequestError("Field 'baseUrl' must be an http(s) URL");
  }
  if (
    dimensions !== undefined &&
    dimensions !== null &&
    (typeof dimensions !== "number" ||
      !Number.isInteger(dimensions) ||
      dimensions <= 0)
  ) {
    throw new BadRequestError(
      "Field 'dimensions' must be a positive integer or null",
    );
  }
  try {
    return await setEmbeddingConfig(provider, model, getModelSetContext(), {
      baseUrl,
      dimensions,
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    throw new InternalError(`Failed to set embedding config: ${message}`);
  }
}

/**
 * Apply deployment-context defaults to a raw config payload before it goes
 * out over the wire from `GET /v1/config`. The in-memory `loadConfig()`
 * already layers these defaults for daemon-internal consumers; the GET
 * response needs the same treatment so external clients (macOS, web, CLI)
 * see the effective value rather than `undefined` when the daemon hasn't
 * persisted an explicit choice yet. For example, on a freshly-hatched
 * platform-managed assistant, `services.image-generation.provider` may be
 * absent from disk (only `llm.profiles` was written by
 * `seedInferenceProfiles`); the fill pass ensures clients receive `"vellum"`
 * rather than falling back to their own defaults.
 *
 * Guards against `loadRawConfig()` handing us a value that is technically
 * valid JSON but not a plain object (e.g. literal `null`, a number, or an
 * array). `loadRawConfig` is typed `Record<string, unknown>` but `JSON.parse`
 * itself doesn't enforce that — a malformed-but-parseable `config.json`
 * would blow up `fillContextDefaultsForMissingKeys` on its `target[key]` /
 * `fileConfig[key]` accesses, turning `GET /v1/config` into a 500 where it
 * used to succeed (returning the malformed payload as-is). When `raw` is
 * not a plain object, we return it unchanged.
 *
 * Exported for direct unit testing.
 */
export function applyContextDefaultsToRawConfig(raw: unknown): unknown {
  const contextDefaults = getDeploymentContextDefaults();
  if (
    Object.keys(contextDefaults).length === 0 ||
    raw === null ||
    typeof raw !== "object" ||
    Array.isArray(raw)
  ) {
    return raw;
  }
  fillContextDefaultsForMissingKeys(
    raw as Record<string, unknown>,
    raw as Record<string, unknown>,
    contextDefaults,
  );
  synthesizeLegacyInferenceModeForPlatform(raw as Record<string, unknown>);
  return raw;
}

/**
 * Backwards-compat wire field for `GET /v1/config`. PR removed
 * `services.inference.mode` from the typed schema (routing is governed by
 * `provider_connections` rows + per-profile `provider_connection`), but
 * the macOS settings client (`SettingsStore.swift:loadServiceModes`) still
 * reads this field and falls back to its `@Published` default of "your-own"
 * when absent. On a platform-managed assistant served by a newer daemon and
 * an older macOS client, that fallback would show the wrong mode in the UI
 * until the user explicitly saved. Synthesize the value here so the wire
 * shape stays compatible during the rollout window. Remove once the macOS
 * Providers UI (the follow-up PR that retires this field on the client) has
 * shipped to the majority of installs.
 *
 * The synthesis is wire-only: it never persists to disk and never reaches
 * the typed `AssistantConfig` consumed by daemon-internal code. The on-disk
 * config is stripped of `mode` by workspace migration 076.
 *
 * Only runs when this function is reached, which is guarded by
 * `getDeploymentContextDefaults()` returning non-empty (IS_PLATFORM=true).
 */
function synthesizeLegacyInferenceModeForPlatform(
  root: Record<string, unknown>,
): void {
  const services = readPlainObject(root.services);
  if (!services) {
    return;
  }
  let inference = readPlainObject(services.inference);
  if (!inference) {
    inference = {};
    services.inference = inference;
  }
  if (inference.mode === undefined) {
    inference.mode = "managed";
  }
}

function readPlainObject(value: unknown): Record<string, unknown> | undefined {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    return undefined;
  }
  return value as Record<string, unknown>;
}

function stripTransportHeadersRecursively(value: unknown): void {
  if (Array.isArray(value)) {
    for (const item of value) {
      stripTransportHeadersRecursively(item);
    }
    return;
  }

  const object = readPlainObject(value);
  if (!object) {
    return;
  }
  const transport = readPlainObject(object.transport);
  if (transport) {
    delete transport.headers;
  }
  for (const child of Object.values(object)) {
    stripTransportHeadersRecursively(child);
  }
}

function containsTransportHeadersRecursively(value: unknown): boolean {
  if (Array.isArray(value)) {
    return value.some((item) => containsTransportHeadersRecursively(item));
  }

  const object = readPlainObject(value);
  if (!object) {
    return false;
  }
  const transport = readPlainObject(object.transport);
  if (transport && Object.hasOwn(transport, "headers")) {
    return true;
  }
  return Object.values(object).some((child) =>
    containsTransportHeadersRecursively(child),
  );
}

function sanitizeMcpTransportHeadersForSettingsRead(config: unknown): void {
  const root = readPlainObject(config);
  if (!root) {
    return;
  }
  const mcp = readPlainObject(root.mcp);
  if (!mcp || !Object.hasOwn(mcp, "servers")) {
    return;
  }
  if (Array.isArray(mcp.servers)) {
    stripTransportHeadersRecursively(mcp.servers);
    return;
  }
  const servers = readPlainObject(mcp.servers);
  if (!servers) {
    return;
  }
  for (const server of Object.values(servers)) {
    stripTransportHeadersRecursively(server);
  }
}

function patchContainsMcpTransportHeaders(patch: unknown): boolean {
  const root = readPlainObject(patch);
  const mcp = readPlainObject(root?.mcp);
  if (!mcp || !Object.hasOwn(mcp, "servers")) {
    return false;
  }
  if (Array.isArray(mcp.servers)) {
    return containsTransportHeadersRecursively(mcp.servers);
  }
  const servers = readPlainObject(mcp.servers);
  if (!servers) {
    return false;
  }
  return Object.values(servers).some((server) =>
    containsTransportHeadersRecursively(server),
  );
}

function rejectMcpTransportHeaderWrite(patch: unknown): void {
  if (!patchContainsMcpTransportHeaders(patch)) {
    return;
  }
  throw new BadRequestError(
    "MCP authentication headers must be managed through MCP server add/update APIs, not generic config writes.",
  );
}

const MCP_CONFIG_WRITE_MESSAGE =
  "MCP servers are stored in mcp.json. Use assistant mcp add or assistant mcp remove.";

function stripMcpFromConfigWrite(patch: Record<string, unknown>): void {
  if (Object.hasOwn(patch, "mcp")) {
    delete patch.mcp;
  }
}

function rejectMcpConfigSetPath(path: string, value: unknown): void {
  if (path !== "mcp" && !path.startsWith("mcp.")) {
    return;
  }
  const relative =
    path === "mcp" ? value : nestPath(path.slice("mcp.".length), value);
  if (patchContainsMcpTransportHeaders({ mcp: relative })) {
    throw new BadRequestError(
      "MCP authentication headers must be managed through MCP server add/update APIs, not generic config writes.",
    );
  }
  throw new BadRequestError(MCP_CONFIG_WRITE_MESSAGE);
}

function nestPath(path: string, value: unknown): unknown {
  const segments = path.split(".");
  let current: unknown = value;
  for (let i = segments.length - 1; i >= 0; i--) {
    current = { [segments[i]!]: current };
  }
  return current;
}

/**
 * Wire shape of the `memory` section in config responses. Passthrough
 * preserves fields beyond `enabled` so the client doesn't strip unrecognised
 * memory config that newer daemons may add.
 */
const MemoryWireConfigSchema = z
  .object({
    enabled: z.boolean().optional(),
  })
  .passthrough()
  .meta({ id: "MemoryConfig" });

/**
 * Response schema for `GET /v1/config`.
 *
 * Describes the wire shape of the raw `settings.json` response after
 * context-default filling and vision-flag enrichment. Chat settings include
 * effective defaults. Fields remain optional for older assistants and sparse
 * on-disk config. Additional top-level sections are preserved via
 * passthrough. This schema types the fields that web/macOS clients consume
 * without restricting the full config surface.
 */
const ConfigGetResponseSchema = z
  .object({
    conversations: z
      .object({ autoArchive: AutoArchiveConfigSchema.passthrough() })
      .passthrough()
      .optional(),
    notifications: NotificationsConfigSchema.passthrough().optional(),
    llm: z
      .object({
        defaultModel: z.string().optional(),
        callSites: z
          .record(z.string(), LLMCallSiteConfig.nullable())
          .optional(),
        streamThinking: z.boolean().optional(),
        catalogOverrides: z.record(z.string(), z.unknown()).optional(),
      })
      .passthrough()
      .optional(),
    memory: MemoryWireConfigSchema.optional(),
    services: z
      .object({
        "web-search": z
          .object({
            provider: z.string().optional(),
          })
          .passthrough()
          .optional(),
        "web-fetch": z
          .object({
            provider: z.string().optional(),
          })
          .passthrough()
          .optional(),
        "image-generation": z
          .object({
            provider: z.string().optional(),
            model: z.string().optional(),
          })
          .passthrough()
          .optional(),
        inference: z
          .object({ mode: ServiceModeSchema.optional() })
          .passthrough()
          .optional(),
      })
      .passthrough()
      .optional(),
  })
  .passthrough()
  .meta({ id: "ConfigGetResponse" });

/**
 * Request body schema for `PATCH /v1/config`.
 *
 * Mirrors the response shape but every field is `.nullable().optional()`:
 * omitted keys are left unchanged by the daemon's deep-merge, `null` values
 * delete the key. Uses the same Zod enums as `ConfigGetResponseSchema` so
 * the generated SDK produces literal-union types — no hand-written patch
 * types needed downstream.
 */
const ConfigPatchRequestSchema = z
  .object({
    ...ChatSettingsPatchSchema.shape,
    llm: z
      .object({
        defaultModel: z.string().nullable().optional(),
        callSites: z
          .record(z.string(), LLMCallSiteConfig.nullable())
          .nullable()
          .optional(),
        streamThinking: z.boolean().nullable().optional(),
        catalogOverrides: z
          .record(z.string(), z.unknown())
          .nullable()
          .optional(),
      })
      .passthrough()
      .optional(),
    memory: MemoryWireConfigSchema.nullable().optional(),
    services: z
      .object({
        "web-search": z
          .object({
            provider: z.string().optional(),
          })
          .passthrough()
          .nullable()
          .optional(),
        "web-fetch": z
          .object({
            provider: z.string().optional(),
          })
          .passthrough()
          .nullable()
          .optional(),
        "image-generation": z
          .object({
            provider: z.string().optional(),
            model: z.string().optional(),
          })
          .passthrough()
          .nullable()
          .optional(),
        inference: z
          .object({ mode: ServiceModeSchema.optional() })
          .passthrough()
          .nullable()
          .optional(),
      })
      .passthrough()
      .optional(),
  })
  .passthrough()
  .meta({ id: "ConfigPatchRequest" });

function handleGetConfig() {
  try {
    const config = applyContextDefaultsToRawConfig(loadRawConfig());
    overlayWorkspaceMcpForConfigRead(config);
    sanitizeMcpTransportHeadersForSettingsRead(config);
    overlayChatSettingsForWire(config);
    return config;
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    throw new InternalError(`Failed to read config: ${message}`);
  }
}

function overlayChatSettingsForWire(config: unknown): void {
  const root = readPlainObject(config);
  if (!root) {
    return;
  }
  const effective = getConfig();
  const conversations = readPlainObject(root.conversations);
  root.conversations = {
    ...conversations,
    autoArchive: {
      ...readPlainObject(conversations?.autoArchive),
      ...effective.conversations.autoArchive,
    },
  };
  root.notifications = {
    ...readPlainObject(root.notifications),
    newMessageEnabled: effective.notifications.newMessageEnabled,
  };
}

/**
 * Return the JSON Schema for the assistant config (full or scoped).
 *
 * The schema is derived from `AssistantConfigSchema` at runtime via
 * `z.toJSONSchema()`. Pure read; no daemon state involved.
 */
function handleGetConfigSchema({ queryParams = {} }: RouteHandlerArgs) {
  const rawPath = queryParams.path;
  const path = typeof rawPath === "string" ? rawPath.trim() : "";

  if (!path) {
    return {
      schema: z.toJSONSchema(AssistantConfigSchema, {
        unrepresentable: "any",
        io: "input",
      }),
    };
  }

  const subSchema = getSchemaAtPath(AssistantConfigSchema, path);
  if (!subSchema) {
    throw new BadRequestError(`No schema found at path: ${path}`);
  }

  return {
    schema: z.toJSONSchema(subSchema, {
      unrepresentable: "any",
      io: "input",
    }),
  };
}

export async function commitConfigWrite(
  raw: Record<string, unknown>,
  opLabel: string,
): Promise<void> {
  const preWrite = loadRawConfig();
  const chatSettings = validateChatSettingsWrite(preWrite, raw);
  if (!chatSettings.success) {
    throw new BadRequestError(chatSettings.error.message);
  }

  const configWatcher = getConfigWatcher();
  const wasSuppressed = configWatcher.suppressConfigReload;
  configWatcher.suppressConfigReload = true;
  try {
    saveRawConfig(raw);
  } catch (err) {
    configWatcher.suppressConfigReload = wasSuppressed;
    const message = err instanceof Error ? err.message : String(err);
    throw new InternalError(`Failed to ${opLabel} config: ${message}`);
  }
  configWatcher.timers.schedule(
    "__suppress_reset__",
    () => {
      configWatcher.suppressConfigReload = false;
    },
    CONFIG_RELOAD_DEBOUNCE_MS,
  );

  clearEmbeddingBackendCache();
  invalidateConfigCache();
  rescheduleHeartbeatIfTimezoneChanged(preWrite, raw);
  try {
    await withSuppressedConfigDiskWrites(async () => {
      await initializeProviders(getConfig());
      configWatcher.updateFingerprint();
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    log.error({ err }, `${opLabel} config: provider reinit failed: ${message}`);
  }

  publishConfigChanged();
}

/**
 * Web clients pair provider writes with a legacy `mode` key so their saves
 * stay valid on daemons whose schemas still carry it. Scrub it so the removed
 * field cannot be resurrected on disk.
 */
function scrubRemovedServiceModes(raw: Record<string, unknown>): void {
  const services = raw.services as
    | Record<string, Record<string, unknown> | undefined>
    | undefined;
  if (!services) {
    return;
  }
  for (const key of ["web-search", "image-generation"]) {
    const entry = services[key];
    if (entry && typeof entry === "object" && "mode" in entry) {
      delete entry.mode;
    }
  }
}

/**
 * A persisted `services.stt` block must carry a provider; fill it from the
 * effective config when a sparse patch creates the block without one.
 */
function seedSttProviderForSparseBlock(raw: Record<string, unknown>): void {
  const services = readPlainObject(raw.services);
  const stt = readPlainObject(services?.stt);
  if (!stt) {
    return;
  }
  const provider = stt.provider;
  if (typeof provider === "string" && provider.trim().length > 0) {
    return;
  }
  stt.provider = getConfig().services.stt.provider;
}

async function handlePatchConfig({ body }: RouteHandlerArgs) {
  if (
    !body ||
    typeof body !== "object" ||
    Array.isArray(body) ||
    Object.keys(body).length === 0
  ) {
    throw new BadRequestError("Body must be a non-empty JSON object");
  }
  const chatSettings = ChatSettingsPatchSchema.safeParse(body);
  if (!chatSettings.success) {
    throw new BadRequestError(chatSettings.error.message);
  }
  rejectMcpTransportHeaderWrite(body);
  stripMcpFromConfigWrite(body as Record<string, unknown>);

  const raw = loadRawConfig();
  const patch = body as Record<string, unknown>;
  const patchedIngressUrl = readPlainObject(patch.ingress)?.publicBaseUrl;
  if (patchedIngressUrl !== undefined) {
    dropTunnelRecordsForNewUrl(readPlainObject(raw.ingress), patchedIngressUrl);
  }
  deepMergeOverwrite(raw, patch);
  scrubRemovedServiceModes(raw);
  scrubNulledAcpAgentLeaves(raw);
  scrubNulledChatSettings(raw, patch);
  seedSttProviderForSparseBlock(raw);

  await commitConfigWrite(raw, "patch");

  return handleGetConfig();
}

/**
 * Direct path assignment - replaces `config_patch` for the `assistant
 * config set <key> <value>` CLI path.
 *
 * `config_patch` uses `deepMergeOverwrite` semantics, which strips `null`
 * leaves when the target subtree doesn't exist and merges (rather than
 * replaces) object subtrees. That's correct for partial updates (embedding
 * config, profile patches) but breaks single-key `set` semantics, where the
 * user expects:
 *   - `set heartbeat.activeHoursStart null` to persist explicit `null`
 *   - `set llm {}` to replace `llm`, not merge into it
 *
 * `config_set` performs `setNestedValue` directly on the loaded raw config
 * (no merge), then runs the same post-write side effects as patch.
 */
async function handleSetConfig({ body }: RouteHandlerArgs) {
  if (!body || typeof body !== "object" || Array.isArray(body)) {
    throw new BadRequestError(
      "Body must be a JSON object with `path` and `value`",
    );
  }
  const bodyRecord = body as Record<string, unknown>;
  const { path, value } = bodyRecord as { path?: unknown; value?: unknown };
  if (typeof path !== "string" || path.length === 0) {
    throw new BadRequestError("`path` must be a non-empty string");
  }
  // `value` must be present (use explicit `null` to clear a key). Without
  // this check, `undefined` flows into `setNestedValue` and gets dropped by
  // `JSON.stringify` at save time, silently removing the key - which is
  // distinct from the documented "set to null" semantics.
  if (!("value" in bodyRecord)) {
    throw new BadRequestError(
      "`value` is required (use `null` to clear a key)",
    );
  }
  const patchShape: Record<string, unknown> = {};
  setNestedValue(patchShape, path, value);
  rejectMcpConfigSetPath(path, value);
  rejectMcpTransportHeaderWrite(patchShape);

  const raw = loadRawConfig();
  // `assistant config set ingress.publicBaseUrl <url>`, what the webhook
  // diagnostics tell users to run, retargets ingress like the settings route.
  if (path === "ingress.publicBaseUrl") {
    dropTunnelRecordsForNewUrl(readPlainObject(raw.ingress), value);
  }
  setNestedValue(raw, path, value);
  scrubNulledAcpAgentLeaves(raw);
  // A SET can create `services.stt` with a leaf like `language` and no
  // `provider`, which SttServiceSchema requires whenever the block exists;
  // the same seeding that guards PATCH keeps this write's persisted block
  // schema-valid.
  seedSttProviderForSparseBlock(raw);

  await commitConfigWrite(raw, "set");
  return { ok: true };
}

/**
 * Validate the regex patterns inside the workspace's
 * `secret-allowlist.json` file.
 *
 * Pure read: opens the file, attempts to compile each pattern, returns
 * structured errors. The handler returns `{ exists: false }` if the file is
 * absent, or `{ exists: true, errors: [...] }` otherwise.
 */
function handleValidateAllowlist() {
  try {
    const errors = validateAllowlistFile();
    if (errors == null) {
      return { exists: false } as const;
    }
    return { exists: true, errors } as const;
  } catch (err) {
    // `validateAllowlistFile` does a raw `JSON.parse` on
    // `secret-allowlist.json` and can throw on malformed JSON. Surface
    // that as a structured `parseError` in the response payload instead
    // of letting it propagate as a 500. Preserves the pre-IPC CLI
    // behavior, which printed a user-readable failure and exited 1.
    const message = err instanceof Error ? err.message : String(err);
    return { exists: true, parseError: message, errors: [] } as const;
  }
}

async function handleSearchConversations({
  queryParams = {},
}: RouteHandlerArgs) {
  const q = queryParams.q;
  if (!q) {
    throw new BadRequestError("Missing required query parameter: q");
  }
  const limit = queryParams.limit ? Number(queryParams.limit) : undefined;
  const maxMessages = queryParams.maxMessagesPerConversation
    ? Number(queryParams.maxMessagesPerConversation)
    : undefined;
  const results = await performConversationSearch({
    query: q,
    limit,
    maxMessagesPerConversation: maxMessages,
    // Under `sidebar-done` a done chat is filed rather than hidden, so the
    // agent's own history search reaches it the same way the user's does.
    includeArchived: isSidebarDoneEnabled(),
  });
  return { query: q, results };
}

function handleGetMessageContent({
  queryParams = {},
  pathParams = {},
}: RouteHandlerArgs) {
  const conversationId = queryParams.conversationId;
  const result = getMessageContent(
    pathParams.id ?? "",
    conversationId ?? undefined,
  );
  if (!result) {
    throw new NotFoundError(`Message ${pathParams.id} not found`);
  }
  return result;
}

async function handleGetLlmContext({
  pathParams = {},
  queryParams = {},
}: RouteHandlerArgs) {
  assertLlmRequestLoggingEnabled();
  const messageId = pathParams.id;
  if (!messageId) {
    throw new BadRequestError("message id is required");
  }
  const view = resolveLlmContextView(queryParams.view);
  const source = await getLlmRequestLogSource();
  const logs = await source.getRequestLogsByMessageId(messageId);
  const turnMessageIds = await getAssistantMessageIdsInTurn(messageId);
  const memoryRecallLog = await getMemoryRecallLogByMessageIds(turnMessageIds);
  const message = await getMessageById(messageId);
  const conversation = message
    ? await getConversation(message.conversationId)
    : null;
  const conversationKind: ConversationKind = conversation
    ? resolveConversationKind(
        conversation.source,
        conversation.conversationType,
      )
    : "user";
  // Running total of estimated USD cost across every priced LLM call in
  // the conversation. Maintained by `updateConversationUsage` whenever a
  // turn finishes — see `assistant/src/memory/conversation-crud.ts`.
  const conversationTotalEstimatedCostUsd =
    conversation?.totalEstimatedCost ?? null;
  // v3 selections are keyed to the turn's message ids (stamped by the
  // turn-end backfill), so the panel shows whenever the turn has v3 data.
  const memoryV3Selection =
    await getMemoryV3SelectionForInspectorByMessageIds(turnMessageIds);
  return {
    messageId,
    conversationKind,
    conversationTotalEstimatedCostUsd,
    logs: logs.map((log) => normalizeLlmContextLog(log, view)),
    memoryRecall: memoryRecallLog ?? null,
    memoryV3Selection,
  };
}

async function handleGetConversationLlmContext({
  queryParams = {},
}: RouteHandlerArgs) {
  assertLlmRequestLoggingEnabled();
  const conversationKey = queryParams.conversationKey;
  const requestedConversationId = queryParams.conversationId;
  const view = resolveLlmContextView(queryParams.view);

  let conversationId: string | undefined = requestedConversationId;
  if (!conversationId && conversationKey) {
    const mapping = await getConversationByKey(conversationKey);
    conversationId = mapping?.conversationId;
  }

  if (!conversationId) {
    if (conversationKey) {
      return {
        conversationKey,
        conversationId: null,
        conversationKind: "user",
        conversationTotalEstimatedCostUsd: null,
        logs: [],
        memoryRecall: null,
        memoryV3Selection: null,
      };
    }
    throw new BadRequestError(
      "conversationKey or conversationId query parameter is required",
    );
  }

  const conversation = await getConversation(conversationId);
  if (!conversation) {
    if (conversationKey) {
      return {
        conversationKey,
        conversationId,
        conversationKind: "user",
        conversationTotalEstimatedCostUsd: null,
        logs: [],
        memoryRecall: null,
        memoryV3Selection: null,
      };
    }
    throw new NotFoundError(`Conversation ${conversationId} not found`);
  }

  const source = await getLlmRequestLogSource();
  const logs = await source.getRequestLogsByConversationId(conversation.id);
  const conversationKind = resolveConversationKind(
    conversation.source,
    conversation.conversationType,
  );
  const conversationTotalEstimatedCostUsd =
    conversation.totalEstimatedCost ?? null;

  return {
    conversationKey: conversationKey ?? null,
    conversationId: conversation.id,
    conversationKind,
    conversationTotalEstimatedCostUsd,
    logs: logs.map((log) => normalizeLlmContextLog(log, view)),
    memoryRecall: null,
    memoryV3Selection: null,
  };
}

async function handleGetLlmRequestLogPayload({
  pathParams = {},
}: RouteHandlerArgs) {
  assertLlmRequestLoggingEnabled();
  const logId = pathParams.id;
  if (!logId) {
    throw new BadRequestError("log id is required");
  }
  const source = await getLlmRequestLogSource();
  const log = await source.getRequestLogById(logId);
  if (!log) {
    throw new NotFoundError("log not found");
  }
  let requestPayload: unknown;
  try {
    requestPayload = JSON.parse(log.requestPayload);
  } catch {
    requestPayload = log.requestPayload;
  }
  let responsePayload: unknown;
  try {
    responsePayload = JSON.parse(log.responsePayload);
  } catch {
    responsePayload = log.responsePayload;
  }
  return { id: log.id, requestPayload, responsePayload };
}

async function handleGetLlmRequestLogContext({
  pathParams = {},
}: RouteHandlerArgs) {
  assertLlmRequestLoggingEnabled();
  const logId = pathParams.id;
  if (!logId) {
    throw new BadRequestError("log id is required");
  }
  const source = await getLlmRequestLogSource();
  const log = await source.getRequestLogById(logId);
  if (!log) {
    throw new NotFoundError("log not found");
  }
  return normalizeLlmContextLog(log);
}

function resolveQueuedMessageConversationId({
  queryParams = {},
  body,
  headers = {},
}: RouteHandlerArgs): string | undefined {
  const bodyConversationId = body?.conversationId;
  const conversationId =
    queryParams.conversationId ??
    (typeof bodyConversationId === "string" ? bodyConversationId : undefined) ??
    headers["x-vellum-conversation-id"];
  return typeof conversationId === "string" && conversationId.length > 0
    ? conversationId
    : undefined;
}

async function handleDeleteQueuedMessage(args: RouteHandlerArgs) {
  const { pathParams = {}, headers = {} } = args;
  const conversationId = resolveQueuedMessageConversationId(args);
  if (!conversationId) {
    throw new BadRequestError("Missing required parameter: conversationId");
  }
  // Verified caller identity. Both adapters derive this header from the auth
  // context, never from a caller-supplied one. Normalize it exactly as the
  // send path does before comparing against the principal recorded at
  // enqueue, or the two disagree: `resolveActorPrincipalIdForLocalGuardian`
  // translates the synthetic `dev-bypass` principal to the real local
  // guardian under `DISABLE_HTTP_AUTH=true` (a no-op for real JWT
  // principals), and every sibling handler in this layer trims first.
  const actorPrincipalId = await resolveActorPrincipalIdForLocalGuardian(
    headers["x-vellum-actor-principal-id"]?.trim() || undefined,
  );
  const result = deleteQueuedMessage(conversationId, pathParams.id ?? "", {
    actorPrincipalId,
  });
  if (result.removed) {
    return { ok: true, conversationId, requestId: pathParams.id };
  }
  if (result.reason === "conversation_not_found") {
    throw new NotFoundError("Conversation not found");
  }
  if (result.reason === "forbidden") {
    throw new ForbiddenError(
      "Queued message was sent by a different user and cannot be cancelled here",
    );
  }
  throw new NotFoundError("Queued message not found");
}

async function handleSteerToMessage(args: RouteHandlerArgs) {
  const { pathParams = {}, headers = {} } = args;
  const conversationId = resolveQueuedMessageConversationId(args);
  if (!conversationId) {
    throw new BadRequestError("Missing required parameter: conversationId");
  }
  // Verified caller identity, normalized exactly as the delete path above
  // (see the comment in `handleDeleteQueuedMessage`).
  const actorPrincipalId = await resolveActorPrincipalIdForLocalGuardian(
    headers["x-vellum-actor-principal-id"]?.trim() || undefined,
  );
  const result = steerToMessage(conversationId, pathParams.id ?? "", {
    actorPrincipalId,
  });
  if (result.steered) {
    return { ok: true, conversationId, requestId: pathParams.id };
  }
  if (result.reason === "conversation_not_found") {
    throw new NotFoundError("Conversation not found");
  }
  if (result.reason === "not_processing") {
    throw new BadRequestError(
      "Cannot steer: conversation is not currently processing",
    );
  }
  if (result.reason === "forbidden") {
    throw new ForbiddenError(
      "Queued message was sent by a different user and cannot be steered to here",
    );
  }
  throw new NotFoundError("Queued message not found");
}

// ---------------------------------------------------------------------------
// Route definitions (shared HTTP + IPC)
// ---------------------------------------------------------------------------

export const ROUTES: RouteDefinition[] = [
  {
    operationId: "model_get",
    endpoint: "model",
    method: "GET",
    policy: {
      requiredScopes: ["settings.read"],
      allowedPrincipalTypes: ACTOR_PRINCIPALS,
    },
    summary: "Get current model config",
    description:
      "Return the active LLM model ID, provider, and available models.",
    tags: ["config"],
    handler: handleGetModel,
  },
  {
    operationId: "model_image_gen_set",
    endpoint: "model/image-gen",
    method: "PUT",
    policy: {
      requiredScopes: ["settings.write"],
      allowedPrincipalTypes: ACTOR_PRINCIPALS,
    },
    summary: "Set image generation model",
    description: "Change the active image generation model.",
    tags: ["config"],
    requestBody: z.object({ modelId: z.string() }),
    handler: handleSetImageGenModel,
  },
  {
    operationId: "config_embeddings_get",
    endpoint: "config/embeddings",
    method: "GET",
    policy: {
      requiredScopes: ["settings.read"],
      allowedPrincipalTypes: ACTOR_PRINCIPALS,
    },
    summary: "Get embedding config",
    description:
      "Return the active embedding provider, model, and available options.",
    tags: ["config"],
    handler: handleGetEmbeddingConfig,
  },
  {
    operationId: "config_embeddings_set",
    endpoint: "config/embeddings",
    method: "PUT",
    policy: {
      requiredScopes: ["settings.write"],
      allowedPrincipalTypes: ACTOR_PRINCIPALS,
    },
    summary: "Set embedding config",
    description:
      "Change the embedding provider, model, and optional custom endpoint.",
    tags: ["config"],
    requestBody: z.object({
      provider: z.string(),
      model: z.string().optional(),
      baseUrl: z.string().optional(),
      dimensions: z.number().int().positive().nullable().optional(),
    }),
    handler: handleSetEmbeddingConfig,
  },
  {
    operationId: "config_get",
    endpoint: "config",
    method: "GET",
    policy: {
      requiredScopes: ["settings.read"],
      allowedPrincipalTypes: ACTOR_PRINCIPALS,
    },
    summary: "Get full config",
    description: "Return the raw settings.json configuration object.",
    tags: ["config"],
    responseBody: ConfigGetResponseSchema,
    handler: handleGetConfig,
  },
  {
    operationId: "config_patch",
    endpoint: "config",
    method: "PATCH",
    policy: {
      requiredScopes: ["settings.write"],
      allowedPrincipalTypes: ACTOR_PRINCIPALS,
    },
    summary: "Patch config",
    description:
      "Deep-merge a partial JSON object into the settings.json configuration.",
    tags: ["config"],
    requestBody: ConfigPatchRequestSchema,
    responseBody: ConfigGetResponseSchema,
    handler: handlePatchConfig,
  },
  {
    operationId: "config_set",
    endpoint: "config/set",
    method: "POST",
    policy: {
      requiredScopes: ["settings.write"],
      allowedPrincipalTypes: ACTOR_PRINCIPALS,
    },
    summary: "Set a single config path",
    description:
      "Assign a value at a dotted config path with direct-replacement semantics " +
      "(preserves explicit null, replaces object subtrees instead of merging). " +
      "Used by the `assistant config set <key> <value>` CLI command.",
    tags: ["config"],
    handler: handleSetConfig,
  },
  {
    operationId: "config_allowlist_validate",
    endpoint: "config/allowlist/validate",
    method: "GET",
    policy: {
      requiredScopes: ["settings.read"],
      allowedPrincipalTypes: ACTOR_PRINCIPALS,
    },
    summary: "Validate secret-allowlist.json regex patterns",
    description:
      "Compile each regex pattern in secret-allowlist.json and return any " +
      "syntax errors. Returns { exists: false } if no file is present.",
    tags: ["config"],
    handler: handleValidateAllowlist,
  },
  {
    operationId: "config_schema_get",
    endpoint: "config/schema",
    method: "GET",
    policy: {
      requiredScopes: ["settings.read"],
      allowedPrincipalTypes: ACTOR_PRINCIPALS,
    },
    summary: "Get config JSON Schema",
    description:
      "Return the JSON Schema for the assistant config, optionally scoped to a dotted-path sub-schema (e.g. ?path=calls).",
    tags: ["config"],
    queryParams: [
      {
        name: "path",
        schema: { type: "string" },
        description: "Optional dotted path to a config sub-key",
      },
    ],
    handler: handleGetConfigSchema,
  },
  {
    operationId: "conversations_search",
    endpoint: "conversations/search",
    method: "GET",
    policy: {
      requiredScopes: ["chat.read"],
      allowedPrincipalTypes: ACTOR_PRINCIPALS,
    },
    summary: "Search conversations",
    description:
      "Full-text search across conversation titles and message content.",
    tags: ["conversations"],
    queryParams: [
      {
        name: "q",
        required: true,
        schema: { type: "string" },
        description: "Search query",
      },
      {
        name: "limit",
        schema: { type: "integer" },
        description: "Max results",
      },
      {
        name: "maxMessagesPerConversation",
        schema: { type: "integer" },
        description: "Max messages per conversation",
      },
    ],
    responseBody: z.object({
      query: z.string(),
      results: z.array(z.unknown()),
    }),
    handler: handleSearchConversations,
  },
  {
    operationId: "messages_content_get",
    endpoint: "messages/:id/content",
    method: "GET",
    policy: {
      requiredScopes: ["chat.read"],
      allowedPrincipalTypes: ACTOR_PRINCIPALS,
    },
    summary: "Get message content",
    description: "Return the full content of a single message by ID.",
    tags: ["messages"],
    queryParams: [
      {
        name: "conversationId",
        schema: { type: "string" },
        description: "Optional conversation ID filter",
      },
    ],
    handler: handleGetMessageContent,
  },
  {
    operationId: "conversations_llm_context_get",
    endpoint: "conversations/llm-context",
    method: "GET",
    policy: {
      requiredScopes: ["chat.read"],
      allowedPrincipalTypes: ACTOR_PRINCIPALS,
    },
    summary: "Get LLM context for a conversation",
    description:
      "Returns normalized LLM request/response logs for an entire conversation.",
    tags: ["conversations"],
    queryParams: [
      {
        name: "conversationKey",
        required: false,
        schema: { type: "string" },
        description: "Stable external conversation key.",
      },
      {
        name: "conversationId",
        required: false,
        schema: { type: "string" },
        description: "Internal conversation identifier.",
      },
      {
        name: "view",
        required: false,
        schema: { type: "string", enum: ["full", "summary"] },
        description:
          "Response shape. 'summary' omits per-log request/response sections; defaults to 'full'.",
      },
    ],
    responseBody: LlmContextResponseSchema,
    handler: handleGetConversationLlmContext,
  },
  {
    operationId: "messages_llm_context_get",
    endpoint: "messages/:id/llm-context",
    method: "GET",
    policy: {
      requiredScopes: ["chat.read"],
      allowedPrincipalTypes: ACTOR_PRINCIPALS,
    },
    summary: "Get LLM context for a message",
    description:
      "Return request/response logs and memory recall data for a specific message.",
    tags: ["messages"],
    queryParams: [
      {
        name: "view",
        required: false,
        schema: { type: "string", enum: ["full", "summary"] },
        description:
          "Response shape. 'summary' omits per-log request/response sections; defaults to 'full'.",
      },
    ],
    responseBody: LlmContextResponseSchema,
    handler: handleGetLlmContext,
  },
  {
    operationId: "llm_request_logs_payload_get",
    endpoint: "llm-request-logs/:id/payload",
    method: "GET",
    policy: {
      requiredScopes: ["chat.read"],
      allowedPrincipalTypes: ACTOR_PRINCIPALS,
    },
    summary: "Get raw payload for a single LLM request log",
    description:
      "Return the full request and response payloads for a specific log entry.",
    tags: ["messages"],
    responseBody: z.object({
      id: z.string(),
      requestPayload: z.unknown(),
      responsePayload: z.unknown(),
    }),
    handler: handleGetLlmRequestLogPayload,
  },
  {
    operationId: "llm_request_logs_context_get",
    endpoint: "llm-request-logs/:id/context",
    method: "GET",
    policy: {
      requiredScopes: ["chat.read"],
      allowedPrincipalTypes: ACTOR_PRINCIPALS,
    },
    summary: "Get normalized context for a single LLM request log",
    description:
      "Return the normalized summary and request/response sections for a specific log entry.",
    tags: ["messages"],
    responseBody: LLMRequestLogEntrySchema,
    handler: handleGetLlmRequestLogContext,
  },
  {
    operationId: "messages_queued_delete",
    endpoint: "messages/queued/:id",
    method: "DELETE",
    policy: {
      requiredScopes: ["chat.write"],
      allowedPrincipalTypes: ACTOR_PRINCIPALS,
    },
    summary: "Delete a queued message",
    description:
      "Remove a pending message from the conversation queue before it is processed. " +
      "Broadcasts `message_queued_deleted` so every client can close out the pending row.",
    tags: ["messages"],
    queryParams: [
      {
        name: "conversationId",
        schema: { type: "string" },
        required: true,
        description: "Conversation ID (required)",
      },
    ],
    additionalResponses: {
      "403": {
        description:
          "The queued message was enqueued by a different actor principal.",
      },
      "404": {
        description: "Conversation or queued message not found.",
      },
    },
    handler: handleDeleteQueuedMessage,
  },
  {
    operationId: "messages_queued_steer",
    endpoint: "messages/queued/:id/steer",
    method: "POST",
    policy: {
      requiredScopes: ["chat.write"],
      allowedPrincipalTypes: ACTOR_PRINCIPALS,
    },
    summary: "Steer to a queued message",
    description:
      "Promote a queued message to the head of the queue and abort the current generation so it is processed next.",
    tags: ["messages"],
    queryParams: [
      {
        name: "conversationId",
        schema: { type: "string" },
        required: true,
        description: "Conversation ID (required)",
      },
    ],
    additionalResponses: {
      "403": {
        description:
          "The queued message was enqueued by a different actor principal.",
      },
      "404": {
        description: "Conversation or queued message not found.",
      },
    },
    handler: handleSteerToMessage,
  },
];
