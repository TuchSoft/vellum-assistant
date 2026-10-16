import {
  bigint,
  boolean,
  doublePrecision,
  index,
  pgTable,
  text,
} from "drizzle-orm/pg-core";

import { bytea } from "./custom-types.js";

export const cronJobs = pgTable("cron_jobs", {
  id: text("id").primaryKey(),
  name: text("name").notNull(),
  description: text("description").notNull().default(""),
  enabled: boolean("enabled").notNull().default(true),
  cronExpression: text("cron_expression"), // nullable for one-shot schedules; e.g. '0 9 * * 1-5'
  scheduleSyntax: text("schedule_syntax").notNull().default("cron"), // 'cron' | 'rrule'
  timezone: text("timezone"), // e.g. 'America/Los_Angeles'
  message: text("message").notNull(),
  nextRunAt: bigint("next_run_at", { mode: "number" }).notNull(),
  lastRunAt: bigint("last_run_at", { mode: "number" }),
  lastStatus: text("last_status"), // 'ok' | 'error'
  retryCount: bigint("retry_count", { mode: "number" }).notNull().default(0),
  maxRetries: bigint("max_retries", { mode: "number" }).notNull().default(3),
  retryBackoffMs: bigint("retry_backoff_ms", { mode: "number" })
    .notNull()
    .default(60000),
  timeoutMs: bigint("timeout_ms", { mode: "number" }), // script-mode execution timeout override (ms); null = use default
  inferenceProfile: text("inference_profile"), // llm.profiles key for LLM-executed runs; null = default main-agent selection
  groupId: text("group_id"), // conversation_groups id for run conversations; null = system:scheduled
  createdFromConversationId: text("created_from_conversation_id"),
  createdBy: text("created_by").notNull(), // 'agent' | 'user'
  mode: text("mode").notNull().default("execute"), // 'notify' | 'execute'
  routingIntent: text("routing_intent").notNull().default("all_channels"), // 'single_channel' | 'multi_channel' | 'all_channels'
  routingHintsJson: text("routing_hints_json").notNull().default("{}"),
  status: text("status").notNull().default("active"), // 'active' | 'firing' | 'fired' | 'cancelled'
  quiet: boolean("quiet").notNull().default(false), // suppress completion notifications
  reuseConversation: boolean("reuse_conversation").notNull().default(false), // reuse the same conversation across runs
  script: text("script"), // shell command for script mode (nullable, only used when mode = 'script')
  wakeConversationId: text("wake_conversation_id"), // target conversation for wake mode (nullable)
  workflowName: text("workflow_name"), // saved workflow to trigger (nullable, only used when mode = 'workflow')
  workflowArgsJson: text("workflow_args_json"), // JSON-encoded args passed to the workflow run (nullable)
  capabilitiesJson: text("capabilities_json"), // JSON-encoded capability manifest for the run (nullable; null = hardcoded read-only manifest)
  sourceKey: text("source_key"), // plugin declaration key ('plugin:<pluginName>/<scheduleName>'); null = imperative schedule
  definitionHash: text("definition_hash"), // reconciler change detector over the declaration files (nullable, only used when source_key is set)
  userEnabled: boolean("user_enabled"), // user override for a sourced row's enabled state; null = declaration's value applies
  createdAt: bigint("created_at", { mode: "number" }).notNull(),
  updatedAt: bigint("updated_at", { mode: "number" }).notNull(),
});

export const cronRuns = pgTable("cron_runs", {
  id: text("id").primaryKey(),
  jobId: text("job_id")
    .notNull()
    .references(() => cronJobs.id, { onDelete: "cascade" }),
  status: text("status").notNull(), // 'ok' | 'error'
  startedAt: bigint("started_at", { mode: "number" }).notNull(),
  finishedAt: bigint("finished_at", { mode: "number" }),
  durationMs: bigint("duration_ms", { mode: "number" }),
  output: text("output"),
  error: text("error"),
  conversationId: text("conversation_id"),
  createdAt: bigint("created_at", { mode: "number" }).notNull(),
});

// Recurrence-centric aliases — prefer these in new code.
// Physical table names remain `cron_jobs` / `cron_runs` for migration compatibility.
export const scheduleJobs = cronJobs;
export const scheduleRuns = cronRuns;

export const heartbeatRuns = pgTable("heartbeat_runs", {
  id: text("id").primaryKey(),
  scheduledFor: bigint("scheduled_for", { mode: "number" }).notNull(),
  startedAt: bigint("started_at", { mode: "number" }),
  finishedAt: bigint("finished_at", { mode: "number" }),
  durationMs: bigint("duration_ms", { mode: "number" }),
  status: text("status").notNull(), // 'pending' | 'running' | 'ok' | 'error' | 'timeout' | 'skipped' | 'missed' | 'superseded'
  skipReason: text("skip_reason"), // 'disabled' | 'outside_active_hours' | 'overlap'
  error: text("error"),
  conversationId: text("conversation_id"),
  createdAt: bigint("created_at", { mode: "number" }).notNull(),
});

export const sharedAppLinks = pgTable("shared_app_links", {
  id: text("id").primaryKey(),
  shareToken: text("share_token").notNull().unique(),
  bundleData: bytea("bundle_data").notNull(),
  bundleSizeBytes: bigint("bundle_size_bytes", { mode: "number" }).notNull(),
  manifestJson: text("manifest_json").notNull(),
  downloadCount: bigint("download_count", { mode: "number" })
    .notNull()
    .default(0),
  createdAt: bigint("created_at", { mode: "number" }).notNull(),
  expiresAt: bigint("expires_at", { mode: "number" }),
});

/**
 * Which apps the user pinned to the sidebar. A pin is a preference about an
 * app rather than part of one, so it lives here rather than in the app's own
 * record: plugin apps are pinnable and their records belong to the plugin that
 * ships them.
 *
 * `sortPosition` is a fractional index, matching `conversation_groups`, so a
 * pin can be placed between two others without renumbering the rest.
 */
export const appPins = pgTable("app_pins", {
  appId: text("app_id").primaryKey(),
  sortPosition: doublePrecision("sort_position").notNull(),
  /** An id from the client's pinned-app colour registry; null = uncoloured. */
  color: text("color"),
  createdAt: bigint("created_at", { mode: "number" }).notNull(),
});

export const publishedPages = pgTable("published_pages", {
  id: text("id").primaryKey(),
  deploymentId: text("deployment_id").notNull().unique(),
  publicUrl: text("public_url").notNull(),
  pageTitle: text("page_title"),
  htmlHash: text("html_hash").notNull(),
  publishedAt: bigint("published_at", { mode: "number" }).notNull(),
  status: text("status").notNull().default("active"),
  appId: text("app_id"),
  projectSlug: text("project_slug"),
});

export const watchers = pgTable("watchers", {
  id: text("id").primaryKey(),
  name: text("name").notNull(),
  providerId: text("provider_id").notNull(),
  enabled: boolean("enabled").notNull().default(true),
  pollIntervalMs: bigint("poll_interval_ms", { mode: "number" })
    .notNull()
    .default(60000),
  actionPrompt: text("action_prompt").notNull(),
  watermark: text("watermark"),
  conversationId: text("conversation_id"),
  status: text("status").notNull().default("idle"), // idle | polling | error | disabled
  consecutiveErrors: bigint("consecutive_errors", { mode: "number" })
    .notNull()
    .default(0),
  lastError: text("last_error"),
  lastPollAt: bigint("last_poll_at", { mode: "number" }),
  nextPollAt: bigint("next_poll_at", { mode: "number" }).notNull(),
  configJson: text("config_json"),
  credentialService: text("credential_service").notNull(),
  createdAt: bigint("created_at", { mode: "number" }).notNull(),
  updatedAt: bigint("updated_at", { mode: "number" }).notNull(),
});

export const watcherEvents = pgTable("watcher_events", {
  id: text("id").primaryKey(),
  watcherId: text("watcher_id")
    .notNull()
    .references(() => watchers.id, { onDelete: "cascade" }),
  externalId: text("external_id").notNull(),
  eventType: text("event_type").notNull(),
  summary: text("summary").notNull(),
  payloadJson: text("payload_json").notNull(),
  disposition: text("disposition").notNull().default("pending"), // pending | silent | notify | escalate | error
  llmAction: text("llm_action"),
  processedAt: bigint("processed_at", { mode: "number" }),
  createdAt: bigint("created_at", { mode: "number" }).notNull(),
});

export const llmRequestLogs = pgTable(
  "llm_request_logs",
  {
    id: text("id").primaryKey(),
    conversationId: text("conversation_id").notNull(),
    messageId: text("message_id"),
    provider: text("provider"),
    requestPayload: text("request_payload").notNull(),
    responsePayload: text("response_payload").notNull(),
    createdAt: bigint("created_at", { mode: "number" }).notNull(),
    agentLoopExitReason: text("agent_loop_exit_reason"),
    /**
     * Logical call site that produced this row — e.g. `mainAgent`,
     * `compactionAgent`. Stored as free-form text rather than enum-bound
     * so a new call site can ship without a schema bump, but in practice
     * callers pass values from `LLMCallSite` (`config/schemas/llm.ts`).
     *
     * Historical rows (pre-migration 264) stay NULL — "we don't know"
     * rather than guessing `mainAgent`.
     */
    callSite: text("call_site"),
    /**
     * JSON-serialized first-token latency waterfall measured by the daemon
     * (`LatencyBreakdown` in `api/responses/llm-request-log-entry.ts`):
     * queue → memory/context retrieval → setup → request prep →
     * time-to-first-token → generation. NULL on pre-instrumentation rows,
     * failed calls, and non-main-agent call sites.
     */
    latencyBreakdown: text("latency_breakdown"),
  },
  (table) => [
    index("idx_llm_request_logs_message_id").on(table.messageId),
    index("idx_llm_request_logs_created_at").on(table.createdAt),
  ],
);

// Per-turn diagnostics for memory recall, recording hit counts, latency,
// and the injected text. Lives in the dedicated memory database
// (`assistant-memory.db`), not main — access it via the memory connection
// (`getMemoryDb()` / `getMemorySqlite()`).
export const memoryRecallLogs = pgTable(
  "memory_recall_logs",
  {
    id: text("id").primaryKey(),
    conversationId: text("conversation_id").notNull(),
    messageId: text("message_id"),
    enabled: bigint("enabled", { mode: "number" }).notNull(),
    degraded: bigint("degraded", { mode: "number" }).notNull(),
    provider: text("provider"),
    model: text("model"),
    degradationJson: text("degradation_json"),
    semanticHits: bigint("semantic_hits", { mode: "number" }).notNull(),
    mergedCount: bigint("merged_count", { mode: "number" }).notNull(),
    selectedCount: bigint("selected_count", { mode: "number" }).notNull(),
    tier1Count: bigint("tier1_count", { mode: "number" }).notNull(),
    tier2Count: bigint("tier2_count", { mode: "number" }).notNull(),
    hybridSearchLatencyMs: bigint("hybrid_search_latency_ms", {
      mode: "number",
    }).notNull(),
    sparseVectorUsed: bigint("sparse_vector_used", {
      mode: "number",
    }).notNull(),
    injectedTokens: bigint("injected_tokens", { mode: "number" }).notNull(),
    latencyMs: bigint("latency_ms", { mode: "number" }).notNull(),
    topCandidatesJson: text("top_candidates_json").notNull(),
    injectedText: text("injected_text"),
    reason: text("reason"),
    queryContext: text("query_context"),
    createdAt: bigint("created_at", { mode: "number" }).notNull(),
  },
  (table) => [
    index("idx_memory_recall_logs_message_id").on(table.messageId),
    index("idx_memory_recall_logs_conversation_id").on(table.conversationId),
  ],
);

// Per-turn log of memory-v2 concept/skill activations. Lives in the
// dedicated memory database (`assistant-memory.db`), not main — access it
// via the memory connection (`getMemoryDb()` / `getMemorySqlite()`).
export const memoryV2ActivationLogs = pgTable(
  "memory_v2_activation_logs",
  {
    id: text("id").primaryKey(),
    conversationId: text("conversation_id").notNull(),
    messageId: text("message_id"),
    turn: bigint("turn", { mode: "number" }).notNull(),
    mode: text("mode").notNull(), // "context-load" | "per-turn"
    conceptsJson: text("concepts_json").notNull(),
    skillsJson: text("skills_json").notNull(),
    configJson: text("config_json").notNull(),
    createdAt: bigint("created_at", { mode: "number" }).notNull(),
  },
  (table) => [
    index("idx_memory_v2_activation_logs_message_id").on(table.messageId),
    index("idx_memory_v2_activation_logs_conversation_id").on(
      table.conversationId,
    ),
    index("idx_memory_v2_activation_logs_created_at").on(table.createdAt),
  ],
);

export const llmUsageEvents = pgTable(
  "llm_usage_events",
  {
    id: text("id").primaryKey(),
    createdAt: bigint("created_at", { mode: "number" }).notNull(),
    conversationId: text("conversation_id"),
    runId: text("run_id"),
    cronRunId: text("cron_run_id"),
    requestId: text("request_id"),
    actor: text("actor").notNull(),
    callSite: text("call_site"),
    inferenceProfile: text("inference_profile"),
    inferenceProfileSource: text("inference_profile_source"),
    provider: text("provider").notNull(),
    model: text("model").notNull(),
    inputTokens: bigint("input_tokens", { mode: "number" }).notNull(),
    outputTokens: bigint("output_tokens", { mode: "number" }).notNull(),
    cacheCreationInputTokens: bigint("cache_creation_input_tokens", {
      mode: "number",
    }),
    cacheReadInputTokens: bigint("cache_read_input_tokens", { mode: "number" }),
    /**
     * The provider's untouched `usage` block, serialized as JSON. Anthropic
     * nests the TTL breakdown under `cache_creation.ephemeral_{5m,1h}_input_tokens`;
     * OpenAI nests cached-read details under `prompt_tokens_details`; both are
     * just preserved verbatim so admin charts and downstream consumers can
     * extract whatever provider-specific detail they need without a schema
     * change every time a provider exposes a new field. `null` when the
     * provider didn't return a usage block or for rows persisted before
     * migration 260.
     */
    rawUsage: text("raw_usage"),
    estimatedCostUsd: doublePrecision("estimated_cost_usd"),
    pricingStatus: text("pricing_status").notNull(),
    llmCallCount: bigint("llm_call_count", { mode: "number" }),
    metadataJson: text("metadata_json"),
    /**
     * Version of the assistant binary at the moment THIS event was
     * recorded (not when the batch was uploaded). Telemetry uploads
     * batch events together and may flush days after the event fired
     * (offline laptop, network outage, ingest clog — see May 2026
     * incident). Stamping at record time keeps the version filter on
     * `/admin/inference` truthful for delayed batches. Null for rows
     * persisted before migration 267 ran.
     */
    assistantVersion: text("assistant_version"),
    /**
     * `conversations.conversation_type` of the parent conversation
     * (`"standard"` / `"background"` / `"scheduled"`), captured at RECORD
     * time. The parent conversation can be deleted before the telemetry
     * flush joins against it (memory-retrospective forks are GC'd once
     * superseded; users delete conversations), so a flush-time JOIN alone
     * under-labels usage rows. Null when the call has no parent
     * conversation and for rows persisted before migration 353 ran (the
     * telemetry read path falls back to the JOIN for those).
     */
    conversationType: text("conversation_type"),
  },
  (table) => [
    index("idx_llm_usage_events_conversation_id").on(table.conversationId),
  ],
);

// One row per conversation started on the activation-rail bootstrap template.
// Lets the activation funnel telemetry scope its events to activation
// conversations without inspecting the bootstrap template at emit time.
// Lives in the dedicated memory database (`assistant-memory.db`), not main —
// access it via the memory connection (`getMemoryDb()` / `getMemorySqlite()`).
export const activationSessions = pgTable("activation_sessions", {
  conversationId: text("conversation_id").primaryKey(),
  createdAt: bigint("created_at", { mode: "number" }).notNull(),
});

// Key/value store for telemetry flush state — the per-event-type
// `(last_reported_at, last_reported_id)` watermark cursors advanced by the
// usage telemetry reporter after each successful upload. Lives on the
// dedicated telemetry database (assistant-telemetry.db) so flush state
// stays with the telemetry pipeline; the main DB's `memory_checkpoints`
// ledger is reserved for DB-migration checkpoints.
export const flushCheckpoints = pgTable("flush_checkpoints", {
  key: text("key").primaryKey(),
  value: text("value").notNull(),
  updatedAt: bigint("updated_at", { mode: "number" }).notNull(),
});

// Generic telemetry outbox. Lives on the dedicated telemetry database
// (assistant-telemetry.db). Each row's `payload` is the wire `TelemetryEvent`
// JSON built at record time; `name` is the telemetry source id (e.g.
// 'lifecycle'). Rows are deleted on successful flush by the usage telemetry
// reporter. `conversation_id` is populated only for conversation-scoped
// events so redaction stays an indexed column delete.
export const telemetryEvents = pgTable(
  "telemetry_events",
  {
    id: text("id").primaryKey(),
    name: text("name").notNull(),
    createdAt: bigint("created_at", { mode: "number" }).notNull(),
    conversationId: text("conversation_id"),
    payload: text("payload").notNull(),
  },
  (table) => [
    index("idx_telemetry_events_name_created_at_id").on(
      table.name,
      table.createdAt,
      table.id,
    ),
    index("idx_telemetry_events_conversation_id").on(table.conversationId),
  ],
);

/**
 * Append-only hub subscribe/dispose ledger. Support reconstructs client
 * uptime and reconnect flaps from these rows. No message bodies or page
 * URLs: client UUID, interface, close reason, and optional build
 * fingerprint only.
 */
export const clientConnectionEvents = pgTable(
  "client_connection_events",
  {
    id: text("id").primaryKey(),
    clientId: text("client_id").notNull(),
    interfaceId: text("interface_id").notNull(),
    connectionId: text("connection_id").notNull(),
    reason: text("reason").notNull(),
    occurredAt: bigint("occurred_at", { mode: "number" }).notNull(),
    actorPrincipalId: text("actor_principal_id"),
    clientVersion: text("client_version"),
    sseWatchdog: boolean("sse_watchdog"),
    machineName: text("machine_name"),
  },
  (table) => [
    index("idx_client_connection_events_client_occurred").on(
      table.clientId,
      table.occurredAt,
    ),
    index("idx_client_connection_events_occurred").on(table.occurredAt),
  ],
);
