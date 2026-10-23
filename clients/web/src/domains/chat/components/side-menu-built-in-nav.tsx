import type { ReactNode } from "react";

import { SIDEBAR_STACK_GAP } from "@/components/sidebar-nav-geometry";
import { useNavigate } from "react-router";

import { AssistantSwitcher } from "@/domains/chat/components/assistant-switcher";
import { EmailNavItem } from "@/domains/chat/components/email-nav-item";
import { NewItemMenu } from "@/domains/chat/components/new-item-menu";
import { SidebarSearchButton } from "@/domains/chat/components/sidebar-search-button";
import { useEmailPinned } from "@/hooks/use-email-pinned";
import { cn } from "@vellumai/design-library";
import { useTranslation } from "@/i18n";
import { routes } from "@/utils/routes";

export interface SideMenuBuiltInNavProps {
  assistantId: string | null;
  /** Shown on the assistant row; falls back to "Your Assistant". */
  assistantName?: string | null;
  collapsed: boolean;
  variant: "rail" | "overlay";
  isIntelligenceActive?: boolean;
  onOpenIntelligence?: () => void;
  onStartNewConversation?: () => void;
  onClose?: () => void;
  /** The assistant section's toggle, beside the assistant pill. */
  assistantAside?: ReactNode;
  /** The assistant's own section, opened beneath the assistant row. */
  assistantBeneath?: ReactNode;
}

/**
 * The sidebar's built-in navigation block: the assistant cluster with the
 * generic "+" menu and search on its row, then the pinned Email entry. Apps
 * are not listed here: their one door is the dashboard's Apps tab.
 *
 * The block carries neither a heading over the pinned entries nor a rule
 * under them, in either state. Every entry here is a pill (a circle on the
 * rail) on the page background, and a shape like that is already delimited.
 */
export function SideMenuBuiltInNav({
  assistantId,
  assistantName,
  collapsed,
  variant,
  isIntelligenceActive = false,
  onOpenIntelligence,
  onStartNewConversation,
  onClose,
  assistantAside,
  assistantBeneath,
}: SideMenuBuiltInNavProps) {
  const { t } = useTranslation("chat");
  const navigate = useNavigate();
  /* The Email pin, set from the profile's Email card. */
  const emailPin = useEmailPinned(assistantId);
  const showsEmailPin = emailPin.pinned;

  /* The row's trailing cluster: the assistant-section toggle, search, and the
     generic "+" menu. On the collapsed rail the cluster is a column of tiles,
     matching the rail's own column, so the three never overflow its width. */
  const rowActions = (
    <div
      className={cn(
        collapsed ? "flex flex-col" : "flex items-center",
        SIDEBAR_STACK_GAP,
      )}
    >
      {assistantAside}
      {/* The overlay's glyph row already carries search, so the drawer does
          not draw a second one a row below it. */}
      {variant === "rail" ? <SidebarSearchButton /> : null}
      <NewItemMenu onNewChat={onStartNewConversation} />
    </div>
  );

  return (
    <div className={cn("flex flex-col", SIDEBAR_STACK_GAP)}>
      <div>
        <AssistantSwitcher
          assistantId={assistantId}
          label={assistantName || t("sideMenuBuiltInNav.yourAssistant")}
          active={isIntelligenceActive}
          collapsed={collapsed}
          onSelect={
            onOpenIntelligence
              ? () => {
                  onOpenIntelligence();
                  onClose?.();
                }
              : undefined
          }
          onSwitched={onClose}
          aside={rowActions}
          beneath={assistantBeneath}
        />
      </div>
      {showsEmailPin ? (
        <div className={cn("flex flex-col", SIDEBAR_STACK_GAP)}>
          <EmailNavItem
            assistantId={assistantId}
            collapsed={collapsed}
            onSelect={() => {
              navigate(routes.assistantInbox);
              onClose?.();
            }}
            onUnpin={emailPin.unpin}
          />
        </div>
      ) : null}
    </div>
  );
}
