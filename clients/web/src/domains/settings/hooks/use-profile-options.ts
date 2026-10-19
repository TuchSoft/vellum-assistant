import { useQuery } from "@tanstack/react-query";
import { useMemo } from "react";

import {
  aliasMapFromLlm,
  isDispatchableProfile,
  profilePickerLabel,
  type ProfilePickerEntry,
} from "@/assistant/profile-pickers";
import { configGetOptions } from "@/generated/daemon/@tanstack/react-query.gen";
import type { ConfigGetResponse } from "@/generated/daemon/types.gen";

type LlmConfig = ConfigGetResponse["llm"];

export interface ProfileOption {
  readonly value: string | null;
  readonly label: string;
}

export function buildProfileOptions(
  llm: LlmConfig | undefined,
  _selectedProfile?: string | null,
): ProfileOption[] {
  const aliases = Object.values(aliasMapFromLlm(llm)).filter((alias) =>
    isDispatchableProfile(alias),
  );
  return [
    { value: null, label: "Default" },
    ...aliases.map((alias) => ({
      value: alias.name,
      label: profilePickerLabel(alias),
    })),
  ];
}

export function useProfileOptions(
  assistantId: string,
  selectedProfile?: string | null,
): ProfileOption[] {
  const { data: daemonConfig } = useQuery({
    ...configGetOptions({ path: { assistant_id: assistantId } }),
    enabled: Boolean(assistantId),
    staleTime: 60_000,
  });

  return useMemo(
    () => buildProfileOptions(daemonConfig?.llm, selectedProfile),
    [daemonConfig?.llm, selectedProfile],
  );
}

export type { ProfilePickerEntry };
