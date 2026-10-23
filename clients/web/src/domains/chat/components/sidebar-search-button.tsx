import { Search } from "lucide-react";
import { useCallback } from "react";

import {
  acceleratorToAriaKeyShortcuts,
  Button,
  formatAcceleratorHint,
} from "@vellumai/design-library";

import { NATIVE_MOBILE_BARE_ICON_BUTTON } from "@/domains/chat/utils/native-mobile-button-constants";
import { useCommandShortcut } from "@/hooks/use-command-shortcut";
import { useTranslation } from "@/i18n";
import { useCommandPaletteStore } from "@/stores/command-palette-store";

/**
 * The sidebar's search glyph. Opens the command palette and leaves the drawer
 * open: the palette (fixed z-50) covers it, so dismissing search returns to
 * the menu rather than the chat behind it.
 */
export function SidebarSearchButton() {
  const { t } = useTranslation("chat");
  const toggle = useCommandPaletteStore.use.toggle();
  const handleClick = useCallback(() => {
    toggle();
  }, [toggle]);
  const accelerator = useCommandShortcut("commandPalette");
  // The glyphs belong in the tooltip a sighted user reads, not in the
  // accessible name, where they are announced as their character names. A
  // screen reader gets the plain label and the binding through
  // `aria-keyshortcuts`.
  const label = t("assistantSideMenu.search");
  const tooltip = accelerator
    ? t("assistantSideMenu.searchShortcut", {
        shortcut: formatAcceleratorHint(accelerator),
      })
    : label;

  return (
    <Button
      variant="ghost"
      iconOnly={<Search />}
      aria-label={label}
      aria-keyshortcuts={
        accelerator ? acceleratorToAriaKeyShortcuts(accelerator) : undefined
      }
      title={tooltip}
      className={`pointer-events-auto ${NATIVE_MOBILE_BARE_ICON_BUTTON}`}
      onClick={handleClick}
    />
  );
}
