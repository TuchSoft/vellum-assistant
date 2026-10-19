/**
 * Gateway alias catalog.
 *
 * The LLM gateway (LiteLLM) is the single transport for every inference call,
 * and it is also the source of truth for which aliases exist and what they can
 * do. This module reads `GET <gateway>/v1/model/info` and exposes the result as
 * a synchronous snapshot so the resolver, the context-window budgeting and the
 * capability probes keep their pure/synchronous contracts.
 *
 * Precedence of the data, high to low:
 *   1. the last successful gateway fetch (in memory),
 *   2. the on-disk snapshot written by that fetch (`data/cache/model-catalog.json`),
 *   3. the code-owned fallback table below.
 *
 * The fallback covers exactly the aliases this build knows how to configure.
 * An alias outside every layer is unknown: callers must treat it as a
 * configuration error, never as a reason to disable a call site silently.
 *
 * The provider imports are dynamic on purpose. The resolver is imported from
 * the provider layer, so a static import back into `providers/` would create a
 * module cycle; the fetch path is the only code that needs a connection row.
 */

import {
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  writeFileSync,
} from "node:fs";
import { dirname, join } from "node:path";

import { z } from "zod";

import { getLogger } from "../util/logger.js";
import { getDataDir } from "../util/platform.js";

const log = getLogger("config/llm-catalog");

/** Env var naming the gateway base URL (includes the `/v1` suffix). */
export const LLM_GATEWAY_URL_ENV = "VELLUM_LLM_GATEWAY_URL";
/** Canonical connection row name for the LLM gateway. */
export const LLM_GATEWAY_CONNECTION_NAME = "llm-gateway";

const DEFAULT_GATEWAY_BASE_URL = "http://llm-gateway:4000/v1";
const REFRESH_TTL_MS = 60_000;
const FETCH_TIMEOUT_MS = 5_000;
const SNAPSHOT_VERSION = 1;
const SNAPSHOT_FILE = "model-catalog.json";

export type CatalogMode =
  | "chat"
  | "embedding"
  | "audio_transcription"
  | "audio_speech"
  | "image_generation";

export interface CatalogEntry {
  /** Alias sent to the gateway as `model`. */
  alias: string;
  /** Human label; defaults to the alias. */
  label: string;
  maxInputTokens?: number;
  maxOutputTokens?: number;
  supportsVision: boolean;
  supportsTools: boolean;
  supportsReasoning?: boolean;
  mode: CatalogMode;
}

export interface CatalogSnapshot {
  entries: CatalogEntry[];
  /** Epoch millis of the fetch that produced `entries`. */
  fetchedAt: number;
  source: "gateway" | "disk" | "fallback";
}

/**
 * Conservative windows for the shipped aliases. These are deliberately lower
 * than the upstream provider maxima: `/model/info` occasionally reports an
 * estimated value (LiteLLM guesses 1.05M tokens for a family it does not
 * know), and budgeting on an inflated window sends prompts the upstream
 * rejects.
 */
const FALLBACK_ENTRIES: readonly CatalogEntry[] = [
  {
    alias: "main",
    label: "Main",
    maxInputTokens: 200_000,
    maxOutputTokens: 64_000,
    supportsVision: false,
    supportsTools: true,
    supportsReasoning: true,
    mode: "chat",
  },
  {
    alias: "main-pro",
    label: "Main Pro",
    maxInputTokens: 200_000,
    maxOutputTokens: 64_000,
    supportsVision: false,
    supportsTools: true,
    supportsReasoning: true,
    mode: "chat",
  },
  {
    alias: "small",
    label: "Small",
    maxInputTokens: 200_000,
    maxOutputTokens: 64_000,
    supportsVision: false,
    supportsTools: true,
    supportsReasoning: true,
    mode: "chat",
  },
  {
    alias: "fast",
    label: "Fast",
    maxInputTokens: 200_000,
    maxOutputTokens: 16_000,
    supportsVision: false,
    supportsTools: true,
    supportsReasoning: false,
    mode: "chat",
  },
  {
    alias: "recall",
    label: "Recall",
    maxInputTokens: 200_000,
    maxOutputTokens: 4_096,
    supportsVision: false,
    supportsTools: true,
    supportsReasoning: false,
    mode: "chat",
  },
  {
    alias: "title",
    label: "Title",
    maxInputTokens: 200_000,
    maxOutputTokens: 120,
    supportsVision: false,
    supportsTools: false,
    supportsReasoning: false,
    mode: "chat",
  },
  {
    alias: "vision",
    label: "Vision",
    maxInputTokens: 128_000,
    maxOutputTokens: 16_000,
    supportsVision: true,
    supportsTools: true,
    mode: "chat",
  },
  {
    alias: "embed",
    label: "Embeddings",
    maxInputTokens: 8_192,
    supportsVision: false,
    supportsTools: false,
    mode: "embedding",
  },
];

const CATALOG_MODES = new Set<CatalogMode>([
  "chat",
  "embedding",
  "audio_transcription",
  "audio_speech",
  "image_generation",
]);

const modelInfoSchema = z.object({
  max_input_tokens: z.number().int().positive().nullish(),
  max_output_tokens: z.number().int().positive().nullish(),
  supports_vision: z.boolean().nullish(),
  supports_function_calling: z.boolean().nullish(),
  supports_reasoning: z.boolean().nullish(),
  mode: z.string().nullish(),
});

const modelInfoItemSchema = z.object({
  model_name: z.string().min(1).optional(),
  id: z.string().min(1).optional(),
  model_info: modelInfoSchema.nullish(),
  litellm_params: z.object({ model: z.string().nullish() }).nullish(),
});

const modelInfoResponseSchema = z.object({
  data: z.array(modelInfoItemSchema),
});

const modelsResponseSchema = z.object({
  data: z.array(z.object({ id: z.string().min(1) })),
});

const diskSnapshotSchema = z.object({
  version: z.literal(SNAPSHOT_VERSION),
  fetchedAt: z.number().int().nonnegative(),
  entries: z.array(
    z.object({
      alias: z.string().min(1),
      label: z.string().min(1),
      maxInputTokens: z.number().int().positive().optional(),
      maxOutputTokens: z.number().int().positive().optional(),
      supportsVision: z.boolean(),
      supportsTools: z.boolean(),
      supportsReasoning: z.boolean().optional(),
      mode: z.string(),
    }),
  ),
});

function fallbackSnapshot(): CatalogSnapshot {
  return {
    entries: FALLBACK_ENTRIES.map((entry) => ({ ...entry })),
    fetchedAt: 0,
    source: "fallback",
  };
}

function normalizeMode(value: string | null | undefined): CatalogMode {
  return value != null && CATALOG_MODES.has(value as CatalogMode)
    ? (value as CatalogMode)
    : "chat";
}

function toEntry(
  item: z.infer<typeof modelInfoItemSchema>,
): CatalogEntry | null {
  const alias = item.model_name ?? item.id;
  if (alias == null) {
    return null;
  }
  const info = item.model_info ?? {};
  return {
    alias,
    label: alias,
    ...(info.max_input_tokens != null
      ? { maxInputTokens: info.max_input_tokens }
      : {}),
    ...(info.max_output_tokens != null
      ? { maxOutputTokens: info.max_output_tokens }
      : {}),
    supportsVision: info.supports_vision === true,
    supportsTools: info.supports_function_calling === true,
    ...(info.supports_reasoning != null
      ? { supportsReasoning: info.supports_reasoning }
      : {}),
    mode: normalizeMode(info.mode),
  };
}

export function catalogSnapshotPath(): string {
  return join(getDataDir(), "cache", SNAPSHOT_FILE);
}

function readDiskSnapshot(): CatalogSnapshot | null {
  const path = catalogSnapshotPath();
  if (!existsSync(path)) {
    return null;
  }
  try {
    const parsed = diskSnapshotSchema.safeParse(
      JSON.parse(readFileSync(path, "utf-8")),
    );
    if (!parsed.success || parsed.data.version !== SNAPSHOT_VERSION) {
      return null;
    }
    return {
      entries: parsed.data.entries.map((entry) => ({
        ...entry,
        mode: normalizeMode(entry.mode),
      })),
      fetchedAt: parsed.data.fetchedAt,
      source: "disk",
    };
  } catch (err) {
    log.warn({ err }, "Could not read the model catalog snapshot");
    return null;
  }
}

function writeDiskSnapshot(snapshot: CatalogSnapshot): void {
  try {
    const path = catalogSnapshotPath();
    mkdirSync(dirname(path), { recursive: true });
    const temp = `${path}.tmp`;
    writeFileSync(
      temp,
      JSON.stringify(
        {
          version: SNAPSHOT_VERSION,
          fetchedAt: snapshot.fetchedAt,
          entries: snapshot.entries,
        },
        null,
        2,
      ) + "\n",
    );
    renameSync(temp, path);
  } catch (err) {
    log.warn({ err }, "Could not write the model catalog snapshot");
  }
}

let snapshot: CatalogSnapshot | undefined;
let refreshInFlight: Promise<void> | null = null;
let lastRefreshAttemptAt = 0;

function snapshotOrDefault(): CatalogSnapshot {
  if (snapshot === undefined) {
    snapshot = readDiskSnapshot() ?? fallbackSnapshot();
  }
  return snapshot;
}

/** The current catalog. Never throws: falls back to the code-owned table. */
export function getCatalogSnapshot(): CatalogSnapshot {
  return snapshotOrDefault();
}

/** Whether an alias is known to the current catalog. */
export function isKnownAlias(alias: string): boolean {
  return snapshotOrDefault().entries.some((entry) => entry.alias === alias);
}

/** Catalog entry for an alias, or `undefined` when the alias is unknown. */
export function getCatalogEntry(alias: string): CatalogEntry | undefined {
  return snapshotOrDefault().entries.find((entry) => entry.alias === alias);
}

/** Disjoint view for callers that need one mode only (embeddings, speech). */
export function listCatalogEntries(mode?: CatalogMode): CatalogEntry[] {
  const entries = snapshotOrDefault().entries;
  return mode == null ? entries : entries.filter((e) => e.mode === mode);
}

interface GatewayEndpoint {
  baseUrl: string;
  headers: Record<string, string>;
}

async function resolveGatewayEndpoint(): Promise<GatewayEndpoint | null> {
  const envUrl = process.env[LLM_GATEWAY_URL_ENV]?.trim();
  try {
    const { ensureConnectionSnapshot, peekConnection, listConnections } =
      await import("../providers/inference/connections.js");
    const { resolveAuth } =
      await import("../providers/inference/resolve-auth.js");
    await ensureConnectionSnapshot();
    const named = peekConnection(LLM_GATEWAY_CONNECTION_NAME);
    const row =
      named ??
      (
        await listConnections(undefined, { provider: "openai-compatible" })
      ).find((connection) => connection.baseUrl != null);
    const baseUrl = envUrl || row?.baseUrl || DEFAULT_GATEWAY_BASE_URL;
    if (row != null) {
      const resolved = await resolveAuth(row.auth, row.provider, {
        baseUrl,
      });
      if (resolved.ok && resolved.resolved.kind === "header") {
        return { baseUrl, headers: resolved.resolved.headers };
      }
    }
  } catch (err) {
    log.debug({ err }, "Gateway connection lookup failed");
  }
  if (!envUrl) {
    return null;
  }
  const apiKey = process.env.VELLUM_LLM_GATEWAY_API_KEY?.trim();
  return {
    baseUrl: envUrl,
    headers: apiKey ? { Authorization: `Bearer ${apiKey}` } : {},
  };
}

function endpointUrl(baseUrl: string, path: string): string {
  return `${baseUrl.replace(/\/+$/, "")}${path}`;
}

async function fetchJson(
  url: string,
  headers: Record<string, string>,
): Promise<unknown | null> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
  try {
    const response = await fetch(url, {
      headers: { Accept: "application/json", ...headers },
      signal: controller.signal,
    });
    if (!response.ok) {
      log.debug({ url, status: response.status }, "Catalog fetch failed");
      return null;
    }
    return (await response.json()) as unknown;
  } catch (err) {
    log.debug({ err, url }, "Catalog fetch failed");
    return null;
  } finally {
    clearTimeout(timer);
  }
}

async function fetchEntries(
  endpoint: GatewayEndpoint,
): Promise<CatalogEntry[] | null> {
  const info = await fetchJson(
    endpointUrl(endpoint.baseUrl, "/model/info"),
    endpoint.headers,
  );
  if (info != null) {
    const parsed = modelInfoResponseSchema.safeParse(info);
    if (parsed.success) {
      const entries = parsed.data.data.flatMap((item) => {
        const entry = toEntry(item);
        return entry == null ? [] : [entry];
      });
      if (entries.length > 0) {
        return entries;
      }
    }
  }

  // Older LiteLLM builds expose ids only. Merge them with the code-owned
  // capabilities so a bare id list still yields a usable catalog.
  const models = await fetchJson(
    endpointUrl(endpoint.baseUrl, "/models"),
    endpoint.headers,
  );
  if (models == null) {
    return null;
  }
  const parsed = modelsResponseSchema.safeParse(models);
  if (!parsed.success) {
    return null;
  }
  return parsed.data.data.map(({ id }) => {
    const known = FALLBACK_ENTRIES.find((entry) => entry.alias === id);
    return known != null
      ? { ...known }
      : {
          alias: id,
          label: id,
          supportsVision: false,
          supportsTools: true,
          mode: "chat" as const,
        };
  });
}

async function doRefresh(): Promise<void> {
  lastRefreshAttemptAt = Date.now();
  const endpoint = await resolveGatewayEndpoint();
  if (endpoint == null) {
    return;
  }
  const entries = await fetchEntries(endpoint);
  if (entries == null || entries.length === 0) {
    return;
  }
  snapshot = {
    entries,
    fetchedAt: Date.now(),
    source: "gateway",
  };
  writeDiskSnapshot(snapshot);
}

/**
 * Refresh the catalog from the gateway. Single-flight and TTL-gated unless
 * `force` is set, so callers may invoke it on every read path.
 */
export async function refreshCatalog(force = false): Promise<void> {
  if (!force && Date.now() - lastRefreshAttemptAt < REFRESH_TTL_MS) {
    return;
  }
  if (refreshInFlight != null) {
    return refreshInFlight;
  }
  refreshInFlight = doRefresh()
    .catch((err) => {
      log.warn({ err }, "Model catalog refresh failed");
    })
    .finally(() => {
      refreshInFlight = null;
    });
  return refreshInFlight;
}

/** Test-only seam: replace the in-memory snapshot. */
export function __setCatalogSnapshotForTests(
  next: CatalogSnapshot | undefined,
): void {
  snapshot = next;
  lastRefreshAttemptAt = 0;
}
