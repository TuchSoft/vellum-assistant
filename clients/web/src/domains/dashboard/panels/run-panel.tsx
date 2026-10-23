import { useTranslation } from "@/i18n";

/**
 * Long runs have no daemon API yet (the supervisor is still a workspace
 * skill), so the tab states that plainly instead of inventing data.
 */
export function RunPanel() {
  const { t } = useTranslation("intelligence");

  return (
    <div className="flex flex-col gap-1 rounded-2xl border border-dashed border-[var(--border-base)] p-3">
      <span className="text-body-small-emphasised text-[var(--content-default)]">
        {t("dashboard.run.title")}
      </span>
      <span className="text-body-small-lighter text-[var(--content-tertiary)]">
        {t("dashboard.run.body")}
      </span>
    </div>
  );
}
