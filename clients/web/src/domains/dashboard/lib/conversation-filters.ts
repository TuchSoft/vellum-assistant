import type { Conversation } from "@/types/conversation-types";

/** The three conversation tabs in the dashboard's first column. */
export type DashboardConversationFilter = "active" | "recent" | "unread";

/** What a row's trailing chip says, when it says anything. */
export type DashboardConversationStatus = "working" | "needs-input";

const DEFAULT_LIMIT = 8;

function lastActivity(conversation: Conversation): number {
  return conversation.lastMessageAt ?? conversation.createdAt ?? 0;
}

/**
 * Most recently active first. The dashboard's columns are a glance, not the
 * sidebar's full list, so every tab reads in one order.
 */
export function sortByLastActivity(
  conversations: readonly Conversation[],
): Conversation[] {
  return [...conversations].sort((a, b) => lastActivity(b) - lastActivity(a));
}

/**
 * Working wins over needs-input: a turn that is still running is the more
 * useful fact, and the attention flag can linger from the previous turn.
 */
export function conversationStatus(
  conversation: Conversation,
  processingIds: ReadonlySet<string>,
  attentionIds: ReadonlySet<string>,
): DashboardConversationStatus | null {
  if (processingIds.has(conversation.conversationId)) {
    return "working";
  }
  if (attentionIds.has(conversation.conversationId)) {
    return "needs-input";
  }
  return null;
}

export interface FilterConversationsOptions {
  processingIds: ReadonlySet<string>;
  attentionIds: ReadonlySet<string>;
  /** Rows to keep. The dashboard never renders an unbounded list. */
  limit?: number;
}

/**
 * The rows one conversation tab shows. `active` is the union of the daemon's
 * processing set and the attention set (a turn waiting on the user); `unread`
 * is the daemon's unseen-assistant-reply flag; `recent` is the list as-is.
 */
export function filterConversations(
  conversations: readonly Conversation[],
  filter: DashboardConversationFilter,
  options: FilterConversationsOptions,
): Conversation[] {
  const limit = options.limit ?? DEFAULT_LIMIT;
  const sorted = sortByLastActivity(conversations);
  const matches =
    filter === "active"
      ? sorted.filter(
          (conversation) =>
            conversationStatus(
              conversation,
              options.processingIds,
              options.attentionIds,
            ) !== null,
        )
      : filter === "unread"
        ? sorted.filter(
            (conversation) =>
              conversation.hasUnseenLatestAssistantMessage === true,
          )
        : sorted;
  return matches.slice(0, limit);
}
