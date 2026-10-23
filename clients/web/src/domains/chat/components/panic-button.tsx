import { OctagonAlert } from "lucide-react";
import { useState } from "react";

import { Button, ConfirmDialog } from "@vellumai/design-library";

import { useTranslation } from "@/i18n";

/**
 * The emergency stop beside Preferences. The confirmation is deliberate: one
 * click must not be able to take the stack down. Nothing is wired yet, so the
 * dialog's confirm stays inert and says so instead of pretending to act.
 */
export function PanicButton() {
  const { t } = useTranslation("chat");
  const [open, setOpen] = useState(false);

  return (
    <>
      <Button
        variant="ghost"
        iconOnly={<OctagonAlert />}
        aria-label={t("assistantSideMenu.panic.label")}
        title={t("assistantSideMenu.panic.label")}
        onClick={() => setOpen(true)}
      />
      <ConfirmDialog
        open={open}
        title={t("assistantSideMenu.panic.title")}
        message={t("assistantSideMenu.panic.message")}
        icon={OctagonAlert}
        destructive
        confirmDisabled
        confirmLabel={t("assistantSideMenu.panic.unavailable")}
        cancelLabel={t("assistantSideMenu.panic.cancel")}
        onConfirm={() => setOpen(false)}
        onCancel={() => setOpen(false)}
      />
    </>
  );
}
