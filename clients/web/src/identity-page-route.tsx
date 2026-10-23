import { useActiveAssistantId } from "@/assistant/use-active-assistant-id";
import { DashboardPage } from "@/domains/dashboard/dashboard-page";

export function IdentityPageRoute() {
  const assistantId = useActiveAssistantId();

  return <DashboardPage key={assistantId} assistantId={assistantId} />;
}
