import { useNavigate } from "react-router";

import { useConversationListQuery } from "@/hooks/conversation-queries";
import { useTranslation } from "@/i18n";
import { useConversationStore } from "@/stores/conversation-store";
import { routes } from "@/utils/routes";

import { ConversationRow } from "../components/conversation-row";
import {
  conversationStatus,
  filterConversations,
  type DashboardConversationFilter,
} from "../lib/conversation-filters";

const EMPTY_COPY = {
  active: "dashboard.conversations.emptyActive",
  recent: "dashboard.conversations.emptyRecent",
  unread: "dashboard.conversations.emptyUnread",
} as const satisfies Record<DashboardConversationFilter, string>;

export interface ConversationsPanelProps {
  assistantId: string;
  filter: DashboardConversationFilter;
}

/**
 * One conversation tab's rows. The list comes from the same foreground query
 * the sidebar uses; the processing and attention sets come from the live
 * store, so the Active tab tracks turns as they start and stop.
 */
export function ConversationsPanel({
  assistantId,
  filter,
}: ConversationsPanelProps) {
  const { t } = useTranslation("intelligence");
  const navigate = useNavigate();
  const { conversations, isLoading, hasData } = useConversationListQuery(
    assistantId,
    true,
  );
  const processingIds = useConversationStore.use.processingConversationIds();
  const attentionIds = useConversationStore.use.attentionConversationIds();
  const rows = filterConversations(conversations, filter, {
    processingIds,
    attentionIds,
  });

  if (isLoading && !hasData) {
    return (
      <p className="px-2 py-3 text-body-small-lighter text-[var(--content-tertiary)]">
        {t("dashboard.loading")}
      </p>
    );
  }

  if (rows.length === 0) {
    return (
      <p className="px-2 py-3 text-body-small-lighter text-[var(--content-tertiary)]">
        {t(EMPTY_COPY[filter])}
      </p>
    );
  }

  return (
    <ul className="flex flex-col gap-1">
      {rows.map((conversation) => (
        <li key={conversation.conversationId}>
          <ConversationRow
            conversation={conversation}
            status={conversationStatus(
              conversation,
              processingIds,
              attentionIds,
            )}
            onOpen={() =>
              navigate(routes.conversation(conversation.conversationId))
            }
          />
        </li>
      ))}
    </ul>
  );
}
