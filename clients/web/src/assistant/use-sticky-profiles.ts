import { useEffect, useMemo, useState } from "react";

import {
  aliasMapFromLlm,
  type ProfilePickerEntry,
} from "@/assistant/profile-pickers";
import type { ConfigGetResponse } from "@/generated/daemon/types.gen";

type Llm = ConfigGetResponse["llm"];

/** The alias map a picker renders. */
export type ProfileMap = Record<string, ProfilePickerEntry>;

export interface StickyProfiles {
  profiles: ProfileMap;
  profileOrder: string[];
}

const EMPTY: StickyProfiles = { profiles: {}, profileOrder: [] };

/**
 * Read the selectable aliases from the shared daemon-config query, retaining
 * the last non-empty snapshot across a transient partial payload.
 */
export function useStickyProfiles(
  llm: Llm | undefined,
  resetKey?: string,
): StickyProfiles {
  const liveProfiles = useMemo(() => aliasMapFromLlm(llm), [llm]);
  const liveOrder = useMemo(() => Object.keys(liveProfiles), [liveProfiles]);
  const hasLive = liveOrder.length > 0;

  const [sticky, setSticky] = useState<StickyProfiles>(EMPTY);

  const [prevResetKey, setPrevResetKey] = useState(resetKey);
  if (resetKey !== prevResetKey) {
    setPrevResetKey(resetKey);
    setSticky(EMPTY);
  }

  useEffect(() => {
    if (hasLive) {
      setSticky({ profiles: liveProfiles, profileOrder: liveOrder });
    }
  }, [hasLive, liveProfiles, liveOrder]);

  if (hasLive) {
    return { profiles: liveProfiles, profileOrder: liveOrder };
  }
  return resetKey !== prevResetKey ? EMPTY : sticky;
}
