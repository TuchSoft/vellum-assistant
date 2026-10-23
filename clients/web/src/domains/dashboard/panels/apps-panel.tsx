import { useQuery } from "@tanstack/react-query";
import { Link } from "react-router";

import { appsGetOptions } from "@/generated/daemon/@tanstack/react-query.gen";
import { useTranslation } from "@/i18n";
import { routes } from "@/utils/routes";

export function AppsPanel({ assistantId }: { assistantId: string }) {
  const { t } = useTranslation("intelligence");
  /* The library page's own query, so the two surfaces share one cache entry
     instead of each fetching the app list. */
  const { data: apps = [], isLoading } = useQuery({
    ...appsGetOptions({ path: { assistant_id: assistantId } }),
    select: (data) => data.apps,
  });

  if (isLoading) {
    return (
      <p className="px-2 py-3 text-body-small-lighter text-[var(--content-tertiary)]">
        {t("dashboard.loading")}
      </p>
    );
  }

  if (apps.length === 0) {
    return (
      <p className="px-2 py-3 text-body-small-lighter text-[var(--content-tertiary)]">
        {t("dashboard.apps.empty")}
      </p>
    );
  }

  return (
    <ul className="flex flex-col gap-1">
      {apps.slice(0, 6).map((app) => (
        <li key={app.id}>
          <Link
            to={routes.library.app(app.id)}
            className="flex flex-col rounded-2xl px-2 py-2 transition-colors hover:bg-[var(--surface-hover)]"
          >
            <span className="truncate text-body-medium-default text-[var(--content-default)]">
              {app.name}
            </span>
            {app.description ? (
              <span className="line-clamp-1 text-body-small-lighter text-[var(--content-tertiary)]">
                {app.description}
              </span>
            ) : null}
          </Link>
        </li>
      ))}
    </ul>
  );
}
