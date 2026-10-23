import { useAssistantIdentityDetails } from "@/hooks/use-assistant-identity-details";
import { useTranslation } from "@/i18n";
import { useAssistantIdentityStore } from "@/stores/assistant-identity-store";

/**
 * Name and version are real. Health, disk, CPU and network have no endpoint
 * yet, so they read as unknown rather than being guessed.
 */
export function InfoPanel({ assistantId }: { assistantId: string }) {
  const { t } = useTranslation("intelligence");
  const identityQuery = useAssistantIdentityDetails(assistantId);
  const version = useAssistantIdentityStore.use.version();
  const name = identityQuery.data?.identity?.name;
  const unknown = t("dashboard.info.unknown");

  const rows = [
    { label: t("dashboard.info.name"), value: name || unknown },
    { label: t("dashboard.info.version"), value: version || unknown },
    { label: t("dashboard.info.health"), value: unknown },
    { label: t("dashboard.info.disk"), value: unknown },
    { label: t("dashboard.info.cpu"), value: unknown },
    { label: t("dashboard.info.network"), value: unknown },
  ];

  return (
    <dl className="flex flex-col gap-2">
      {rows.map((row) => (
        <div
          key={row.label}
          className="flex items-center justify-between gap-3 text-body-small-default"
        >
          <dt className="text-[var(--content-tertiary)]">{row.label}</dt>
          <dd className="truncate text-[var(--content-default)]">{row.value}</dd>
        </div>
      ))}
    </dl>
  );
}
