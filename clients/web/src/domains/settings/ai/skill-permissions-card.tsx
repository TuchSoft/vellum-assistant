/**
 * Skill permissions settings card.
 *
 * Every capability a skill can use is granted per skill version in the
 * gateway. This card shows the installed skills, the version their grant is
 * keyed by, and a switch per capability. A write goes to the gateway and the
 * card refetches; nothing is shown as granted until the store says so.
 */

import { Loader2 } from "lucide-react";

import { DetailCard } from "@/components/detail-card";
import { useTranslation } from "@/i18n";
import type { SkillCapability } from "@/lib/skill-grants-api";
import { Button } from "@vellumai/design-library/components/button";
import { Tag } from "@vellumai/design-library/components/tag";
import { Toggle } from "@vellumai/design-library/components/toggle";

import { useSkillPermissions } from "./use-skill-permissions";
import {
  shortVersionHash,
  type SkillPermissionRow,
  type SkillPermissionStatus,
} from "./skill-permissions-model";

const CAPABILITIES: readonly {
  id: SkillCapability;
  labelKey:
    | "skillPermissions.capabilities.host_exec.label"
    | "skillPermissions.capabilities.vetted.label"
    | "skillPermissions.capabilities.input_repairs.label"
    | "skillPermissions.capabilities.computer_use_target.label";
  descriptionKey:
    | "skillPermissions.capabilities.host_exec.description"
    | "skillPermissions.capabilities.vetted.description"
    | "skillPermissions.capabilities.input_repairs.description"
    | "skillPermissions.capabilities.computer_use_target.description";
}[] = [
  {
    id: "host_exec",
    labelKey: "skillPermissions.capabilities.host_exec.label",
    descriptionKey: "skillPermissions.capabilities.host_exec.description",
  },
  {
    id: "vetted",
    labelKey: "skillPermissions.capabilities.vetted.label",
    descriptionKey: "skillPermissions.capabilities.vetted.description",
  },
  {
    id: "input_repairs",
    labelKey: "skillPermissions.capabilities.input_repairs.label",
    descriptionKey: "skillPermissions.capabilities.input_repairs.description",
  },
  {
    id: "computer_use_target",
    labelKey: "skillPermissions.capabilities.computer_use_target.label",
    descriptionKey:
      "skillPermissions.capabilities.computer_use_target.description",
  },
];

const STATUS_TONE: Record<
  SkillPermissionStatus,
  "positive" | "neutral" | "warning"
> = {
  granted: "positive",
  denied: "neutral",
  version_changed: "warning",
  unavailable: "neutral",
};

function statusLabelKey(
  status: SkillPermissionStatus,
):
  | "skillPermissions.statusGranted"
  | "skillPermissions.statusDenied"
  | "skillPermissions.statusVersionChanged"
  | "skillPermissions.statusUnavailable" {
  switch (status) {
    case "granted":
      return "skillPermissions.statusGranted";
    case "version_changed":
      return "skillPermissions.statusVersionChanged";
    case "unavailable":
      return "skillPermissions.statusUnavailable";
    default:
      return "skillPermissions.statusDenied";
  }
}

function SkillPermissionRowView({
  row,
  saving,
  onSetCapability,
  onRevoke,
}: {
  row: SkillPermissionRow;
  saving: boolean;
  onSetCapability: (
    row: SkillPermissionRow,
    capability: SkillCapability,
    enabled: boolean,
  ) => void;
  onRevoke: (row: SkillPermissionRow, versionHash?: string) => void;
}) {
  const { t } = useTranslation("settings");
  const editable = row.versionHash !== null;
  // The header action targets the installed version, so it only appears when
  // a grant for that version exists. A stale grant is revoked from its own
  // row below.
  const hasCurrentGrant = row.grantedBy !== null;

  return (
    <li className="flex flex-col gap-3 border-t border-[var(--border-subtle)] py-4 first:border-t-0 first:pt-0 last:pb-0">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="flex min-w-0 flex-col gap-1">
          <div className="flex flex-wrap items-center gap-2">
            {row.skill.emoji && <span aria-hidden>{row.skill.emoji}</span>}
            <h3 className="text-body-medium-default text-[var(--content-emphasised)]">
              {row.skill.name}
            </h3>
            <Tag tone={STATUS_TONE[row.status]}>
              {t(statusLabelKey(row.status))}
            </Tag>
            {row.skill.status === "disabled" && (
              <Tag tone="neutral">{t("skillPermissions.disabledSkill")}</Tag>
            )}
            {row.shortVersion && (
              <Tag tone="neutral" title={row.versionHash ?? undefined}>
                {t("skillPermissions.versionLabel", {
                  version: row.shortVersion,
                })}
              </Tag>
            )}
            {row.status === "granted" && row.grantedBy !== null && (
              <Tag tone="info">
                {row.grantedBy === "defaults"
                  ? t("skillPermissions.grantedByDefault")
                  : t("skillPermissions.grantedByManual")}
              </Tag>
            )}
          </div>
          <p className="font-mono text-body-small-default text-[var(--content-tertiary)]">
            {row.skill.id}
          </p>
        </div>
        {hasCurrentGrant && (
          <Button
            variant="ghost"
            size="compact"
            disabled={saving}
            onClick={() => onRevoke(row)}
          >
            {t("skillPermissions.revoke")}
          </Button>
        )}
      </div>

      {row.status === "unavailable" && (
        <p className="text-body-small-default text-[var(--content-tertiary)]">
          {t("skillPermissions.unavailableHint")}
        </p>
      )}

      {row.staleGrants.length > 0 && (
        <div className="flex flex-col gap-2 rounded-md bg-[var(--surface-lift)] p-3">
          {row.status === "version_changed" && (
            <p className="text-body-small-default text-[var(--content-secondary)]">
              {t("skillPermissions.versionChangedHint")}
            </p>
          )}
          <ul className="flex flex-col gap-2">
            {row.staleGrants.map((grant) => (
              <li
                key={grant.versionHash}
                className="flex flex-wrap items-center justify-between gap-2"
              >
                <div className="flex flex-wrap items-center gap-2">
                  <Tag tone="neutral" title={grant.versionHash}>
                    {t("skillPermissions.versionLabel", {
                      version: shortVersionHash(grant.versionHash),
                    })}
                  </Tag>
                  <span className="text-body-small-default text-[var(--content-tertiary)]">
                    {grant.capabilities.length > 0
                      ? grant.capabilities.join(", ")
                      : t("skillPermissions.noCapabilities")}
                  </span>
                </div>
                <Button
                  variant="ghost"
                  size="compact"
                  disabled={saving}
                  onClick={() => onRevoke(row, grant.versionHash)}
                >
                  {t("skillPermissions.revoke")}
                </Button>
              </li>
            ))}
          </ul>
        </div>
      )}

      <div className="grid gap-3 sm:grid-cols-2">
        {CAPABILITIES.map((capability) => {
          const checked = row.capabilities.includes(capability.id);
          const label = t(capability.labelKey);
          return (
            <div
              key={capability.id}
              className="flex items-start justify-between gap-3"
            >
              <div className="flex min-w-0 flex-col">
                <span className="text-body-small-default text-[var(--content-default)]">
                  {label}
                </span>
                <span className="text-body-small-default text-[var(--content-tertiary)]">
                  {t(capability.descriptionKey)}
                </span>
              </div>
              <Toggle
                size="sm"
                checked={checked}
                disabled={!editable || saving}
                onChange={(enabled) =>
                  onSetCapability(row, capability.id, enabled)
                }
                aria-label={t("skillPermissions.capabilityToggleLabel", {
                  capability: label,
                  skill: row.skill.name,
                })}
              />
            </div>
          );
        })}
      </div>
    </li>
  );
}

export function SkillPermissionsCard({ assistantId }: { assistantId: string }) {
  const { t } = useTranslation("settings");
  const {
    rows,
    isLoading,
    error,
    refetch,
    savingSkillId,
    setCapability,
    revoke,
  } = useSkillPermissions(assistantId);

  return (
    <DetailCard
      title={t("skillPermissions.title")}
      subtitle={t("skillPermissions.description")}
    >
      {error ? (
        <div className="flex flex-col items-start gap-2">
          <p className="text-body-medium-default text-[var(--content-secondary)]">
            {t("skillPermissions.loadError")}
          </p>
          <Button variant="ghost" size="compact" onClick={refetch}>
            {t("skillPermissions.retry")}
          </Button>
        </div>
      ) : isLoading ? (
        <div className="flex items-center gap-2 text-body-medium-default text-[var(--content-tertiary)]">
          <Loader2 className="h-4 w-4 animate-spin" aria-hidden />
          {t("skillPermissions.loading")}
        </div>
      ) : rows.length === 0 ? (
        <p className="text-body-medium-default text-[var(--content-tertiary)]">
          {t("skillPermissions.empty")}
        </p>
      ) : (
        <ul className="flex flex-col">
          {rows.map((row) => (
            <SkillPermissionRowView
              key={row.skill.id}
              row={row}
              saving={savingSkillId === row.skill.id}
              onSetCapability={setCapability}
              onRevoke={revoke}
            />
          ))}
        </ul>
      )}
    </DetailCard>
  );
}
