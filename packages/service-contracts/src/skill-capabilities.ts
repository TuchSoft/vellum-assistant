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
