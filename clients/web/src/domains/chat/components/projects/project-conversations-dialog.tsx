/**
 * Membership editor for one project: the conversations that belong to it,
 * with a checkbox each.
 *
 * A conversation can belong to several projects, and the write route replaces
 * the whole set, so every toggle re-derives the next set from the one the
 * server last returned (`toggleProjectMembership`) instead of writing a single
 * project id. Removing a conversation from this project leaves its other
 * projects untouched.
 *
 * Presentational: rows arrive already resolved, and a row whose set is still
 * loading is drawn as a disabled indeterminate checkbox rather than as "not a
 * member", so a slow read never looks like an empty membership.
 */

import { useTranslation } from "@/i18n";

import { Button, Checkbox, Input, Modal, cn } from "@vellumai/design-library";

import type { ProjectNode } from "@/domains/chat/components/projects/projects-api";
import { toggleProjectMembership } from "@/domains/chat/utils/project-tree";

export interface ProjectConversationRow {
  conversationId: string;
  title: string;
  /** The conversation's project set, or undefined while it is still loading. */
  projectIds: readonly string[] | undefined;
}

export interface ProjectConversationsDialogProps {
  open: boolean;
  project: ProjectNode | null;
  rows: readonly ProjectConversationRow[];
  search: string;
  onSearchChange: (value: string) => void;
  hasMore: boolean;
  onShowMore: () => void;
  onToggle: (conversationId: string, nextProjectIds: string[]) => void;
  onClose: () => void;
  error: string | null;
  isPending: boolean;
}

export function ProjectConversationsDialog({
  open,
  project,
  rows,
  search,
  onSearchChange,
  hasMore,
  onShowMore,
  onToggle,
  onClose,
  error,
  isPending,
}: ProjectConversationsDialogProps) {
  const { t } = useTranslation("chat");
  const projectName = project?.name ?? "";

  return (
    <Modal.Root
      open={open}
      onOpenChange={(next) => {
        if (!next) {
          onClose();
        }
      }}
    >
      <Modal.Content
        size="md"
        aria-describedby={undefined}
        onEscapeKeyDown={(event) => {
          event.preventDefault();
          event.stopPropagation();
          onClose();
        }}
      >
        <Modal.Header>
          <Modal.Title>
            {t("projectsNav.conversationsTitle", { name: projectName })}
          </Modal.Title>
        </Modal.Header>
        <Modal.Body>
          <p className="mb-3 text-body-small-default text-[var(--content-secondary)]">
            {t("projectsNav.conversationsHint")}
          </p>
          <Input
            label={t("projectsNav.conversationsSearch")}
            value={search}
            onChange={(event) => onSearchChange(event.target.value)}
            autoComplete="off"
            spellCheck={false}
            fullWidth
          />
          {error ? (
            <p
              role="alert"
              className="mt-2 text-body-small-default text-[var(--content-danger)]"
            >
              {error}
            </p>
          ) : null}
          {rows.length === 0 ? (
            <p className="mt-3 text-body-small-default text-[var(--content-tertiary)]">
              {t("projectsNav.conversationsEmpty")}
            </p>
          ) : (
            <ul className="mt-3 flex flex-col gap-1">
              {rows.map((row) => {
                const loaded = row.projectIds !== undefined;
                const checked =
                  loaded && project !== null
                    ? row.projectIds?.includes(project.id) === true
                    : "indeterminate";
                return (
                  <li key={row.conversationId}>
                    <Checkbox
                      checked={checked}
                      disabled={!loaded || project === null || isPending}
                      label={
                        <span
                          className={cn(
                            "truncate",
                            loaded
                              ? "text-[var(--content-primary)]"
                              : "text-[var(--content-tertiary)]",
                          )}
                        >
                          {row.title}
                        </span>
                      }
                      onCheckedChange={() => {
                        if (!project || row.projectIds === undefined) {
                          return;
                        }
                        onToggle(
                          row.conversationId,
                          toggleProjectMembership(
                            row.projectIds,
                            project.id,
                          ),
                        );
                      }}
                    />
                  </li>
                );
              })}
            </ul>
          )}
          {hasMore ? (
            <Button variant="ghost" className="mt-2" onClick={onShowMore}>
              {t("projectsNav.conversationsShowMore")}
            </Button>
          ) : null}
        </Modal.Body>
        <Modal.Footer>
          <Button variant="outlined" onClick={onClose}>
            {t("projectsNav.close")}
          </Button>
        </Modal.Footer>
      </Modal.Content>
    </Modal.Root>
  );
}
