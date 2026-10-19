import { z } from "zod";

/**
 * Per-skill capabilities shared by the assistant daemon and the gateway.
 *
 * A capability is a reviewed behavior the assistant may grant to one skill.
 * It is always bound to the skill content version (the version hash), so a
 * modified skill never inherits the grant for its previous content.
 */
export const SKILL_CAPABILITIES = [
  "host_exec",
  "vetted",
  "input_repairs",
  "computer_use_target",
] as const;

export type SkillCapability = (typeof SKILL_CAPABILITIES)[number];

export const SkillCapabilitySchema = z.enum(SKILL_CAPABILITIES);

/**
 * Resolved capability set for one skill version. Every capability is
 * explicit; a missing capability is false, never "unknown".
 */
export const SkillCapabilitiesSchema = z.object({
  host_exec: z.boolean(),
  vetted: z.boolean(),
  input_repairs: z.boolean(),
  computer_use_target: z.boolean(),
});

export type SkillCapabilities = z.infer<typeof SkillCapabilitiesSchema>;

/** The fail-closed capability set: nothing is granted. */
export const NO_SKILL_CAPABILITIES: SkillCapabilities = Object.freeze({
  host_exec: false,
  vetted: false,
  input_repairs: false,
  computer_use_target: false,
});

/**
 * One bundled skill's default capabilities, bound to the content hash the
 * manifest was generated from.
 */
export const BundledSkillCapabilityDefaultSchema = z.object({
  versionHash: z.string().min(1),
  capabilities: z.array(SkillCapabilitySchema),
});

export type BundledSkillCapabilityDefault = z.infer<
  typeof BundledSkillCapabilityDefaultSchema
>;

/**
 * Build-time manifest of the capabilities bundled skills ship with.
 *
 * The manifest is generated from the bundled skill directories (see
 * `assistant/scripts/generate-skill-capability-defaults.ts`) and is the
 * only source of defaults until a persistent capability store exists. It is
 * scoped to bundled skills: a managed or workspace skill does not inherit
 * an entry, even when it reuses a bundled id.
 */
export const BundledSkillCapabilityDefaultsSchema = z.object({
  version: z.literal(1),
  skills: z.record(z.string(), BundledSkillCapabilityDefaultSchema),
});

export type BundledSkillCapabilityDefaults = z.infer<
  typeof BundledSkillCapabilityDefaultsSchema
>;
