import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useMemo, useState } from "react";

import { useTranslation } from "@/i18n";

import { captureError } from "@/lib/sentry/capture-error";
import {
  configLlmCallsitesGetOptions,
  configLlmCallsitesGetSetQueryData,
  llmCatalogGetOptions,
  useConfigLlmCallsitesBySitePatchMutation,
} from "@/generated/daemon/@tanstack/react-query.gen";
import type {
  ConfigLlmCallsitesBySitePatchData,
  ConfigLlmCallsitesGetResponse,
  LlmCatalogGetResponse,
} from "@/generated/daemon/types.gen";
import { Select } from "@vellumai/design-library/components/select";
import { Tag } from "@vellumai/design-library/components/tag";
import { toast } from "@vellumai/design-library/components/toast";
import { Toggle } from "@vellumai/design-library/components/toggle";

type CallSite = ConfigLlmCallsitesGetResponse["callSites"][number];
type CatalogModel = LlmCatalogGetResponse["models"][number];
type CallSiteBody = ConfigLlmCallsitesBySitePatchData["body"];

const CALL_SITE_LABELS: Record<string, string> = {
  mainAgent: "Main agent",
  subagentSpawn: "Subagent spawn",
  conversationTitle: "Conversation title",
  commitMessage: "Commit message",
  recall: "Recall",
  vision: "Vision",
};

/**
 * Per-call-site alias table. Each row edits the workspace pin (`model`) and
 * the enabled flag through the daemon's call-site route; the gateway alias
 * list comes from the gateway catalog, so the dropdown never offers an alias
 * that does not exist. A call site whose saved alias has disappeared from the
 * catalog keeps showing that alias and a degraded badge with the alias that
 * resolution will actually use.
 */
export function ModelsCard({ assistantId }: { assistantId: string }) {
  const { t } = useTranslation("settings");
  const queryClient = useQueryClient();
  const [pendingSite, setPendingSite] = useState<string | null>(null);

  const { data: catalog } = useQuery({
    ...configLlmCallsitesGetOptions({ path: { assistant_id: assistantId } }),
    enabled: Boolean(assistantId),
    staleTime: 30_000,
  });
  const { data: gatewayCatalog } = useQuery({
    ...llmCatalogGetOptions({ path: { assistant_id: assistantId } }),
    enabled: Boolean(assistantId),
    staleTime: 30_000,
  });

  const saveMutation = useConfigLlmCallsitesBySitePatchMutation({
    onSuccess: (data) => {
      configLlmCallsitesGetSetQueryData(
        queryClient,
        { path: { assistant_id: assistantId } },
        data,
      );
      setPendingSite(null);
    },
    onError: (error) => {
      setPendingSite(null);
      toast.error(t("modelsCard.saveFailed"));
      captureError(error, { context: "save_llm_call_site" });
    },
  });

  const chatModels = useMemo(
    () =>
      (gatewayCatalog?.models ?? []).filter(
        (model: CatalogModel) => model.mode === "chat",
      ),
    [gatewayCatalog],
  );

  const callSites = catalog?.callSites ?? [];

  const save = (site: string, body: CallSiteBody) => {
    if (!assistantId) {
      return;
    }
    setPendingSite(site);
    saveMutation.mutate({
      path: { assistant_id: assistantId, site },
      body,
    });
  };

  const optionsFor = (site: CallSite) => {
    const options = chatModels.map((model: CatalogModel) => ({
      value: model.alias,
      label: model.label || model.alias,
    }));
    if (
      site.configuredModel != null &&
      !options.some((option) => option.value === site.configuredModel)
    ) {
      options.unshift({
        value: site.configuredModel,
        label: t("modelsCard.unavailableAlias", {
          alias: site.configuredModel,
        }),
      });
    }
    return [
      { value: null as string | null, label: t("modelsCard.inheritOption") },
      ...options,
    ];
  };

  return (
    <section className="rounded-xl border border-border p-5">
      <div className="mb-3">
        <h2 className="text-sm font-semibold">{t("modelsCard.title")}</h2>
        <p className="text-muted-foreground text-xs">
          {t("modelsCard.description")}
        </p>
        <p className="text-muted-foreground mt-1 text-xs">
          {t("modelsCard.hint")}
        </p>
      </div>
      <table className="w-full text-xs">
        <thead className="text-muted-foreground text-left">
          <tr>
            <th className="py-1 font-medium">{t("modelsCard.callSite")}</th>
            <th className="py-1 font-medium">{t("modelsCard.alias")}</th>
            <th className="py-1 font-medium">{t("modelsCard.enabled")}</th>
            <th className="py-1 font-medium">{t("modelsCard.effective")}</th>
          </tr>
        </thead>
        <tbody>
          {callSites.map((site: CallSite) => {
            const label = CALL_SITE_LABELS[site.id] ?? site.displayName;
            const saving = pendingSite === site.id;
            return (
              <tr key={site.id} className="border-border border-t">
                <td className="py-1.5">{label}</td>
                <td className="py-1.5 pr-3">
                  <Select
                    aria-label={t("modelsCard.aliasFor", { callSite: label })}
                    size="compact"
                    value={site.configuredModel}
                    options={optionsFor(site)}
                    onSelectNone={() => save(site.id, { model: null })}
                    onChange={(model) => save(site.id, { model })}
                    disabled={
                      !site.enabled || saving || chatModels.length === 0
                    }
                  />
                </td>
                <td className="py-1.5">
                  <Toggle
                    aria-label={t("modelsCard.toggleFor", { callSite: label })}
                    size="sm"
                    checked={site.enabled}
                    disabled={saving || site.id === "mainAgent"}
                    onChange={(next) =>
                      save(
                        site.id,
                        next
                          ? { enabled: true }
                          : { enabled: false, model: null },
                      )
                    }
                  />
                </td>
                <td className="py-1.5">
                  {site.degraded ? (
                    <Tag tone="warning" title={site.reason ?? undefined}>
                      {t("modelsCard.degradedUsing", {
                        model: site.effectiveModel ?? "-",
                      })}
                    </Tag>
                  ) : (
                    <span className="text-muted-foreground">
                      {site.effectiveModel
                        ? t("modelsCard.effectiveUsing", {
                            model: site.effectiveModel,
                          })
                        : t("modelsCard.disabled")}
                    </span>
                  )}
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </section>
  );
}
