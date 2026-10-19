import type { InterfaceId } from "../channels/types.js";
import { resolveEffectiveContextWindow } from "../config/llm-context-resolution.js";
import { knownAliases } from "../config/llm-resolver.js";
import { getConfig } from "../config/loader.js";
import {
  getConversationModel,
  setConversationModel,
} from "../persistence/conversation-crud.js";

export type SlashResolution =
  | { kind: "passthrough"; content: string }
  | { kind: "unknown"; message: string }
  | { kind: "compact" }
  | { kind: "clean" };

type CompactParse = { kind: "compact" } | { kind: "unknown"; message: string };

const COMPACT_COMMAND_PATTERN = /^\/compact(?:\s+(.+?))?\s*$/i;

function parseCompactCommand(trimmed: string): CompactParse | null {
  const match = trimmed.match(COMPACT_COMMAND_PATTERN);
  if (!match) {
    return null;
  }
  const rest = match[1]?.trim();
  if (rest) {
    return {
      kind: "unknown",
      message: `\`/compact\` does not take arguments. Usage: \`/compact\`.`,
    };
  }
  return { kind: "compact" };
}

type CleanParse = { kind: "clean" } | { kind: "unknown"; message: string };

const CLEAN_COMMAND_PATTERN = /^\/clean(?:\s+(.+?))?\s*$/i;

function parseCleanCommand(trimmed: string): CleanParse | null {
  const match = trimmed.match(CLEAN_COMMAND_PATTERN);
  if (!match) {
    return null;
  }
  const rest = match[1]?.trim();
  if (rest) {
    return {
      kind: "unknown",
      message: `\`/clean\` does not take arguments. Usage: \`/clean\`.`,
    };
  }
  return { kind: "clean" };
}

// ── /context and /status commands ────────────────────────────────────

export interface SlashContext {
  conversationId?: string;
  messageCount: number;
  inputTokens: number;
  outputTokens: number;
  maxInputTokens: number;
  model: string;
  provider: string;
  estimatedCost: number;
  userMessageInterface?: InterfaceId;
}

export interface SlashContextSource {
  conversationId: string;
  messageCount: number;
  inputTokens: number;
  outputTokens: number;
  estimatedCost: number;
  userMessageInterface?: InterfaceId;
}

export async function buildSlashContextForContent(
  content: string,
  source: SlashContextSource,
): Promise<SlashContext | undefined> {
  if (classifySlash(content) === "passthrough") {
    return undefined;
  }

  const config = getConfig();
  const contextWindow = resolveEffectiveContextWindow({
    llm: config.llm,
    callSite: "mainAgent",
    conversationModel: await getConversationModel(source.conversationId),
  });
  if (contextWindow == null) {
    throw new Error('Call site "mainAgent" is disabled.');
  }
  return {
    conversationId: source.conversationId,
    messageCount: source.messageCount,
    inputTokens: source.inputTokens,
    outputTokens: source.outputTokens,
    maxInputTokens: contextWindow.maxInputTokens,
    model: contextWindow.model,
    provider: contextWindow.provider,
    estimatedCost: source.estimatedCost,
    userMessageInterface: source.userMessageInterface,
  };
}

// ── Deprecated model-switching shortcuts ─────────────────────────────

/**
 * Former provider shortcut commands that switched models. These are now
 * removed — model switching lives in Settings. We reject them explicitly
 * so they don't fall through to the LLM as passthrough text.
 */
const DEPRECATED_MODEL_SHORTCUTS = new Set([
  "opus",
  "sonnet",
  "haiku",
  "grok-beta",
  "grok-multi",
]);

// ── /model command (inference profile switcher) ──────────────────────

type ModelCommandParse = { kind: "list" } | { kind: "switch"; alias: string };

function parseModelCommand(trimmed: string): ModelCommandParse | null {
  if (!/^\/model(?:\s|$)/i.test(trimmed)) {
    return null;
  }
  const rest = trimmed.replace(/^\/model\s*/i, "").trim();
  if (rest.length === 0) {
    return { kind: "list" };
  }
  return { kind: "switch", alias: rest };
}

async function resolveModelCommand(
  parse: ModelCommandParse,
  conversationId: string | undefined,
): Promise<SlashResolution> {
  const config = getConfig();
  const aliases = knownAliases(config.llm);
  const current =
    (conversationId != null
      ? await getConversationModel(conversationId)
      : undefined) ?? config.llm.defaultModel;

  if (parse.kind === "list") {
    if (aliases.length === 0) {
      return {
        kind: "unknown",
        message: "The gateway catalog is empty. Check the gateway connection.",
      };
    }
    const lines = ["Available models:\n"];
    for (const alias of aliases) {
      const marker = alias === current ? " **[current]**" : "";
      lines.push(`  - \`${alias}\`${marker}`);
    }
    lines.push("\nSwitch with `/model <alias>`.");
    return { kind: "unknown", message: lines.join("\n") };
  }

  const target = parse.alias;
  if (!aliases.includes(target)) {
    const available = aliases.map((n) => `\`${n}\``).join(", ");
    const hint = available.length > 0 ? ` Available: ${available}.` : "";
    return {
      kind: "unknown",
      message: `Model \`${target}\` not found.${hint}`,
    };
  }
  if (target === current) {
    return {
      kind: "unknown",
      message: `Already using model \`${target}\`.`,
    };
  }

  if (conversationId == null) {
    return {
      kind: "unknown",
      message:
        "Model switching needs a conversation context. Pick the model in the composer.",
    };
  }
  await setConversationModel(conversationId, target);
  return {
    kind: "unknown",
    message: `Switched to model \`${target}\`.`,
  };
}

// ── /models command ──────────────────────────────────────────────────

async function resolveModelList(): Promise<SlashResolution> {
  const config = getConfig();
  const aliases = knownAliases(config.llm);
  const lines = ["Available models:\n"];
  for (const alias of aliases) {
    const marker = alias === config.llm.defaultModel ? " **[default]**" : "";
    lines.push(`  - \`${alias}\`${marker}`);
  }
  return { kind: "unknown", message: lines.join("\n") };
}

function resolveStatusCommand(context: SlashContext): SlashResolution {
  const {
    inputTokens,
    maxInputTokens,
    model,
    provider,
    messageCount,
    outputTokens,
    estimatedCost,
  } = context;
  const pct =
    maxInputTokens > 0
      ? Math.min(Math.round((inputTokens / maxInputTokens) * 100), 100)
      : 0;
  const filled = Math.round(pct / 5);
  const bar = "█".repeat(filled) + "░".repeat(20 - filled);
  const fmt = (n: number) => n.toLocaleString("en-US");

  const lines = [
    "Conversation Status\n",
    `Context:  ${bar}  ${pct}%  (${fmt(inputTokens)} / ${fmt(
      maxInputTokens,
    )} tokens)`,
    `Model:    ${model} (${provider})`,
    `Messages: ${fmt(messageCount)}`,
    `Tokens:   ${fmt(inputTokens)} in / ${fmt(outputTokens)} out`,
    `Cost:     $${estimatedCost.toFixed(2)} (estimated)`,
  ];

  return { kind: "unknown", message: lines.join("\n") };
}

const CLEAN_HELP_LINE =
  "/clean — Strip injected runtime context and reset memory injection state (no summarization)";
const FORK_CAPABLE_INTERFACES = new Set<InterfaceId>([
  "macos",
  "windows",
  "ios",
]);

function resolveCommandsList(context?: SlashContext): string[] {
  const fallbackLines = [
    "/commands — List all available commands",
    "/compact — Force context compaction immediately",
    CLEAN_HELP_LINE,
  ];
  if (context) {
    fallbackLines.push("/context — Show conversation context usage");
  }
  fallbackLines.push("/model — List or switch inference profile");
  fallbackLines.push("/models — List all available models");
  if (context) {
    fallbackLines.push("/status — Show conversation status and context usage");
  }

  if (!context?.userMessageInterface) {
    return fallbackLines;
  }

  if (FORK_CAPABLE_INTERFACES.has(context.userMessageInterface)) {
    return [
      "/commands — List all available commands",
      "/compact — Force context compaction immediately",
      CLEAN_HELP_LINE,
      "/context — Show conversation context usage",
      "/model — List or switch inference profile",
      "/models — List all available models",
      "/status — Show conversation status and context usage",
      "/btw — Ask a side question while the assistant is working",
      "/fork — Fork the current conversation into a new branch",
    ];
  }

  return [
    "/commands — List all available commands",
    "/compact — Force context compaction immediately",
    CLEAN_HELP_LINE,
    "/context — Show conversation context usage",
    "/model — List or switch inference profile",
    "/models — List all available models",
    "/status — Show conversation status and context usage",
    "/btw — Ask a side question while the assistant is working",
  ];
}

/**
 * Pure classifier: returns the kind of slash resolution `resolveSlash` would
 * produce for `content`, without triggering any side effects.
 *
 * Queue-drain lookahead (`buildPassthroughBatch`) uses this to decide whether
 * to include a queued message in a contiguous passthrough batch. `resolveSlash`
 * itself may run side effects, so calling it during lookahead and then again
 * in the real drain would execute those side effects twice.
 */
export function classifySlash(
  content: string,
): "passthrough" | "compact" | "clean" | "unknown" {
  const trimmed = content.trim();
  if (parseModelCommand(trimmed) != null) {
    return "unknown";
  }
  const shortcutMatch = trimmed.match(/^\/([a-z0-9-]+)(\s|$)/i);
  if (
    shortcutMatch &&
    DEPRECATED_MODEL_SHORTCUTS.has(shortcutMatch[1].toLowerCase())
  ) {
    return "unknown";
  }
  if (trimmed === "/models") {
    return "unknown";
  }
  const compactParse = parseCompactCommand(trimmed);
  if (compactParse) {
    return compactParse.kind;
  }
  const cleanParse = parseCleanCommand(trimmed);
  if (cleanParse) {
    return cleanParse.kind;
  }
  if (trimmed === "/context") {
    return "unknown";
  }
  if (trimmed === "/status") {
    return "unknown";
  }
  if (trimmed === "/commands") {
    return "unknown";
  }
  return "passthrough";
}

/**
 * Resolve built-in slash commands (/models, /context, /status, /commands,
 * /compact, /clean). Returns `unknown` with a deterministic message,
 * `compact` for forced compaction, `clean` for injection stripping, or the
 * (possibly rewritten) content as `passthrough`.
 */
export async function resolveSlash(
  content: string,
  context?: SlashContext,
): Promise<SlashResolution> {
  // Handle `/model` — list profiles (no arg) or switch active profile.
  const trimmed = content.trim();
  const modelParse = parseModelCommand(trimmed);
  if (modelParse != null) {
    return await resolveModelCommand(modelParse, context?.conversationId);
  }

  // Reject deprecated provider shortcut commands (/opus, /sonnet, /haiku, etc.)
  const shortcutMatch = trimmed.match(/^\/([a-z0-9-]+)(\s|$)/i);
  if (
    shortcutMatch &&
    DEPRECATED_MODEL_SHORTCUTS.has(shortcutMatch[1].toLowerCase())
  ) {
    return {
      kind: "unknown",
      message: `The \`/${shortcutMatch[1]}\` shortcut has been removed. Use **Settings → Models & Services** to change your model and provider.`,
    };
  }

  // Handle /models command (read-only listing)
  if (trimmed === "/models") {
    return await resolveModelList();
  }

  // Handle /compact command (summarize history; takes no arguments).
  const compactParse = parseCompactCommand(trimmed);
  if (compactParse) {
    return compactParse;
  }

  // Handle /clean command (strip injections, no summarization).
  const cleanParse = parseCleanCommand(trimmed);
  if (cleanParse) {
    return cleanParse;
  }

  // Handle /context and legacy /status commands
  if (trimmed === "/context" || trimmed === "/status") {
    if (!context) {
      return {
        kind: "unknown",
        message: "Status information is not available in this context.",
      };
    }
    return resolveStatusCommand(context);
  }

  // Handle /commands command
  if (trimmed === "/commands") {
    return {
      kind: "unknown",
      message: resolveCommandsList(context).join("\n"),
    };
  }

  return { kind: "passthrough", content };
}
