import { useQuery } from "@tanstack/react-query";

import { useTranslation } from "@/i18n";
import { useEffect } from "react";

import { useActiveAssistantId } from "@/assistant/use-active-assistant-id";
import { ImageGenerationCard } from "@/domains/settings/ai/image-generation-card";
import { ManagedServicesBanner } from "@/components/managed-services-banner";
import { SpeechToTextCard } from "@/domains/settings/ai/speech-to-text-card";
import { TextToSpeechCard } from "@/domains/settings/ai/text-to-speech-card";
import { WebFetchCard } from "@/domains/settings/ai/web-fetch-card";
import { WebSearchCard } from "@/domains/settings/ai/web-search-card";
import { configLlmCallsitesGetOptions } from "@/generated/daemon/@tanstack/react-query.gen";

export function AiPage() {
  const assistantId = useActiveAssistantId();

  useEffect(() => {
    const hash = window.location.hash.slice(1);
    if (!hash) {
      return;
    }
    requestAnimationFrame(() => {
      document.getElementById(hash)?.scrollIntoView({ block: "start" });
    });
  }, []);

  return (
    <div className="min-h-0 flex-1 space-y-5 overflow-y-auto">
      <ManagedServicesBanner />
      <ModelsCard assistantId={assistantId} />
      <WebSearchCard />
      <WebFetchCard />
      <ImageGenerationCard />
      <TextToSpeechCard />
      <SpeechToTextCard />
    </div>
  );
}

const CALL_SITE_LABELS: Record<string, string> = {
  mainAgent: "Main agent",
  subagentSpawn: "Subagent spawn",
  conversationTitle: "Conversation title",
  commitMessage: "Commit message",
  recall: "Recall",
  vision: "Vision",
};

function ModelsCard({ assistantId }: { assistantId: string }) {
  const { t } = useTranslation("settings");
  const { data: catalog } = useQuery({
    ...configLlmCallsitesGetOptions({ path: { assistant_id: assistantId } }),
    enabled: Boolean(assistantId),
    staleTime: 30_000,
  });
  const callSites = catalog?.callSites ?? [];

  return (
    <section className="rounded-xl border border-border p-5">
      <div className="mb-3">
        <h2 className="text-sm font-semibold">{t("modelsCard.title")}</h2>
        <p className="text-muted-foreground text-xs">
          {t("modelsCard.description")}
        </p>
      </div>
      <table className="w-full text-xs">
        <thead className="text-muted-foreground text-left">
          <tr>
            <th className="py-1 font-medium">{t("modelsCard.callSite")}</th>
            <th className="py-1 font-medium">{t("modelsCard.model")}</th>
            <th className="py-1 font-medium">{t("modelsCard.source")}</th>
          </tr>
        </thead>
        <tbody>
          {callSites.map((site) => (
            <tr key={site.id} className="border-border border-t">
              <td className="py-1.5">
                {CALL_SITE_LABELS[site.id] ?? site.displayName}
              </td>
              <td className="py-1.5 font-mono">
                {site.enabled === false
                  ? t("modelsCard.disabled")
                  : (site.model ?? t("modelsCard.inherit"))}
              </td>
              <td className="py-1.5">{site.source ?? "-"}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </section>
  );
}
