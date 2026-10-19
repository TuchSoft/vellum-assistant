export interface ByokCreditRouteVerdict {
  suppress: boolean;
  settled: boolean;
  routeBurnsManaged: boolean;
}

/**
 * Whether the low/exhausted credit banners should stay down for a route that
 * does not spend managed credits. Every route now runs through the LLM
 * gateway, whose billing is outside the wallet this banner tracks, so the
 * banner is never suppressed by route classification.
 */
export function useByokCreditRouteVerdict(
  _enabled: boolean,
  _conversationId?: string | null,
  _draftProfile?: string | null,
): ByokCreditRouteVerdict {
  return { suppress: false, settled: true, routeBurnsManaged: false };
}
