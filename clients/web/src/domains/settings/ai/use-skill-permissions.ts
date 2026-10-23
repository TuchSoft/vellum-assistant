/**
 * Data and mutations behind the skill permission card.
 *
 * Three reads feed the card:
 * - the installed skills, from the daemon (`GET /v1/skills`);
 * - each skill's current content version, from `local-inspect` (the version
 *   hash the grants are keyed by; the list route does not expose it);
 * - every grant, from the gateway (`GET /v1/permissions/skill-grants`).
 *
 * The installed version is what makes the card able to classify a grant as
 * current or stale, and to address a grant for a skill that has none yet.
 *
 * Writes go to the gateway and are never optimistic: after a successful write
 * the grant list is refetched, so the switches always show stored state.
 */

import {
  useMutation,
  useQueries,
  useQuery,
  useQueryClient,
} from "@tanstack/react-query";
import { useMemo } from "react";
import { z } from "zod";

import {
  skillsByIdLocalinspectGetOptions,
  skillsGetOptions,
} from "@/generated/daemon/@tanstack/react-query.gen";
import { useTranslation } from "@/i18n";
import { captureError } from "@/lib/sentry/capture-error";
import {
  deleteSkillGrant,
  listSkillGrants,
  putSkillGrant,
  type SkillCapability,
} from "@/lib/skill-grants-api";
import { toast } from "@vellumai/design-library/components/toast";

import {
  buildSkillPermissionRows,
  toggleCapability,
  type InstalledSkill,
  type SkillPermissionRow,
} from "./skill-permissions-model";

const LocalInspectVersionSchema = z.object({
  versionHash: z.string().nullable().optional(),
});

/** Only the hash is read from the local inspect payload. */
function readVersionHash(payload: unknown): string | null {
  const parsed = LocalInspectVersionSchema.safeParse(payload);
  return parsed.success ? (parsed.data.versionHash ?? null) : null;
}

function grantsQueryKey(assistantId: string) {
  return ["skill-grants", assistantId] as const;
}

export interface UseSkillPermissionsResult {
  rows: SkillPermissionRow[];
  isLoading: boolean;
  error: Error | null;
  refetch: () => void;
  /** Skill whose grant is being written right now, if any. */
  savingSkillId: string | null;
  setCapability: (
    row: SkillPermissionRow,
    capability: SkillCapability,
    enabled: boolean,
  ) => void;
  /**
   * Revoke a grant. Defaults to the installed version; a stale grant passes
   * its own hash so the old row is the one removed.
   */
  revoke: (row: SkillPermissionRow, versionHash?: string) => void;
}

export function useSkillPermissions(
  assistantId: string,
): UseSkillPermissionsResult {
  const { t } = useTranslation("settings");
  const queryClient = useQueryClient();

  const skillsQuery = useQuery(
    skillsGetOptions({ path: { assistant_id: assistantId } }),
  );

  const installedSkills = useMemo((): InstalledSkill[] => {
    const skills = skillsQuery.data?.skills ?? [];
    return skills
      .filter(
        (skill) => skill.kind !== "catalog" && skill.status !== "available",
      )
      .map((skill) => ({
        id: skill.id,
        name: skill.name,
        ...(skill.emoji ? { emoji: skill.emoji } : {}),
        kind: skill.kind,
        status: skill.status,
      }));
  }, [skillsQuery.data]);

  const versionQueries = useQueries({
    queries: installedSkills.map((skill) => ({
      ...skillsByIdLocalinspectGetOptions({
        path: { assistant_id: assistantId, id: skill.id },
      }),
      // A skill version changes only when its content changes, so a page
      // revisit within the window does not re-hash every skill directory.
      staleTime: 60_000,
    })),
  });

  const versionHashes = useMemo((): Record<string, string | null> => {
    const hashes: Record<string, string | null> = {};
    installedSkills.forEach((skill, index) => {
      hashes[skill.id] = readVersionHash(versionQueries[index]?.data);
    });
    return hashes;
  }, [installedSkills, versionQueries]);

  const grantsQuery = useQuery({
    queryKey: grantsQueryKey(assistantId),
    queryFn: listSkillGrants,
    staleTime: 15_000,
  });

  const rows = useMemo(
    () =>
      buildSkillPermissionRows(
        installedSkills,
        versionHashes,
        grantsQuery.data ?? [],
      ),
    [installedSkills, versionHashes, grantsQuery.data],
  );

  const invalidateGrants = () => {
    void queryClient.invalidateQueries({
      queryKey: grantsQueryKey(assistantId),
    });
  };

  const putMutation = useMutation({
    mutationFn: putSkillGrant,
    onSuccess: () => {
      invalidateGrants();
      toast.success(t("skillPermissions.grantSaved"));
    },
    onError: (error) => {
      captureError(error, { context: "settings-skill-permissions-save" });
      toast.error(t("skillPermissions.saveError"));
    },
  });

  const deleteMutation = useMutation({
    mutationFn: (input: { skillId: string; versionHash: string }) =>
      deleteSkillGrant(input.skillId, input.versionHash),
    onSuccess: () => {
      invalidateGrants();
      toast.success(t("skillPermissions.grantRevoked"));
    },
    onError: (error) => {
      captureError(error, { context: "settings-skill-permissions-revoke" });
      toast.error(t("skillPermissions.revokeError"));
    },
  });

  const setCapability = (
    row: SkillPermissionRow,
    capability: SkillCapability,
    enabled: boolean,
  ) => {
    if (!row.versionHash) {
      return;
    }
    putMutation.mutate({
      skillId: row.skill.id,
      versionHash: row.versionHash,
      capabilities: toggleCapability(row.capabilities, capability, enabled),
    });
  };

  const revoke = (row: SkillPermissionRow, versionHash?: string) => {
    const target = versionHash ?? row.versionHash;
    if (!target) {
      return;
    }
    deleteMutation.mutate({
      skillId: row.skill.id,
      versionHash: target,
    });
  };

  const savingSkillId = putMutation.isPending
    ? (putMutation.variables?.skillId ?? null)
    : deleteMutation.isPending
      ? (deleteMutation.variables?.skillId ?? null)
      : null;

  const versionsPending = versionQueries.some((query) => query.isPending);

  return {
    rows,
    isLoading:
      skillsQuery.isPending || grantsQuery.isPending || versionsPending,
    error: skillsQuery.error ?? grantsQuery.error ?? null,
    refetch: () => {
      void skillsQuery.refetch();
      void grantsQuery.refetch();
    },
    savingSkillId,
    setCapability,
    revoke,
  };
}
