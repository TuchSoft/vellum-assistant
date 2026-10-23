/**
 * Query and mutation hooks for projects.
 *
 * Every project read and write goes through here so the sidebar and its
 * dialogs share one cache and one invalidation rule: after any write the
 * whole `["projects", assistantId]` subtree is refetched. Nothing is written
 * optimistically, so a rename that the server rejects leaves the old name on
 * screen with a visible error rather than a value the store never held.
 *
 * The membership read is per conversation because the daemon has no bulk
 * route for it; the picker therefore only subscribes to the conversations it
 * is actually showing, which bounds the fan-out by the page size rather than
 * by the size of the history.
 */

import {
  useMutation,
  useQueries,
  useQuery,
  useQueryClient,
  type QueryClient,
  type UseQueryResult,
} from "@tanstack/react-query";

import {
  archiveProject,
  createProject,
  fetchConversationProjects,
  fetchProjects,
  renameProject,
  replaceConversationProjects,
  type CreateProjectInput,
  type ProjectNode,
} from "@/domains/chat/components/projects/projects-api";
import { useCanQueryDaemon } from "@/hooks/conversation-queries";

const PROJECTS_KEY = "projects";

const EMPTY_PROJECTS: ProjectNode[] = [];

export const projectQueryKeys = {
  /** Prefix for every project cache of one assistant. */
  all: (assistantId: string) =>
    [PROJECTS_KEY, assistantId, "all"] as const,
  tree: (assistantId: string, includeArchived: boolean) =>
    [PROJECTS_KEY, assistantId, "tree", includeArchived] as const,
  conversationProjects: (assistantId: string, conversationId: string) =>
    [PROJECTS_KEY, assistantId, "conversation", conversationId] as const,
};

/** Invalidate the tree and every membership cache for one assistant. */
export function invalidateProjectQueries(
  queryClient: QueryClient,
  assistantId: string,
): void {
  void queryClient.invalidateQueries({
    queryKey: [PROJECTS_KEY, assistantId],
  });
}

const STALE_TIME_MS = 30_000;

export interface ProjectsQueryResult {
  projects: ProjectNode[];
  isLoading: boolean;
  isError: boolean;
  refetch: () => void;
}

/**
 * The project tree. Archived projects are excluded by default, which is also
 * the route's default: the sidebar reveals them on request instead of drawing
 * them under every visible project.
 */
export function useProjectsQuery(
  assistantId: string | null,
  enabled: boolean = true,
  includeArchived: boolean = false,
): ProjectsQueryResult {
  const canQuery = useCanQueryDaemon(assistantId);
  const query = useQuery({
    queryKey: projectQueryKeys.tree(assistantId ?? "", includeArchived),
    queryFn: async () => {
      if (!assistantId) {
        return EMPTY_PROJECTS;
      }
      return await fetchProjects(assistantId, { includeArchived });
    },
    enabled: enabled && Boolean(assistantId) && canQuery,
    staleTime: STALE_TIME_MS,
  });
  return {
    projects: query.data ?? EMPTY_PROJECTS,
    isLoading: query.isLoading,
    isError: query.isError,
    refetch: () => {
      void query.refetch();
    },
  };
}

export interface ProjectWriteActions {
  create: (input: CreateProjectInput) => Promise<void>;
  rename: (projectId: string, name: string) => Promise<void>;
  archive: (projectId: string) => Promise<void>;
  isPending: boolean;
}

/**
 * The three writes the sidebar offers, with refetch-on-success. Failures
 * propagate to the caller, which reports them next to the control that
 * started the write (a toast for a menu action, the dialog's own error slot
 * for a form).
 */
export function useProjectWriteActions(
  assistantId: string | null,
): ProjectWriteActions {
  const queryClient = useQueryClient();

  const createMutation = useMutation({
    mutationFn: async (input: CreateProjectInput) => {
      if (!assistantId) {
        throw new Error("No assistant selected");
      }
      await createProject(assistantId, input);
    },
    onSuccess: () => {
      if (assistantId) {
        invalidateProjectQueries(queryClient, assistantId);
      }
    },
  });

  const renameMutation = useMutation({
    mutationFn: async (input: { projectId: string; name: string }) => {
      if (!assistantId) {
        throw new Error("No assistant selected");
      }
      await renameProject(assistantId, input.projectId, input.name);
    },
    onSuccess: () => {
      if (assistantId) {
        invalidateProjectQueries(queryClient, assistantId);
      }
    },
  });

  const archiveMutation = useMutation({
    mutationFn: async (projectId: string) => {
      if (!assistantId) {
        throw new Error("No assistant selected");
      }
      await archiveProject(assistantId, projectId);
    },
    onSuccess: () => {
      if (assistantId) {
        invalidateProjectQueries(queryClient, assistantId);
      }
    },
  });

  return {
    create: async (input) => {
      await createMutation.mutateAsync(input);
    },
    rename: async (projectId, name) => {
      await renameMutation.mutateAsync({ projectId, name });
    },
    archive: async (projectId) => {
      await archiveMutation.mutateAsync(projectId);
    },
    isPending:
      createMutation.isPending ||
      renameMutation.isPending ||
      archiveMutation.isPending,
  };
}

/** The project set of one conversation (`GET /v1/conversations/:id/projects`). */
export function useConversationProjectsQuery(
  assistantId: string | null,
  conversationId: string | null,
  enabled: boolean = true,
): UseQueryResult<string[]> {
  const canQuery = useCanQueryDaemon(assistantId);
  return useQuery({
    queryKey: projectQueryKeys.conversationProjects(
      assistantId ?? "",
      conversationId ?? "",
    ),
    queryFn: async () => {
      if (!assistantId || !conversationId) {
        return [];
      }
      return await fetchConversationProjects(assistantId, conversationId);
    },
    enabled:
      enabled &&
      Boolean(assistantId) &&
      Boolean(conversationId) &&
      canQuery,
    staleTime: STALE_TIME_MS,
  });
}

/**
 * Membership for the conversations currently on screen in the picker.
 *
 * One query per conversation, all bounded by the caller's page. A row whose
 * query has not resolved yet reports `undefined`, which the picker draws as a
 * disabled indeterminate checkbox rather than as "not a member".
 */
export function useConversationProjectsFor(
  assistantId: string | null,
  conversationIds: readonly string[],
  enabled: boolean = true,
): Map<string, string[] | undefined> {
  const canQuery = useCanQueryDaemon(assistantId);
  const results = useQueries({
    queries: conversationIds.map((conversationId) => ({
      queryKey: projectQueryKeys.conversationProjects(
        assistantId ?? "",
        conversationId,
      ),
      queryFn: async () => {
        if (!assistantId) {
          return [];
        }
        return await fetchConversationProjects(assistantId, conversationId);
      },
      enabled: enabled && Boolean(assistantId) && canQuery,
      staleTime: STALE_TIME_MS,
    })),
  });

  const memberships = new Map<string, string[] | undefined>();
  conversationIds.forEach((conversationId, index) => {
    memberships.set(conversationId, results[index]?.data);
  });
  return memberships;
}

/** Replace one conversation's project set and refetch what it affects. */
export function useReplaceConversationProjects(
  assistantId: string | null,
): (conversationId: string, projectIds: readonly string[]) => Promise<string[]> {
  const queryClient = useQueryClient();
  return async (conversationId, projectIds) => {
    if (!assistantId) {
      throw new Error("No assistant selected");
    }
    const saved = await replaceConversationProjects(
      assistantId,
      conversationId,
      projectIds,
    );
    queryClient.setQueryData(
      projectQueryKeys.conversationProjects(assistantId, conversationId),
      saved,
    );
    return saved;
  };
}
