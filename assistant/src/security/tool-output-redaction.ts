/**
 * Tool-output redaction: the single pass every tool result crosses before it
 * reaches the model. Two stages, one unified marker:
 *
 * 1. Format-based scanner pass (gitleaks/detect-secrets-derived patterns).
 *    Every known-format secret is intercepted here, with a prefix derived
 *    from the matched pattern's literal head or the value's own separator.
 *    Vault membership of the matched value is checked so a stored credential
 *    that has a known shape still names its service/field.
 * 2. Exact vault-credential match for the remainder. Opaque tokens with no
 *    recognizable prefix (e.g. an "opapi_..." key private to this vault)
 *    would otherwise sail through the scanner, so stored credential values
 *    are matched literally.
 *
 * Every redaction emits the same attribute set so the model can correlate
 * tokens across outputs (are two files mentioning the same key?) without
 * ever seeing a value:
 *
 * - type: what kind of secret was matched.
 * - credential (vault matches only): the service/field owning the value.
 * - prefix: identifying head of the value (pattern head, separator-
 *   terminated segment, or fallback run), never more than 30% of the value.
 * - suffix (only when budget remains after the prefix): tail characters,
 *   at most 4, also inside the same 30% budget.
 * - length: the full character count of the value.
 * - hash: the first 8 hex chars of the value's md5. Identity correlation,
 *   not a security boundary: high-entropy values are not recoverable from
 *   a truncated hash, and a collision only makes two different tokens look
 *   alike, never leaks one.
 *
 * The caller (the tool executor) owns the skip decisions: a user-level
 * environment kill switch and the consent-gated unredacted flag.
 */

import { createHash } from "node:crypto";

import {
  REDACTION_PREFIX_PATTERNS,
  type SecretPrefixPattern,
} from "./secret-patterns.js";
import { redactSecretsWith } from "./secret-scanner.js";
import { getVaultSnapshot } from "./vault-secret-registry.js";

export interface ToolOutputRedactionResult {
  text: string;
  /** Total number of redacted spans (vault + scanner). */
  redactedCount: number;
  /** Distinct vault credentials redacted. */
  vaultCount: number;
}

/** Fallback prefix length when no pattern head or separator identifies the value. */
const FALLBACK_PREFIX_LENGTH = 5;

/** Window (chars from the start) in which a separator terminates the prefix. */
const SEPARATOR_WINDOW = 7;

/** Maximum suffix characters, drawn from the budget left after the prefix. */
const MAX_SUFFIX_LENGTH = 4;

/** Maximum share of the value shown across prefix + suffix (0-1). */
const MAX_REVEALED_FRACTION = 0.3;

/** Minimum extracted pattern head worth using over the value heuristics. */
const MIN_PATTERN_HEAD = 3;

/** Hex characters of the md5 digest shown in the marker. */
const HASH_LENGTH = 8;

function valueHash(value: string): string {
  return createHash("md5")
    .update(value, "utf8")
    .digest("hex")
    .slice(0, HASH_LENGTH);
}

/**
 * Extract the leading literal run of a scanner pattern (e.g. "AKIA" from
 * `/AKIA[0-9A-Z]{16}/`, "sk-ant-" from `/sk-ant-[A-Za-z0-9\-_]{80,}/`).
 * Returns "" when the pattern starts with a class or group. Value-based
 * heuristics handle patterns whose variability starts early (e.g.
 * `gh[pousr]_`, where the value's own separator gives "ghp_").
 */
function extractPatternHead(pattern: RegExp): string {
  const source = pattern.source;
  let head = "";
  for (let i = 0; i < source.length; i++) {
    const ch = source[i];
    if (ch === "\\") {
      // Only literal escapes extend the head; classes/anchors/groups end it.
      const next = source[i + 1];
      if (next === undefined || !/[\\/_\-.]/.test(next)) {
        break;
      }
      head += next;
      i += 1;
      continue;
    }
    if (/[[().^$*+?{|]/.test(ch)) {
      break;
    }
    head += ch;
  }
  return head;
}

const PATTERN_HEADS = new Map<string, string>();
for (const p of REDACTION_PREFIX_PATTERNS as SecretPrefixPattern[]) {
  PATTERN_HEADS.set(p.label, extractPatternHead(p.regex));
}

function patternHeadFor(label: string, value: string): string | undefined {
  const head = PATTERN_HEADS.get(label);
  if (head !== undefined && head.length >= MIN_PATTERN_HEAD) {
    if (value.startsWith(head)) {
      return head;
    }
  }
  return undefined;
}

/**
 * Pick the identifying prefix of a value:
 * 1. Armored blocks (PEM): the full "-----BEGIN ...-----" header line.
 * 2. The matched pattern's literal head, when it prefixes the value.
 * 3. The value's own segment up to and including the first "_" or "-" within
 *    the first SEPARATOR_WINDOW chars (e.g. "opapi_", "ghp_", "sk-").
 * 4. A fallback run of FALLBACK_PREFIX_LENGTH chars.
 */
function pickPrefixCandidate(value: string, typeLabel: string): string {
  if (value.startsWith("-----BEGIN ") && value.includes("\n")) {
    const firstLine = value.slice(0, value.indexOf("\n"));
    if (firstLine.length > 0) {
      return firstLine;
    }
  }
  const head = patternHeadFor(typeLabel, value);
  if (head !== undefined) {
    return head;
  }
  const windowEnd = Math.min(SEPARATOR_WINDOW, value.length);
  const window = value.slice(0, windowEnd);
  const sepIndex = window.search(/[_-]/);
  if (sepIndex >= 0) {
    return value.slice(0, sepIndex + 1);
  }
  return value.slice(0, FALLBACK_PREFIX_LENGTH);
}

/**
 * Total characters of the value that may appear across prefix + suffix.
 * Floored so the revealed share never exceeds MAX_REVEALED_FRACTION.
 */
function revealBudget(valueLength: number): number {
  return Math.max(1, Math.floor(valueLength * MAX_REVEALED_FRACTION));
}

function buildMarker(
  type: string,
  value: string,
  typeLabel: string,
  credentialRef?: string,
): string {
  const budget = revealBudget(value.length);
  const prefixLength = Math.min(
    pickPrefixCandidate(value, typeLabel).length,
    budget,
  );
  const prefix = value.slice(0, prefixLength);
  const suffixLength = Math.min(
    MAX_SUFFIX_LENGTH,
    Math.max(0, budget - prefixLength),
  );
  const attrs = [`type="${type}"`];
  if (credentialRef !== undefined) {
    attrs.push(`credential="${credentialRef}"`);
  }
  attrs.push(`prefix="${prefix}…"`);
  if (suffixLength > 0) {
    const suffix = value.slice(value.length - suffixLength);
    attrs.push(`suffix="…${suffix}"`);
  }
  attrs.push(`length="${value.length}"`);
  attrs.push(`hash="${valueHash(value)}"`);
  return `<redacted ${attrs.join(" ")} />`;
}

export function redactToolOutput(text: string): ToolOutputRedactionResult {
  let redactedCount = 0;
  const vaultCredentials = new Set<string>();
  let working = text;

  const snapshot = getVaultSnapshot();

  // Stage 1: known formats. The scanner callback also checks vault
  // membership so a stored credential with a known shape still names its
  // service/field.
  working = redactSecretsWith(working, (match, rawValue) => {
    redactedCount += 1;
    const vault = snapshot?.get(rawValue);
    if (vault) {
      vaultCredentials.add(rawValue);
    }
    const ref =
      vault?.service !== undefined && vault?.field !== undefined
        ? `${vault.service}/${vault.field}`
        : vault?.account;
    return buildMarker(match.type, rawValue, match.type, ref);
  });

  // Stage 2: opaque stored credentials the scanner cannot see.
  if (snapshot) {
    for (const [value, info] of snapshot) {
      if (!working.includes(value)) {
        continue;
      }
      const ref =
        info.service !== undefined && info.field !== undefined
          ? `${info.service}/${info.field}`
          : info.account;
      const occurrences = working.split(value).length - 1;
      working = working
        .split(value)
        .join(
          buildMarker("Vault Credential", value, "Vault Credential", ref),
        );
      redactedCount += occurrences;
      vaultCredentials.add(value);
    }
  }

  return { text: working, redactedCount, vaultCount: vaultCredentials.size };
}
