/**
 * Projects in the assistant sidebar: the connected half.
 *
 * Owns the cache-backed tree, the three writes, the archived toggle, and the
 * two dialogs. Every write invalidates and refetches (see `use-projects`), so
 * the list always shows what the store holds; a failure surfaces as a toast
 * (menu actions) or inside the confirmation dialog (archive), and the dialog
 * stays open so the action can be retried.
 *
 * The membership picker is bounded: it subscribes only to the conversations
 * on its current page, because the daemon exposes membership one conversation
 * at a time and there is no reverse read that would list a project's
 * conversations in one request.
 */

import { useCallback, useMemo, useState } from "react";

import { ConfirmDialog, toast } from "@vellumai/design-library";

import { NameInputDialog } from "@/domains/chat/components/name-input-dialog";
import {
  ProjectConversationsDialog,
  type ProjectConversationRow,
} from "@/domains/chat/components/projects/project-conversations-dialog";
import type { ProjectNode } from "@/domains/chat/components/projects/projects-api";
import { ProjectsTree } from "@/domains/chat/components/projects/projects-tree";
import {
  useConversationProjectsFor,
  useProjectsQuery,
  useProjectWriteActions,
  useReplaceConversationProjects,
} from "@/domains/chat/hooks/use-projects";
import { projectAncestorIds } from "@/domains/chat/utils/project-tree";
import { useTranslation } from "@/i18n";
import { useDisplayConversationTitle } from "@/utils/conversation-title";
import type { Conversation } from "@/types/conversation-types";

/** Rows per membership page. Every shown row costs one membership read. */
const MEMBERSHIP_PAGE_SIZE = 20;

export interface ProjectsNavProps {
  assistantId: string | null;
  /**
   * The conversations the sidebar already holds. The membership picker draws
   * from this list rather than loading its own, so it never asks the daemon
   * for a second copy of the history.
   */
  conversations: readonly Conversation[];
}

interface CreateDialogState {
  parentId: string | null;
}

export function ProjectsNav({ assistantId, conversations }: ProjectsNavProps) {
  const { t } = useTranslation("chat");

  const [showArchived, setShowArchived] = useState(false);
  const [expandedIds, setExpandedIds] = useState<ReadonlySet<string>>(
    () => new Set<string>(),
  );
  const [createDialog, setCreateDialog] = useState<CreateDialogState | null>(
    null,
  );
  const [renameTarget, setRenameTarget] = useState<ProjectNode | null>(null);
  const [archiveTarget, setArchiveTarget] = useState<ProjectNode | null>(null);
  const [archiveError, setArchiveError] = useState<string | null>(null);
  const [isArchiving, setIsArchiving] = useState(false);
  const [conversationsTarget, setConversationsTarget] =
    useState<ProjectNode | null>(null);
  const [membershipSearch, setMembershipSearch] = useState("");
  const [membershipPage, setMembershipPage] = useState(1);
  const [membershipError, setMembershipError] = useState<string | null>(null);
  const [membershipPending, setMembershipPending] = useState(false);

  const projectsQuery = useProjectsQuery(assistantId, true, showArchived);
  const displayTitle = useDisplayConversationTitle();
  const writes = useProjectWriteActions(assistantId);
  const replaceConversationProjects = useReplaceConversationProjects(assistantId);

  const toggleExpanded = useCallback((projectId: string) => {
    setExpandedIds((current) => {
      const next = new Set(current);
      if (next.has(projectId)) {
        next.delete(projectId);
      } else {
        next.add(projectId);
      }
      return next;
    });
  }, []);

  const openCreateDialog = useCallback((parentId: string | null) => {
    setCreateDialog({ parentId });
  }, []);

  const handleCreate = useCallback(
    (name: string) => {
      const parentId = createDialog?.parentId ?? null;
      writes
        .create({ name, parentId })
        .then(() => {
          setCreateDialog(null);
          if (parentId !== null) {
            const ancestors = projectAncestorIds(
              projectsQuery.projects,
              parentId,
            );
            setExpandedIds((current) => {
              const next = new Set(current);
              next.add(parentId);
              for (const ancestor of ancestors) {
                next.add(ancestor);
              }
              return next;
            });
          }
        })
        .catch((error: unknown) => {
          toast.error(errorMessage(error, t("projectsNav.createFailed")));
        });
    },
    [createDialog, projectsQuery.projects, t, writes],
  );

  const handleRename = useCallback(
    (name: string) => {
      if (!renameTarget) {
        return;
      }
      writes
        .rename(renameTarget.id, name)
        .then(() => {
          setRenameTarget(null);
        })
        .catch((error: unknown) => {
          toast.error(errorMessage(error, t("projectsNav.renameFailed")));
        });
    },
    [renameTarget, t, writes],
  );

  const confirmArchive = useCallback(() => {
    if (!archiveTarget) {
      return;
    }
    setArchiveError(null);
    setIsArchiving(true);
    writes
      .archive(archiveTarget.id)
      .then(() => {
        setArchiveTarget(null);
      })
      .catch((error: unknown) => {
        setArchiveError(errorMessage(error, t("projectsNav.archiveFailed")));
      })
      .finally(() => {
        setIsArchiving(false);
      });
  }, [archiveTarget, t, writes]);

  const openMembership = useCallback((project: ProjectNode) => {
    setConversationsTarget(project);
    setMembershipSearch("");
    setMembershipPage(1);
    setMembershipError(null);
  }, []);

  const closeMembership = useCallback(() => {
    setConversationsTarget(null);
    setMembershipError(null);
  }, []);

  const filteredConversations = useMemo(() => {
    const needle = membershipSearch.trim().toLowerCase();
    const rows = conversations.map((conversation) => ({
      conversationId: conversation.conversationId,
      title: displayTitle(conversation.title),
    }));
    if (needle === "") {
      return rows;
    }
    return rows.filter((row) => row.title.toLowerCase().includes(needle));
  }, [conversations, displayTitle, membershipSearch]);

  const visibleConversationIds = useMemo(
    () =>
      filteredConversations
        .slice(0, membershipPage * MEMBERSHIP_PAGE_SIZE)
        .map((row) => row.conversationId),
    [filteredConversations, membershipPage],
  );

  const memberships = useConversationProjectsFor(
    assistantId,
    visibleConversationIds,
    conversationsTarget !== null,
  );

  const membershipRows: ProjectConversationRow[] = useMemo(() => {
    const titles = new Map(
      filteredConversations.map((row) => [row.conversationId, row.title]),
    );
    return visibleConversationIds.map((conversationId) => ({
      conversationId,
      title: titles.get(conversationId) ?? conversationId,
      projectIds: memberships.get(conversationId),
    }));
  }, [filteredConversations, memberships, visibleConversationIds]);

  const toggleMembership = useCallback(
    (conversationId: string, nextProjectIds: string[]) => {
      setMembershipError(null);
      setMembershipPending(true);
      replaceConversationProjects(conversationId, nextProjectIds)
        .catch((error: unknown) => {
          setMembershipError(
            errorMessage(error, t("projectsNav.conversationsFailed")),
          );
        })
        .finally(() => {
          setMembershipPending(false);
        });
    },
    [replaceConversationProjects, t],
  );

  return (
    <>
      <ProjectsTree
        projects={projectsQuery.projects}
        isLoading={projectsQuery.isLoading}
        isError={projectsQuery.isError}
        showArchived={showArchived}
        expandedIds={expandedIds}
        onToggleExpanded={toggleExpanded}
        onToggleShowArchived={() => setShowArchived((current) => !current)}
        onRetry={projectsQuery.refetch}
        onNewProject={openCreateDialog}
        onRename={(project) => {
          setRenameTarget(project);
        }}
        onArchive={(project) => {
          setArchiveError(null);
          setArchiveTarget(project);
        }}
        onManageConversations={openMembership}
      />

      <NameInputDialog
        open={createDialog !== null}
        title={t("projectsNav.createTitle")}
        submitLabel={t("projectsNav.createSubmit")}
        initialValue=""
        onSubmit={handleCreate}
        onCancel={() => setCreateDialog(null)}
      />

      <NameInputDialog
        open={renameTarget !== null}
        title={t("projectsNav.renameTitle")}
        submitLabel={t("projectsNav.renameSubmit")}
        initialValue={renameTarget?.name ?? ""}
        onSubmit={handleRename}
        onCancel={() => setRenameTarget(null)}
      />

      <ConfirmDialog
        open={archiveTarget !== null}
        title={t("projectsNav.archiveTitle")}
        message={t("projectsNav.archiveMessage", {
          name: archiveTarget?.name ?? "",
        })}
        confirmLabel={t("projectsNav.archiveConfirm")}
        cancelLabel={t("projectsNav.close")}
        destructive
        isPending={isArchiving}
        error={archiveError}
        onConfirm={confirmArchive}
        onCancel={() => {
          if (!isArchiving) {
            setArchiveTarget(null);
            setArchiveError(null);
          }
        }}
      />

      <ProjectConversationsDialog
        open={conversationsTarget !== null}
        project={conversationsTarget}
        rows={membershipRows}
        search={membershipSearch}
        onSearchChange={(value) => {
          setMembershipSearch(value);
          setMembershipPage(1);
        }}
        hasMore={membershipPage * MEMBERSHIP_PAGE_SIZE < filteredConversations.length}
        onShowMore={() => setMembershipPage((current) => current + 1)}
        onToggle={toggleMembership}
        onClose={closeMembership}
        error={membershipError}
        isPending={membershipPending}
      />
    </>
  );
}

/** Prefer the server's message, fall back to the caller's copy. */
function errorMessage(error: unknown, fallback: string): string {
  if (error instanceof Error && error.message.trim() !== "") {
    return error.message;
  }
  return fallback;
}
