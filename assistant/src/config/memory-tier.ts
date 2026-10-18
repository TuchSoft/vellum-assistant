import { isMemoryEnabled, isMemoryV3Live } from "./memory-v3-gate.js";
import type { AssistantConfig } from "./schema.js";

export type MemoryTier = "off" | "v1" | "v2" | "v3";

/**
 * Derive the coarse memory tier for an assistant, as a single bucket for
 * telemetry. Precedence is defined by the named gate predicates in
 * `memory-v3-gate.ts` — this function is fully derived from them, so the tier
 * buckets and the runtime gates can never disagree:
 *
 * - `"off"` wins over everything: {@link isMemoryEnabled} is false when an
 *   explicit `memory.enabled === false` disables the whole memory system.
 * - `"v3"` when memory-v3 is live (see {@link isMemoryV3Live}).
 * - `"v1"` otherwise. The bucket is retained because the platform dashboard
 *   groups on the frozen `memory_tier` strings; with the concept-page substrate
 *   active whenever memory is on, no assistant reports it.
 *
 * The `"v2"` bucket is retired with the v2 engine and is never returned.
 */
export function memoryTier(config: AssistantConfig): MemoryTier {
  if (!isMemoryEnabled(config)) {
    return "off";
  }
  if (isMemoryV3Live(config)) {
    return "v3";
  }
  return "v1";
}
