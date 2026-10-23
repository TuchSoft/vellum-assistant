import type { CSSProperties } from "react";

import { PageShell } from "@/components/page-shell";
import { useAssistantAvatar } from "@/hooks/use-assistant-avatar";
import { useTranslation } from "@/i18n";

import { DashboardAvatar } from "./components/dashboard-avatar";
import { DashboardColumn } from "./components/dashboard-column";
import { DashboardGrid } from "./components/dashboard-grid";
import { PillTabs } from "./components/pill-tabs";
import { AppsPanel } from "./panels/apps-panel";
import { ConversationsPanel } from "./panels/conversations-panel";
import { InfoPanel } from "./panels/info-panel";
import { RunPanel } from "./panels/run-panel";
import { SchedulesPanel } from "./panels/schedules-panel";
import { SystemPanel } from "./panels/system-panel";

const PANEL_CLASS = "mt-3 min-h-0 flex-1 overflow-y-auto pr-1";

/**
 * The assistant's dashboard: three glassy columns over a tinted page, with
 * the projects row reserved below them. Every strip is the design system's
 * pills variant, and each column owns its own tab set.
 */
export function DashboardPage({ assistantId }: { assistantId: string }) {
  const { t } = useTranslation("intelligence");
  const { components, traits, customImageUrl, accentHex } =
    useAssistantAvatar(assistantId);

  // Glass needs a translucent wash: mixing the accent into `transparent`
  // keeps the page behind the tile visible through the blur. Without a
  // character color the columns fall back to the theme's own surfaces.
  const tintStyle = accentHex
    ? ({
        "--card-bg": `color-mix(in srgb, ${accentHex} 6%, transparent)`,
        "--card-feature-bg": `color-mix(in srgb, ${accentHex} 14%, transparent)`,
        "--card-hover": `color-mix(in srgb, ${accentHex} 22%, transparent)`,
        "--card-accent": accentHex,
      } as CSSProperties)
    : undefined;

  return (
    <PageShell className="relative overflow-hidden" style={tintStyle}>
      <DashboardGrid>
        <DashboardColumn title={t("dashboard.columns.conversations")}>
          <PillTabs.Root
            defaultValue="active"
            className="flex min-h-0 flex-1 flex-col"
          >
            <PillTabs.List>
              <PillTabs.Trigger value="active">
                {t("dashboard.tabs.active")}
              </PillTabs.Trigger>
              <PillTabs.Trigger value="recent">
                {t("dashboard.tabs.recent")}
              </PillTabs.Trigger>
              <PillTabs.Trigger value="unread">
                {t("dashboard.tabs.unread")}
              </PillTabs.Trigger>
            </PillTabs.List>
            <PillTabs.Panel value="active" className={PANEL_CLASS}>
              <ConversationsPanel assistantId={assistantId} filter="active" />
            </PillTabs.Panel>
            <PillTabs.Panel value="recent" className={PANEL_CLASS}>
              <ConversationsPanel assistantId={assistantId} filter="recent" />
            </PillTabs.Panel>
            <PillTabs.Panel value="unread" className={PANEL_CLASS}>
              <ConversationsPanel assistantId={assistantId} filter="unread" />
            </PillTabs.Panel>
          </PillTabs.Root>
        </DashboardColumn>

        <DashboardColumn
          title={t("dashboard.columns.system")}
          decoration={
            <DashboardAvatar
              components={components}
              traits={traits}
              customImageUrl={customImageUrl}
            />
          }
        >
          <PillTabs.Root
            defaultValue="system"
            className="flex min-h-0 flex-1 flex-col"
          >
            <PillTabs.List>
              <PillTabs.Trigger value="system">
                {t("dashboard.tabs.system")}
              </PillTabs.Trigger>
              <PillTabs.Trigger value="apps">
                {t("dashboard.tabs.apps")}
              </PillTabs.Trigger>
              <PillTabs.Trigger value="info">
                {t("dashboard.tabs.info")}
              </PillTabs.Trigger>
            </PillTabs.List>
            <PillTabs.Panel value="system" className={PANEL_CLASS}>
              <SystemPanel />
            </PillTabs.Panel>
            <PillTabs.Panel value="apps" className={PANEL_CLASS}>
              <AppsPanel assistantId={assistantId} />
            </PillTabs.Panel>
            <PillTabs.Panel value="info" className={PANEL_CLASS}>
              <InfoPanel assistantId={assistantId} />
            </PillTabs.Panel>
          </PillTabs.Root>
        </DashboardColumn>

        <DashboardColumn title={t("dashboard.columns.work")}>
          <PillTabs.Root
            defaultValue="schedules"
            className="flex min-h-0 flex-1 flex-col"
          >
            <PillTabs.List>
              <PillTabs.Trigger value="schedules">
                {t("dashboard.tabs.schedules")}
              </PillTabs.Trigger>
              <PillTabs.Trigger value="run">
                {t("dashboard.tabs.run")}
              </PillTabs.Trigger>
            </PillTabs.List>
            <PillTabs.Panel value="schedules" className={PANEL_CLASS}>
              <SchedulesPanel assistantId={assistantId} />
            </PillTabs.Panel>
            <PillTabs.Panel value="run" className={PANEL_CLASS}>
              <RunPanel />
            </PillTabs.Panel>
          </PillTabs.Root>
        </DashboardColumn>
      </DashboardGrid>

      {/* Second row: the projects kanban is not built yet, so the row states
          that instead of drawing cards whose data model does not exist. */}
      <section className="mt-3 flex min-h-[120px] flex-col rounded-3xl border border-[var(--border-base)] bg-[var(--card-feature-bg,var(--card-bg))] p-4 backdrop-blur-[32px]">
        <h2 className="text-label-small-default uppercase tracking-[0.14em] text-[var(--content-tertiary)]">
          {t("dashboard.columns.projects")}
        </h2>
        <p className="mt-3 text-body-small-lighter text-[var(--content-tertiary)]">
          {t("dashboard.projects.empty")}
        </p>
      </section>
    </PageShell>
  );
}
