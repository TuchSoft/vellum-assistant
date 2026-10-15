/**
 * One forced-tool call that returns a short label: a conversation title, a
 * background task name, anything a small fast model should name in a few
 * words. Forcing the tool is what keeps a weak model from thinking aloud or
 * replying to the content instead of naming it; `normalizeTitle` is the
 * backstop for a provider that ignores `tool_choice` and answers in prose.
 * Resolves to "" when the model declines or misbehaves, so every caller keeps
 * a deterministic fallback of its own. Rejects on abort or timeout.
 */

import type { LLMCallSite } from "../config/schemas/llm.js";
import { normalizeTitle } from "../util/short-title.js";
import {
  createTimeout,
  extractAllText,
  extractToolUse,
  userMessage,
} from "./provider-send-message.js";
import type { Provider, ProviderResponse, ToolDefinition } from "./types.js";

export interface ShortLabelTool {
  name: string;
  description: string;
  /** The single string argument the model fills in. */
  argument: string;
  argumentDescription: string;
  /** Optional extra arguments the model may fill in (never required). */
  optionalArguments?: Array<{
    name: string;
    description: string;
    /** JSON-schema scalar type; defaults to "string". */
    type?: "string" | "number";
  }>;
}

export function buildShortLabelTool(tool: ShortLabelTool): ToolDefinition {
  const properties: Record<string, unknown> = {
    [tool.argument]: {
      type: "string",
      description: tool.argumentDescription,
    },
  };
  for (const extra of tool.optionalArguments ?? []) {
    properties[extra.name] = {
      type: extra.type ?? "string",
      description: extra.description,
    };
  }
  return {
    name: tool.name,
    description: tool.description,
    input_schema: {
      type: "object",
      properties,
      required: [tool.argument],
    },
  };
}

/**
 * Like {@link requestShortLabel}, but returns every declared argument the
 * model filled in, keyed by argument name. Only args declared on the tool
 * (the required one plus any `optionalArguments`) are returned; undeclared
 * values are dropped, and a value is kept only when it matches the argument's
 * declared type ("string" or "number"). The required argument is still passed
 * through `normalizeTitle`; extras are returned verbatim for the caller to
 * validate. Resolves to `{}` when the model declines or misbehaves.
 */
export async function requestStructuredLabel(args: {
  provider: Provider;
  callSite: LLMCallSite;
  conversationId?: string;
  systemPrompt: string;
  prompt: string;
  tool: ShortLabelTool;
  timeoutMs: number;
  maxTokens: number;
  signal?: AbortSignal;
}): Promise<Record<string, string | number>> {
  const { signal: timeoutSignal, cleanup } = createTimeout(args.timeoutMs);
  const combinedSignal = args.signal
    ? AbortSignal.any([args.signal, timeoutSignal])
    : timeoutSignal;
  try {
    const response = await args.provider.sendMessage(
      [userMessage(args.prompt)],
      {
        tools: [buildShortLabelTool(args.tool)],
        systemPrompt: args.systemPrompt,
        config: {
          max_tokens: args.maxTokens,
          callSite: args.callSite,
          ...(args.conversationId !== undefined
            ? { conversationId: args.conversationId }
            : {}),
          tool_choice: { type: "tool", name: args.tool.name },
          disableCache: true,
        },
        signal: combinedSignal,
      },
    );
    return structuredLabelFromResponse(response, args.tool);
  } finally {
    cleanup();
  }
}

export async function requestShortLabel(args: {
  provider: Provider;
  callSite: LLMCallSite;
  conversationId?: string;
  systemPrompt: string;
  prompt: string;
  tool: ShortLabelTool;
  timeoutMs: number;
  maxTokens: number;
  signal?: AbortSignal;
}): Promise<string> {
  const result = await requestStructuredLabel(args);
  const value = result[args.tool.argument];
  return typeof value === "string" ? value : "";
}

/** Extract and validate the declared tool arguments from a provider response. */
function structuredLabelFromResponse(
  response: ProviderResponse,
  tool: ShortLabelTool,
): Record<string, string | number> {
  const toolBlock = extractToolUse(response);
  const input = toolBlock?.input as Record<string, unknown> | undefined;
  if (toolBlock?.name === tool.name && input) {
    const declared = new Set([
      tool.argument,
      ...(tool.optionalArguments ?? []).map((extra) => extra.name),
    ]);
    const out: Record<string, string | number> = {};
    for (const [key, value] of Object.entries(input)) {
      if (!declared.has(key) || value === null || value === undefined) {
        continue;
      }
      const type =
        tool.optionalArguments?.find((extra) => extra.name === key)?.type ??
        "string";
      if (type === "number") {
        if (typeof value === "number" && Number.isFinite(value)) {
          out[key] = value;
        }
        continue;
      }
      if (typeof value === "string" && value.trim()) {
        out[key] = value.trim();
      }
    }
    const required = out[tool.argument];
    if (typeof required === "string" && required) {
      out[tool.argument] = normalizeTitle(required);
    }
    return out;
  }
  // The provider ignored the forced tool, or the model answered in prose.
  // `normalizeTitle`'s prose guard rejects a ramble while keeping a compliant
  // plain-text label.
  const label = normalizeTitle(extractAllText(response));
  return label ? { [tool.argument]: label } : {};
}
