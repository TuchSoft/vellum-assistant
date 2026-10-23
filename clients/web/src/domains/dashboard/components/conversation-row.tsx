import { useTranslation } from "@/i18n";
import type { Conversation } from "@/types/conversation-types";
import { formatRelativeDate } from "@/utils/format-date";

import type { DashboardConversationStatus } from "../lib/conversation-filters";

const STATUS_COPY = {
  working: "dashboard.status.working",
  "needs-input": "dashboard.status.needsInput",
} as const;

const STATUS_CLASS = {
  working: "text-[var(--content-success,var(--content-secondary))]",
  "needs-input": "text-[var(--content-warning,var(--content-secondary))]",
} as const;

export interface ConversationRowProps {
  conversation: Conversation;
  status: DashboardConversationStatus | null;
  onOpen: () => void;
}

/** One compact conversation row: title, last activity, optional state chip. */
export function ConversationRow({
  conversation,
  status,
  onOpen,
}: ConversationRowProps) {
  const { t } = useTranslation("intelligence");
  const title = conversation.title?.trim() || t("dashboard.untitled");
  const timestamp = conversation.lastMessageAt ?? conversation.createdAt;
  const timeLabel = timestamp
    ? formatRelativeDate(new Date(timestamp).toISOString())
    : "";

  return (
    <button
      type="button"
      onClick={onOpen}
      className="flex w-full items-center gap-3 rounded-2xl px-2 py-2 text-left transition-colors hover:bg-[var(--surface-hover)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--ring)]"
    >
      <span className="flex min-w-0 flex-1 flex-col">
        <span className="truncate text-body-medium-default text-[var(--content-default)]">
          {title}
        </span>
        {timeLabel ? (
          <span className="truncate text-body-small-lighter text-[var(--content-tertiary)]">
            {timeLabel}
          </span>
        ) : null}
      </span>
      {status ? (
        <span
          className={`flex shrink-0 items-center gap-1.5 text-body-small-lighter ${STATUS_CLASS[status]}`}
        >
          <span className="h-1.5 w-1.5 rounded-full bg-current" />
          {t(STATUS_COPY[status])}
        </span>
      ) : null}
    </button>
  );
}
