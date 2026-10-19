import type { ConfigGetResponse } from "@/generated/daemon/types.gen";

type Llm = NonNullable<ConfigGetResponse["llm"]>;

/**
 * The subset of an alias a picker needs. The name is the alias sent to the
 * gateway; the optional label/description come from the catalog.
 */
export interface ProfilePickerEntry {
  readonly name: string;
  readonly label?: string | null;
  readonly description?: string | null;
  readonly model?: string | null;
  readonly status?: "active" | "disabled" | null;
  readonly provider?: string | null;
  readonly mix?: unknown;
  readonly source?: string | null;
}

/** Whether the alias can be selected. Disabled call sites cannot. */
export function isDispatchableProfile(
  entry: ProfilePickerEntry,
  _siblings?: ReadonlyArray<ProfilePickerEntry>,
  _options?: unknown,
): boolean {
  return entry.status !== "disabled" && entry.name.length > 0;
}

/** Display label for an alias. */
export function profilePickerLabel(entry: ProfilePickerEntry): string {
  return entry.label ?? entry.name;
}

/**
 * Build the alias map a picker can offer from the current config. Aliases are
 * the default model plus every alias pinned by a call site; capabilities and
 * labels come from the gateway catalog when a consumer has it.
 */
export function aliasMapFromLlm(
  llm: Llm | undefined,
): Record<string, ProfilePickerEntry> {
  if (!llm) {
    return {};
  }
  const names = new Set<string>();
  if (llm.defaultModel) {
    names.add(llm.defaultModel);
  }
  for (const site of Object.values(llm.callSites ?? {})) {
    if (site?.model) {
      names.add(site.model);
    }
  }
  return Object.fromEntries(
    [...names]
      .sort()
      .map((name) => [
        name,
        { name, label: name, model: name, status: "active" as const },
      ]),
  );
}
