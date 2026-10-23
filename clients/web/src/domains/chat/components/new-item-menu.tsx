import {
  AppWindow,
  FolderPlus,
  MessageSquare,
  Plus,
  Upload,
  Zap,
} from "lucide-react";

import { ActionMenu, Button } from "@vellumai/design-library";

import { useTranslation } from "@/i18n";

export interface NewItemMenuProps {
  /** Starts an empty conversation. Omitted when the caller has no chat route. */
  onNewChat?: () => void;
}

/**
 * The generic "+" beside the assistant's row. Only New chat is wired today;
 * projects, skills, apps and file uploads are listed so the menu's shape is
 * settled, and marked unavailable rather than silently doing nothing.
 */
export function NewItemMenu({ onNewChat }: NewItemMenuProps) {
  const { t } = useTranslation("chat");
  const soon = t("assistantSideMenu.newMenu.soon");
  const label = t("assistantSideMenu.newMenu.label");

  return (
    <ActionMenu.Root>
      <ActionMenu.Trigger asChild>
        <Button
          variant="ghost"
          iconOnly={<Plus />}
          aria-label={label}
          title={label}
        />
      </ActionMenu.Trigger>
      <ActionMenu.Content
        title={label}
        showTitle
        closeLabel={t("assistantSideMenu.newMenu.close")}
        align="start"
      >
        <ActionMenu.Item
          icon={MessageSquare}
          label={t("assistantSideMenu.newMenu.chat")}
          disabled={!onNewChat}
          onSelect={onNewChat}
        />
        <ActionMenu.Item
          icon={FolderPlus}
          label={t("assistantSideMenu.newMenu.project")}
          trailing={soon}
          disabled
        />
        <ActionMenu.Item
          icon={Zap}
          label={t("assistantSideMenu.newMenu.skill")}
          trailing={soon}
          disabled
        />
        <ActionMenu.Item
          icon={AppWindow}
          label={t("assistantSideMenu.newMenu.app")}
          trailing={soon}
          disabled
        />
        <ActionMenu.Item
          icon={Upload}
          label={t("assistantSideMenu.newMenu.file")}
          trailing={soon}
          disabled
        />
      </ActionMenu.Content>
    </ActionMenu.Root>
  );
}
