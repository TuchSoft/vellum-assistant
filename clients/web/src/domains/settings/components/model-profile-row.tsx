import { useTranslation } from "@/i18n";
import { useCallSiteDefaultProfile } from "@/hooks/use-call-site-default-profile";

import type { ResolvableCallSite } from "@/hooks/use-call-site-default-profile";

export function ModelProfileRow({
  assistantId,
  pinnedProfile,
  defaultCallSite = "mainAgent",
  fallbackLabel,
}: {
  assistantId: string;
  pinnedProfile?: string | null;
  defaultCallSite?: ResolvableCallSite;
  fallbackLabel?: string;
  respectCallSiteOverride?: boolean;
}) {
  const { t } = useTranslation("settings");
  const resolvedFallback =
    fallbackLabel ?? t("modelProfileRow.defaultMainAgent");

  const { label: defaultProfileLabel } = useCallSiteDefaultProfile(
    assistantId,
    defaultCallSite,
    { enabled: pinnedProfile == null },
  );

  const profileLabel =
    pinnedProfile != null
      ? pinnedProfile
      : defaultProfileLabel != null
        ? t("modelProfileRow.defaultNamed", { name: defaultProfileLabel })
        : resolvedFallback;

  return (
    <div className="flex min-h-6 items-center justify-between gap-4">
      <span className="shrink-0 text-[var(--content-secondary)]">
        {t("modelProfileRow.label")}
      </span>
      <span className="min-w-0 truncate text-right" title={profileLabel}>
        {profileLabel}
      </span>
    </div>
  );
}
