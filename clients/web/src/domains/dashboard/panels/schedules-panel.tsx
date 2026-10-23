import { useQuery } from "@tanstack/react-query";
import { Link } from "react-router";

import { useTranslation } from "@/i18n";
import { routes } from "@/utils/routes";
import { schedulesListQueryOptions } from "@/utils/schedules";

export function SchedulesPanel({ assistantId }: { assistantId: string }) {
  const { t } = useTranslation("intelligence");
  /* The schedules page's own query, shared through the cache. */
  const { data: schedules = [], isLoading } = useQuery(
    schedulesListQueryOptions(assistantId),
  );
  const rows = [...schedules]
    .filter((schedule) => schedule.status === "active")
    .sort((a, b) => a.nextRunAt - b.nextRunAt)
    .slice(0, 6);

  if (isLoading) {
    return (
      <p className="px-2 py-3 text-body-small-lighter text-[var(--content-tertiary)]">
        {t("dashboard.loading")}
      </p>
    );
  }

  if (rows.length === 0) {
    return (
      <p className="px-2 py-3 text-body-small-lighter text-[var(--content-tertiary)]">
        {t("dashboard.schedules.empty")}
      </p>
    );
  }

  return (
    <ul className="flex flex-col gap-1">
      {rows.map((schedule) => (
        <li key={schedule.id}>
          <Link
            to={routes.schedules.detail(schedule.id)}
            className="flex flex-col rounded-2xl px-2 py-2 transition-colors hover:bg-[var(--surface-hover)]"
          >
            <span className="truncate text-body-medium-default text-[var(--content-default)]">
              {schedule.name}
            </span>
            <span className="truncate text-body-small-lighter text-[var(--content-tertiary)]">
              {schedule.cadenceDescription}
            </span>
          </Link>
        </li>
      ))}
    </ul>
  );
}
