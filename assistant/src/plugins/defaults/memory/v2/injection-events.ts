import { getLogger } from "../logging.js";
import { memoryDbOrNull } from "../memory-db.js";

const log = getLogger("memory-v2-injection-events");

/**
 * Half-life of the injection-frequency decay, in milliseconds.
 *
 * Per the memory router v4 spec: a +1 from 3 days ago contributes 0.5; from
 * 6 days ago 0.25. Decoupled from turn volume — busy and quiet days decay
 * at the same wall-clock rate.
 */
export const INJECTION_SCORE_HALF_LIFE_MS = 3 * 24 * 60 * 60 * 1000;

export const INJECTION_SCORE_LAMBDA =
  Math.log(2) / INJECTION_SCORE_HALF_LIFE_MS;

// Events past 6 half-lives contribute <1.6% each. Reads bound the scan to
// this window so per-slug score computation stays cheap as history grows.
// Migration 326 uses the same window to purge dead rows during relocation.
const READ_WINDOW_MS = 6 * INJECTION_SCORE_HALF_LIFE_MS;

function decayContribution(elapsedMs: number): number {
  return Math.exp(-INJECTION_SCORE_LAMBDA * elapsedMs);
}

/**
 * Append one event per slug. Best-effort — a memory write must never abort
 * the agent turn on top of a successful routing decision the rest of the
 * caller depends on.
 */
export async function recordInjectionEvents(
  slugs: readonly string[],
  injectedAt: number,
): Promise<void> {
  if (slugs.length === 0) {
    return;
  }
  try {
    const raw = memoryDbOrNull("recordInjectionEvents");
    if (!raw) {
      return;
    }
    await raw.transaction(async (tx) => {
      for (const slug of slugs) {
        await tx.run(
          `INSERT INTO memory_v2_injection_events (slug, injected_at) VALUES (?, ?)`,
          [slug, injectedAt],
        );
      }
    });
  } catch (err) {
    log.warn(
      { err, slugCount: slugs.length },
      "failed to record injection events; continuing",
    );
  }
}

/**
 * `score(now) = Σᵢ exp(-λ × (now - tᵢ))` over events within READ_WINDOW_MS.
 * Returns 0 when the memory database is unavailable.
 */
export async function computeInjectionScore(
  slug: string,
  now: number,
): Promise<number> {
  const raw = memoryDbOrNull("computeInjectionScore");
  if (!raw) {
    return 0;
  }
  const cutoff = now - READ_WINDOW_MS;
  const rows = await raw.all<{ injected_at: number }>(
    `SELECT injected_at FROM memory_v2_injection_events
      WHERE slug = ? AND injected_at >= ?`,
    [slug, cutoff],
  );
  let score = 0;
  for (const row of rows) {
    score += decayContribution(now - row.injected_at);
  }
  return score;
}

/**
 * Batch variant of `computeInjectionScore` — single SQL pass scoped to the
 * requested slugs so tier assignment doesn't issue O(M) queries. Slugs
 * with no events in the read window are omitted from the result; callers
 * should treat a missing entry as score 0. Returns an empty map when the
 * memory database is unavailable, so a degraded connection reads as
 * all-zero scores (tier 2 simply selects nothing).
 */
export async function computeInjectionScores(
  slugs: readonly string[],
  now: number,
): Promise<Map<string, number>> {
  const out = new Map<string, number>();
  if (slugs.length === 0) {
    return out;
  }
  const raw = memoryDbOrNull("computeInjectionScores");
  if (!raw) {
    return out;
  }
  const cutoff = now - READ_WINDOW_MS;
  const placeholders = slugs.map(() => "?").join(",");
  const rows = await raw.all<{ slug: string; injected_at: number }>(
    `SELECT slug, injected_at FROM memory_v2_injection_events
      WHERE slug IN (${placeholders}) AND injected_at >= ?`,
    [...slugs, cutoff],
  );
  for (const row of rows) {
    const prev = out.get(row.slug) ?? 0;
    out.set(row.slug, prev + decayContribution(now - row.injected_at));
  }
  return out;
}
