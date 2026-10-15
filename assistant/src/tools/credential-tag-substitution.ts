/**
 * Credential tag substitution: one unified way for the model to USE a
 * credential without ever reading it. The model writes
 * `<vellum-credential service="..." field="..." />` anywhere in any tool
 * input; the executor substitutes it right before `tool.execute()`, on a
 * transient copy, so the transcript, audit rows, and risk classification
 * only ever record the tag form.
 *
 * Two substitution modes:
 *
 * - bash-rewrite (bash / host_bash): the tag becomes a wrapper command
 *   substitution, `$(assistant credentials reveal --headless --service
 *   <service> --field <field>)`. The shell-side wrapper owns trace
 *   minimization; the daemon never handles the plaintext value on this path.
 * - inline (every other tool): the daemon resolves the credential and
 *   substitutes the plaintext value into the transient input copy. This
 *   intentionally hands the value to the tool (a file write, an MCP
 *   argument) while every log and record stays on the tag form.
 *
 * v1 policy: the tag is allowed from any tool. The per-credential
 * allowedTools gate remains enforced on the legacy proxied-bash path only.
 *
 * Resolution failures are collected into one error; a tool call either
 * runs with every tag substituted or not at all.
 */

import { getSecureKeyResultAsync } from "../security/secure-keys.js";
import { getLogger } from "../util/logger.js";
import { resolveCredentialRef } from "./credentials/resolve.js";

const log = getLogger("credential-tag-substitution");

export type CredentialSubstitutionMode = "bash-rewrite" | "inline";

export interface CredentialSubstitution {
  service: string;
  field: string;
  mode: CredentialSubstitutionMode;
}

export type CredentialSubstitutionResult =
  | {
      ok: true;
      input: Record<string, unknown>;
      substitutions: CredentialSubstitution[];
    }
  | { ok: false; error: string };

const TAG_RE =
  /<vellum-credential\s+service="([^"]+)"\s+field="([^"]+)"\s*\/>/g;

/**
 * Service/field names are embedded into a shell command substitution on the
 * bash path, so only names that cannot break out of the substitution are
 * accepted. The same rule applies on the inline path to keep one vocabulary.
 */
const SAFE_NAME_SEGMENT = /^[A-Za-z0-9_.-]+$/;

export function hasCredentialTag(value: unknown): boolean {
  TAG_RE.lastIndex = 0;
  if (typeof value === "string") {
    return TAG_RE.test(value);
  }
  if (Array.isArray(value)) {
    return value.some((item) => hasCredentialTag(item));
  }
  if (value !== null && typeof value === "object") {
    return Object.values(value).some((item) => hasCredentialTag(item));
  }
  return false;
}

interface CollectedTag {
  service: string;
  field: string;
}

function collectTags(value: unknown, into: Map<string, CollectedTag>): void {
  if (typeof value === "string") {
    TAG_RE.lastIndex = 0;
    let match: RegExpExecArray | null;
    while ((match = TAG_RE.exec(value)) !== null) {
      const key = `${match[1]}/${match[2]}`;
      if (!into.has(key)) {
        into.set(key, { service: match[1], field: match[2] });
      }
    }
    return;
  }
  if (Array.isArray(value)) {
    for (const item of value) {
      collectTags(item, into);
    }
    return;
  }
  if (value !== null && typeof value === "object") {
    for (const item of Object.values(value)) {
      collectTags(item, into);
    }
  }
}

function substituteStrings(
  value: unknown,
  replacements: ReadonlyMap<string, string>,
): unknown {
  if (typeof value === "string") {
    if (!value.includes("<vellum-credential")) {
      return value;
    }
    TAG_RE.lastIndex = 0;
    return value.replace(
      TAG_RE,
      (whole, service: string, field: string) =>
        replacements.get(`${service}/${field}`) ?? whole,
    );
  }
  if (Array.isArray(value)) {
    return value.map((item) => substituteStrings(item, replacements));
  }
  if (value !== null && typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const [key, item] of Object.entries(value)) {
      out[key] = substituteStrings(item, replacements);
    }
    return out;
  }
  return value;
}

/**
 * Replace every `<vellum-credential ... />` tag in the input with either a
 * wrapper reveal call (bash-rewrite) or the resolved plaintext (inline).
 * Returns a transient copy; the caller's input is never mutated and stays
 * the only form recorded to audit and transcript.
 */
export async function substituteCredentialTags(
  toolName: string,
  input: Record<string, unknown>,
  mode: CredentialSubstitutionMode,
): Promise<CredentialSubstitutionResult> {
  const tags = new Map<string, CollectedTag>();
  collectTags(input, tags);
  if (tags.size === 0) {
    return { ok: true, input, substitutions: [] };
  }

  const errors: string[] = [];
  const replacements = new Map<string, string>();
  const substitutions: CredentialSubstitution[] = [];

  for (const [key, tag] of tags) {
    if (
      !SAFE_NAME_SEGMENT.test(tag.service) ||
      !SAFE_NAME_SEGMENT.test(tag.field)
    ) {
      errors.push(
        `${key}: service and field may only contain letters, digits, dot, underscore, and hyphen`,
      );
      continue;
    }
    const resolved = resolveCredentialRef(key);
    if (!resolved) {
      errors.push(
        `${key}: unknown credential. Use \`assistant credentials list\` to see available credentials.`,
      );
      continue;
    }
    if (mode === "bash-rewrite") {
      replacements.set(
        key,
        `$(assistant credentials reveal --headless --service ${tag.service} --field ${tag.field})`,
      );
      substitutions.push({ service: tag.service, field: tag.field, mode });
      continue;
    }
    const { value } = await getSecureKeyResultAsync(resolved.storageKey);
    if (value == null || value.length === 0) {
      errors.push(`${key}: credential store returned no value`);
      continue;
    }
    replacements.set(key, value);
    substitutions.push({ service: tag.service, field: tag.field, mode });
  }

  if (errors.length > 0) {
    return {
      ok: false,
      error: `Error: credential tag substitution failed: ${errors.join("; ")}`,
    };
  }

  // Guard against a substituted value itself carrying a tag (chained
  // reveal): any tag still present after the pass was introduced by a
  // substituted value, so fail closed instead of resolving it.
  const substituted = substituteStrings(input, replacements) as Record<
    string,
    unknown
  >;
  if (hasCredentialTag(substituted)) {
    return {
      ok: false,
      error:
        "Error: credential tag substitution failed: a substituted credential value contains a credential tag",
    };
  }
  log.info(
    {
      toolName,
      substitutions: substitutions.map((s) => `${s.service}/${s.field}`),
      mode,
    },
    "Credential tag substituted",
  );
  return { ok: true, input: substituted, substitutions };
}
