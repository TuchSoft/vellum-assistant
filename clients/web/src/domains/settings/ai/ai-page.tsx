import { useEffect } from "react";

import { useActiveAssistantId } from "@/assistant/use-active-assistant-id";
import { ImageGenerationCard } from "@/domains/settings/ai/image-generation-card";
import { ManagedServicesBanner } from "@/components/managed-services-banner";
import { ModelsCard } from "@/domains/settings/ai/models-card";
import { SpeechToTextCard } from "@/domains/settings/ai/speech-to-text-card";
import { TextToSpeechCard } from "@/domains/settings/ai/text-to-speech-card";
import { WebFetchCard } from "@/domains/settings/ai/web-fetch-card";
import { WebSearchCard } from "@/domains/settings/ai/web-search-card";

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
