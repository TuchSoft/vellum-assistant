import type { AssistantConfig } from "./schema.js";

/**
 * Whether memory as a whole is on — the user-facing master switch. Memory is
 * on unless `memory.enabled` is explicitly set to `false`. Canonical home for
 * the check; the config-singleton `isMemoryEnabled()` in
 * `persistence/jobs-store.ts` delegates here. Accepts any object carrying the
 * `memory` slice, so callers holding only the plugin-resolved slice (e.g. the
 * memory plugin's `getMemoryConfig()`) can gate without the full config.
 */
export function isMemoryEnabled(
  config: Pick<AssistantConfig, "memory">,
): boolean {
  return config.memory?.enabled !== false;
}

/**
 * Whether the legacy graph/PKB memory engine (tier v1) is the live tier.
 * Kept for the v1 retirement surface: with the concept-page substrate active
 * whenever memory is on, this is never true, and every v1 path stays inert.
 *
 * Like {@link isMemoryEnabled}, accepts a `memory`-slice view.
 */
export function isMemoryV1Active(
  config: Pick<AssistantConfig, "memory">,
): boolean {
  return isMemoryEnabled(config) && !usesConceptPageMemory(config.memory);
}

/**
 * Whether memory-v3 is the live injected memory source for this assistant,
 * gated by workspace config (`memory.v3.live`): new assistants are switched on
 * at creation via a workspace migration.
 */
export function isMemoryV3Live(config: AssistantConfig): boolean {
  return config.memory?.v3?.live === true;
}

/**
 * Whether memory-v3 is the live TIER: v3 is the live injected source AND
 * memory as a whole is on. Exactly `memoryTier(config) === "v3"` (see
 * `memory-tier.ts`), and the difference from {@link isMemoryV3Live} is the
 * memory-off case — `"off"` outranks `"v3"`, so a `memory.v3.live` assistant
 * whose owner switched Memory off is NOT on the v3 tier. Every v3-tier-scoped
 * FEATURE asks this predicate; only the injection-suppression checks that must
 * mirror the raw `memory.v3.live` key ask {@link isMemoryV3Live} directly.
 *
 * The memory concept graph is gated on it: both `GET /memory-graph`
 * (`supported`) and the cheap `graph_supported` bit on `GET /memory/stats`
 * must agree with whether the graph can build from the v3 concept-page
 * substrate.
 *
 * Retrospective skill improvement is a separate optional v3-tier feature.
 * Ask {@link isSkillImprovementActive} for it so an operator can stop managed
 * skill authoring without turning off ordinary retrospective memory capture.
 */
export function isV3TierActive(config: AssistantConfig): boolean {
  return isMemoryEnabled(config) && isMemoryV3Live(config);
}

/**
 * Whether a retrospective may turn observed procedures into managed skills.
 * This requires the v3 tier because skills are retrieved through its memory
 * substrate, and it honors the retrospective-specific opt-out without
 * disabling ordinary retrospective fact retention.
 */
export function isSkillImprovementActive(config: AssistantConfig): boolean {
  return (
    isV3TierActive(config) &&
    config.memory?.retrospective?.skillImprovement !== false
  );
}

/**
 * Minimal structural view of the memory config the concept-page gate reads.
 * Accepting the shape (rather than the full `MemoryConfig`) lets call sites
 * pass either `config.memory` or the plugin-resolved memory slice, and keeps
 * partial configs in tests from throwing.
 */
export interface ConceptPageMemoryGateConfig {
  enabled?: boolean;
}

/**
 * Whether the concept-page memory substrate is active: the write pipeline
 * (`remember` → `memory/buffer.md` → consolidation → concept pages under
 * `memory/concepts/`), the concept-page Qdrant collection and its boot-time
 * maintenance (capability seeding, BM25 corpus stats, reembed reconcile), and
 * the static `<info>` memory block. An explicit `memory.enabled === false`
 * disables it.
 */
export function usesConceptPageMemory(
  memory: ConceptPageMemoryGateConfig | undefined,
): boolean {
  return memory?.enabled !== false;
}
