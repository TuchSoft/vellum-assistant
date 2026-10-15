/**
 * Personalized home-page greeting generator.
 *
 * Permanently disabled by custom patch 06: no LLM greeting is generated or
 * cached. `getPersonalizedGreeting` always returns `null`, so the home feed
 * route serves its deterministic time-of-day fallback greeting instead.
 */

export function getPersonalizedGreeting(): string | null {
  return null;
}

export async function refreshPersonalizedGreeting(): Promise<boolean> {
  return false;
}
