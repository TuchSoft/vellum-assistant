/**
 * Default skill capability grants, read from the gateway security volume.
 *
 * The defaults are the gateway's own policy document, not something the
 * assistant ships: `skill-grant-defaults.json` in `GATEWAY_SECURITY_DIR` maps a
 * skill id to the capabilities a fresh version of it starts with. The seed
 * (`skill-grant-seed.ts`) applies them to versions the assistant declares, so a
 * new skill version never needs a human in the loop to keep working, and a
 * capability the operator removes from the file stops being seeded from the
 * next declaration onward.
 *
 * The shipped document below mirrors the capability manifest that existed
 * before grants moved to the gateway, so deploying the gate changes nothing
 * observable. It is materialized into the security volume on first read, after
 * which the file is authoritative: edits are picked up by mtime, and the
 * gateway never overwrites an existing file.
 *
 * A missing, unreadable, or invalid document resolves to no defaults. That
 * direction matters: defaults only ever create a grant for content the operator
 * listed, so a broken document leaves every capability denied.
 */

import { existsSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { SkillCapabilitySchema } from "@vellumai/service-contracts/skill-capabilities";
import { z } from "zod";

import { getLogger } from "../logger.js";
import { getGatewaySecurityDir } from "../paths.js";

const log = getLogger("skill-grant-defaults");

/** File name of the defaults document inside the gateway security volume. */
export const SKILL_GRANT_DEFAULTS_FILENAME = "skill-grant-defaults.json";

/**
 * Shipped defaults: one entry per skill that carried capabilities in the
 * pre-grant manifest. Skills absent from this map are never seeded, which is
 * how a newly installed skill stays denied until someone grants it.
 */
export const BUILTIN_SKILL_GRANT_DEFAULTS: Readonly<
  Record<string, readonly z.infer<typeof SkillCapabilitySchema>[]>
> = Object.freeze({
  acp: ["host_exec", "vetted", "input_repairs"],
  "app-builder": ["host_exec", "vetted", "input_repairs"],
  "app-control": ["host_exec", "vetted", "input_repairs"],
  "computer-use": [
    "host_exec",
    "vetted",
    "input_repairs",
    "computer_use_target",
  ],
  contacts: ["host_exec", "vetted", "input_repairs"],
  "conversation-groups": ["host_exec", "vetted", "input_repairs"],
  "document-editor": ["host_exec", "vetted", "input_repairs"],
  followups: ["host_exec", "vetted", "input_repairs"],
  "image-studio": ["host_exec", "vetted", "input_repairs"],
  "long-run": ["host_exec", "vetted", "input_repairs"],
  "media-processing": ["host_exec", "vetted", "input_repairs"],
  messaging: ["host_exec", "vetted", "input_repairs"],
  "phone-calls": ["host_exec", "vetted", "input_repairs"],
  playbooks: ["host_exec", "vetted", "input_repairs"],
  schedule: ["host_exec", "vetted", "input_repairs"],
  "screen-annotation": ["host_exec", "vetted", "input_repairs"],
  sequences: ["host_exec", "vetted", "input_repairs"],
  settings: ["host_exec", "vetted", "input_repairs"],
  "skill-management": ["host_exec", "vetted", "input_repairs"],
  subagent: ["host_exec", "vetted", "input_repairs"],
  "system-storage-cleanup": ["vetted", "input_repairs"],
  transcribe: ["host_exec", "vetted", "input_repairs"],
  visualize: ["vetted", "input_repairs"],
  workflows: ["host_exec", "vetted", "input_repairs"],
});

/**
 * Skill ids are directory basenames. Separators are rejected so an id can never
 * address a path outside the skills directory.
 */
export const skillIdSchema = z
  .string()
  .trim()
  .min(1)
  .max(200)
  .refine((value) => !value.includes("/") && !value.includes("\\"), {
    message: "skillId must not contain a path separator",
  });

/** A skill content version, as computed by the assistant from disk. */
export const versionHashSchema = z.string().trim().min(1).max(200);

const SkillGrantDefaultsSchema = z.record(
  z.string(),
  z.array(SkillCapabilitySchema),
);

export type SkillGrantDefaults = Record<
  string,
  z.infer<typeof SkillCapabilitySchema>[]
>;

/** The defaults document path inside the gateway security volume. */
export function getSkillGrantDefaultsPath(): string {
  return join(getGatewaySecurityDir(), SKILL_GRANT_DEFAULTS_FILENAME);
}

interface CachedDefaults {
  defaults: SkillGrantDefaults;
  mtimeMs: number;
  size: number;
}

let cache: CachedDefaults | null = null;

/**
 * Write the shipped defaults into the security volume when the document is
 * absent. Never overwrites: an existing file is the operator's, even when it is
 * empty or unreadable.
 *
 * A failure here is not fatal. The read path that follows reports the same
 * condition (no defaults), so a read-only or unwritable volume degrades to
 * "nothing is seeded" instead of failing startup.
 */
function materializeDefaultsDocument(path: string): void {
  if (existsSync(path)) {
    return;
  }
  try {
    writeFileSync(
      path,
      `${JSON.stringify(BUILTIN_SKILL_GRANT_DEFAULTS, null, 2)}\n`,
      {
        encoding: "utf-8",
        mode: 0o600,
      },
    );
    log.info(
      { path, skills: Object.keys(BUILTIN_SKILL_GRANT_DEFAULTS).length },
      "Wrote the shipped skill grant defaults into the gateway security volume",
    );
  } catch (err) {
    log.warn(
      { err, path },
      "Could not materialize the skill grant defaults; no default will be seeded",
    );
  }
}

function parseDefaults(raw: string, path: string): SkillGrantDefaults {
  let decoded: unknown;
  try {
    decoded = JSON.parse(raw);
  } catch (err) {
    log.warn(
      { err, path },
      "Skill grant defaults are not valid JSON; ignoring",
    );
    return {};
  }

  const parsed = SkillGrantDefaultsSchema.safeParse(decoded);
  if (!parsed.success) {
    log.warn(
      { path, issues: parsed.error.issues },
      "Skill grant defaults do not match the document shape; ignoring",
    );
    return {};
  }

  // The record value shape is validated above; the keys are validated here so
  // one malformed id drops that entry instead of discarding the document.
  const defaults: SkillGrantDefaults = {};
  for (const [skillId, capabilities] of Object.entries(parsed.data)) {
    const parsedId = skillIdSchema.safeParse(skillId);
    if (!parsedId.success) {
      log.warn(
        { path, skillId },
        "Skill grant defaults entry has an invalid skill id; skipping it",
      );
      continue;
    }
    defaults[parsedId.data] = capabilities;
  }
  return defaults;
}

/**
 * The defaults currently on disk, re-read whenever the document changes.
 *
 * An unreadable document resolves to no defaults rather than throwing, so the
 * seed can always run: the fail-closed outcome is "nothing is granted", which
 * is exactly what an absent policy means.
 */
export function loadSkillGrantDefaults(): SkillGrantDefaults {
  const path = getSkillGrantDefaultsPath();
  materializeDefaultsDocument(path);

  let mtimeMs: number;
  let size: number;
  try {
    const stat = statSync(path);
    mtimeMs = stat.mtimeMs;
    size = stat.size;
  } catch (err) {
    log.warn({ err, path }, "Skill grant defaults are unreadable; ignoring");
    cache = null;
    return {};
  }

  if (cache && cache.mtimeMs === mtimeMs && cache.size === size) {
    return cache.defaults;
  }

  let raw: string;
  try {
    raw = readFileSync(path, "utf-8");
  } catch (err) {
    log.warn({ err, path }, "Skill grant defaults are unreadable; ignoring");
    cache = null;
    return {};
  }

  const defaults = parseDefaults(raw, path);
  cache = { defaults, mtimeMs, size };
  log.info(
    { path, skills: Object.keys(defaults).length },
    "Loaded skill grant defaults",
  );
  return defaults;
}

/** @internal Test-only: drop the memoized document. */
export function _resetSkillGrantDefaultsCacheForTest(): void {
  cache = null;
}
