/**
 * Job handler for generating conversation starters.
 *
 * Permanently disabled by custom patch 06: conversation starter chips are
 * never generated, so the memory job that used to invoke the LLM here is a
 * no-op.
 */

import type { MemoryJob } from "../../persistence/jobs-store.js";

export async function generateConversationStartersJob(
  _job: MemoryJob,
): Promise<void> {
  // Intentionally empty: conversation starters are disabled.
}
