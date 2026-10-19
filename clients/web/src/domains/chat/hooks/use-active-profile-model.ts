import { useQuery } from "@tanstack/react-query";
import { useMemo } from "react";

import {
  configGetOptions,
  conversationsByIdGetOptions,
} from "@/generated/daemon/@tanstack/react-query.gen";

/**
 * Resolves the (provider, model) pair currently in effect for a chat
 * conversation by reading the assistant's LLM config and the optional
 * per-conversation profile override.
 *
 * Both queries share their respective TanStack Query cache entries with
 * the rest of the app (settings domain, composer settings menu, etc.) so
 * invalidating the config or conversation cache from any consumer also
 * refreshes this hook's derivation.
 *
 * Used by the chat composer to gate behaviors that depend on model
 * capabilities (e.g. image attachments require a vision-capable model).
 * Returns `null` when the data isn't loaded yet or the active profile
 * doesn't declare a provider/model.
 *
 * `supportsVision` is resolved server-side by the daemon from its model
 * catalog and embedded on each profile entry in the config response.
 */
export interface ActiveProfileModel {
  provider: string;
  model: string;
  supportsVision?: boolean;
}

/**
 * @param pendingProfile Profile stashed in the composer for a conversation
 *   whose row hasn't loaded yet (a draft, or one opened by URL mid-load) — see
 *   `pendingDraftProfiles` in `conversation-store`. It's the effective profile
 *   until the row materializes, so capability gating (e.g. image attachments)
 *   should reflect it. A loaded per-conversation override still wins.
 */
export function useActiveProfileModel(
  assistantId: string | null,
  conversationId: string | undefined,
  pendingProfile?: string | null,
): ActiveProfileModel | null {
  const { data: config } = useQuery({
    ...configGetOptions({ path: { assistant_id: assistantId ?? "" } }),
    enabled: !!assistantId,
    staleTime: 30_000,
  });

  const { data: convData } = useQuery({
    ...conversationsByIdGetOptions({
      path: { assistant_id: assistantId ?? "", id: conversationId ?? "" },
    }),
    enabled: !!assistantId && !!conversationId,
  });

  return useMemo(() => {
    if (!config) {
      return null;
    }
    const effective =
      convData?.conversation.model ??
      pendingProfile ??
      config.llm?.defaultModel ??
      null;
    if (!effective) {
      return null;
    }
    return { provider: "llm-gateway", model: effective };
  }, [config, convData, pendingProfile]);
}
