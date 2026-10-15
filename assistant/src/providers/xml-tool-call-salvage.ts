/**
 * Salvage Anthropic-style XML (and DeepSeek DSML) tool calls that some
 * OpenAI-compatible models emit as assistant text instead of native
 * `tool_calls`.
 *
 * Off by default. DeepSeek model ids enable it because those models are
 * trained to emit DSML `invoke` markup and OpenAI-compatible hosts sometimes
 * leave a prefix-stripped variant in `content`. Invokes inside markdown
 * fences stay as text.
 *
 * When markup is detected but a call cannot be mapped to an offered tool (or
 * the block is truncated), a call is still emitted so the executor returns a
 * tool error the model can act on, rather than ending the turn silently while
 * the model waits for a tool result that never arrives.
 */

import { indexOfTag, partialTagSuffix } from "../util/think-tag-stream.js";

const FULLWIDTH_PIPE = "\uFF5C";

/** Tag names that appear inside an XML/DSML tool block. */
const TOOL_TAG_NAME =
  "(?:invoke|parameter|tool_calls|function_calls|minimax:tool_call)";

/**
 * The DSML namespace prefix DeepSeek writes between `<` (or `</`) and the tag
 * name: one or two vertical bars (fullwidth U+FF5C as the model emits it,
 * ASCII `|` in some templates), optionally wrapping the literal `DSML`,
 * optionally followed by spaces. Hosts that strip it leave a bare `<invoke>`.
 */
const DSML_NAMESPACE = "[\\uFF5C|]{1,2}(?:DSML[\\uFF5C|]{0,2})?\\s*";

const DSML_NAMESPACE_RE = new RegExp(
  `([</])\\s*${DSML_NAMESPACE}(?=${TOOL_TAG_NAME}\\b)`,
  "gi",
);

/** Name used when a call is detected but no usable tool name was parsed. */
export const SALVAGE_ERROR_TOOL_NAME = "invalid_tool_call";

/** Openers a streaming scanner holds back so XML tool calls are not shown as
 * text. `<\uFF5C` covers every fullwidth-bar DSML variant; the ASCII forms are
 * listed explicitly. */
export const XML_TOOL_CALL_OPEN_TAGS = [
  "<invoke",
  "<function_calls",
  "<minimax:tool_call",
  `<${FULLWIDTH_PIPE}`,
  "<|DSML|",
  "<||DSML||",
] as const;

export interface SalvagedXmlToolCall {
  name: string;
  input: Record<string, unknown>;
}

export interface XmlToolCallSalvage {
  /** Assistant text with salvaged invoke blocks removed. */
  text: string;
  calls: SalvagedXmlToolCall[];
}

const INVOKE_CLOSE = "</invoke>";
const NAME_ATTR_RE = /\bname\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s>]+))/i;
const STRING_ATTR_RE = /\bstring\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s>]+))/i;
const PARAMETER_CLOSE = "</parameter>";

const WRAPPER_OPEN_RE =
  /<(?:function_calls|tool_calls|minimax:tool_call)\b[^>]*>/i;

/**
 * True when `text` begins with a DSML-namespaced opener (a fullwidth or ASCII
 * bar right after `<`). Used to drop leaked DSML control markup when native
 * `tool_calls` already arrived, while leaving bare `<invoke>` XML as text.
 */
export function isDsmlToolMarkup(text: string): boolean {
  return /^<[\uFF5C|]/.test(text);
}

/** True when the model id is a DeepSeek variant that leaks XML tool calls. */
export function shouldSalvageXmlToolCalls(
  model: string | null | undefined,
): boolean {
  return typeof model === "string" && /deepseek/i.test(model);
}

export function salvageXmlToolCalls(
  text: string,
  offeredToolNames: ReadonlySet<string>,
): XmlToolCallSalvage | null {
  if (!text || offeredToolNames.size === 0) {
    return null;
  }

  // Rewrite DSML namespace prefixes to bare tags so the scanners below match
  // every dialect (V3.2 `function_calls`, V4 `tool_calls`, single/double bars).
  const normalized = text.replace(DSML_NAMESPACE_RE, "$1");

  const spans: Array<{
    start: number;
    end: number;
    call: SalvagedXmlToolCall;
  }> = [];
  let detected = false;

  const invokeOpenRe = /<invoke\b[^>]*>/gi;
  let openMatch: RegExpExecArray | null = invokeOpenRe.exec(normalized);
  while (openMatch) {
    const openTag = openMatch[0];
    const bodyStart = openMatch.index + openTag.length;
    const closeIdx = normalized.indexOf(INVOKE_CLOSE, bodyStart);
    const nextOpen = normalized.indexOf("<invoke", bodyStart);

    let bodyEnd: number;
    let spanEnd: number;
    if (closeIdx >= 0) {
      bodyEnd = closeIdx;
      spanEnd = closeIdx + INVOKE_CLOSE.length;
    } else if (nextOpen >= 0) {
      bodyEnd = nextOpen;
      spanEnd = nextOpen;
    } else {
      bodyEnd = normalized.length;
      spanEnd = normalized.length;
    }

    if (!isInsideMarkdownFence(normalized, openMatch.index)) {
      detected = true;
      const rawName = parseNameAttr(openTag);
      const canonicalName = rawName
        ? resolveOfferedName(rawName, offeredToolNames)
        : null;
      if (closeIdx >= 0) {
        spans.push({
          start: openMatch.index,
          end: spanEnd,
          call: {
            name: canonicalName ?? rawName ?? SALVAGE_ERROR_TOOL_NAME,
            input: parseParameters(normalized.slice(bodyStart, bodyEnd)),
          },
        });
      } else {
        // Truncated block: do not run the intended tool with partial args.
        // Emit an error-name call so the executor tells the model to retry.
        spans.push({
          start: openMatch.index,
          end: spanEnd,
          call: { name: SALVAGE_ERROR_TOOL_NAME, input: {} },
        });
      }
    }

    invokeOpenRe.lastIndex =
      spanEnd > openMatch.index + openTag.length ? spanEnd : bodyStart;
    openMatch = invokeOpenRe.exec(normalized);
  }

  if (spans.length === 0) {
    // A wrapper with no parseable invoke, outside a fence: force an
    // error-result call so the turn does not end silently.
    const wrapper = WRAPPER_OPEN_RE.exec(normalized);
    if (wrapper && !isInsideMarkdownFence(normalized, wrapper.index)) {
      return {
        text: stripAllToolMarkup(normalized),
        calls: [{ name: SALVAGE_ERROR_TOOL_NAME, input: {} }],
      };
    }
    return null;
  }

  let leftover = "";
  let cursor = 0;
  for (const span of spans) {
    leftover += normalized.slice(cursor, span.start);
    cursor = span.end;
  }
  leftover += normalized.slice(cursor);
  leftover = cleanupLeftover(leftover);

  return {
    text: leftover,
    calls: spans.map((span) => span.call),
  };
}

/**
 * Split streamed text so a complete or in-progress XML tool-call opener is
 * held back rather than shown as user-visible content.
 */
export function splitXmlToolCallHoldback(buffer: string): {
  visible: string;
  held: string;
} {
  if (!buffer) {
    return { visible: "", held: "" };
  }
  const hit = indexOfTag(buffer, XML_TOOL_CALL_OPEN_TAGS, false);
  if (hit) {
    return {
      visible: buffer.slice(0, hit.index),
      held: buffer.slice(hit.index),
    };
  }
  const partial = partialTagSuffix(buffer, XML_TOOL_CALL_OPEN_TAGS, false);
  if (partial > 0) {
    return {
      visible: buffer.slice(0, buffer.length - partial),
      held: buffer.slice(buffer.length - partial),
    };
  }
  return { visible: buffer, held: "" };
}

function parseNameAttr(tag: string): string | null {
  const match = NAME_ATTR_RE.exec(tag);
  if (!match) {
    return null;
  }
  const name = match[1] ?? match[2] ?? match[3];
  return name && name.length > 0 ? name : null;
}

function parseStringAttr(tag: string): string | null {
  const match = STRING_ATTR_RE.exec(tag);
  if (!match) {
    return null;
  }
  return match[1] ?? match[2] ?? match[3] ?? "";
}

function resolveOfferedName(
  name: string,
  offeredToolNames: ReadonlySet<string>,
): string | null {
  if (offeredToolNames.has(name)) {
    return name;
  }
  const lower = name.toLowerCase();
  for (const offered of offeredToolNames) {
    if (offered.toLowerCase() === lower) {
      return offered;
    }
  }
  return null;
}

function parseParameters(body: string): Record<string, unknown> {
  const input: Record<string, unknown> = {};
  const parameterOpenRe = /<parameter\b[^>]*>/gi;
  let paramMatch: RegExpExecArray | null = parameterOpenRe.exec(body);
  while (paramMatch) {
    const openTag = paramMatch[0];
    const paramName = parseNameAttr(openTag);
    const stringAttr = parseStringAttr(openTag);
    const valueStart = paramMatch.index + openTag.length;
    const closeIdx = body.indexOf(PARAMETER_CLOSE, valueStart);
    if (closeIdx < 0) {
      break;
    }
    if (paramName) {
      input[paramName] = parseParamValue(
        decodeXmlEntities(body.slice(valueStart, closeIdx)),
        stringAttr,
      );
    }
    parameterOpenRe.lastIndex = closeIdx + PARAMETER_CLOSE.length;
    paramMatch = parameterOpenRe.exec(body);
  }
  return input;
}

function parseParamValue(raw: string, stringAttr: string | null): unknown {
  // DSML types scalars explicitly: string="false" means a JSON-encoded number,
  // boolean, array, or object; string="true" (or no attribute) means a literal
  // string. The bare Anthropic-style form carries no attribute, so fall back to
  // the legacy best-effort JSON parse.
  if (stringAttr !== null && stringAttr.toLowerCase() !== "false") {
    return raw;
  }
  try {
    return JSON.parse(raw);
  } catch {
    return raw;
  }
}

function decodeXmlEntities(value: string): string {
  return value
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&amp;/g, "&");
}

/** Remove wrapper envelopes that survive once invoke bodies are stripped. */
function cleanupLeftover(value: string): string {
  return value
    .replace(
      /<(?:function_calls|tool_calls|minimax:tool_call)>\s*<\/(?:function_calls|tool_calls|minimax:tool_call)>/gi,
      "",
    )
    .replace(
      /<\/?(?:function_calls|tool_calls|minimax:tool_call)\b[^>]*>/gi,
      "",
    )
    .trim();
}

/** Strip every tool-markup tag; used when no call could be parsed. */
function stripAllToolMarkup(value: string): string {
  return value
    .replace(
      /<\/?(?:function_calls|tool_calls|minimax:tool_call)\b[^>]*>/gi,
      "",
    )
    .replace(/<\/?parameter\b[^>]*>/gi, "")
    .replace(/<\/?invoke\b[^>]*>/gi, "")
    .trim();
}

function isInsideMarkdownFence(text: string, index: number): boolean {
  let inside = false;
  let searchFrom = 0;
  while (searchFrom < index) {
    const next = text.indexOf("```", searchFrom);
    if (next < 0 || next >= index) {
      break;
    }
    inside = !inside;
    searchFrom = next + 3;
  }
  return inside;
}
