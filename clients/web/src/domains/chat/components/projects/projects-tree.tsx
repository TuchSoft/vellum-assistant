/**
 * The projects list drawn in the assistant sidebar.
 *
 * Presentational on purpose: the tree arrives as data and every write leaves
 * through a callback, so the component can be tested without a daemon and the
 * connected wrapper keeps the only copy of the cache concerns.
 *
 * Shape:
 *
 *   Projects                     [+]  (create)
 *     v Inbox                         ... (rename, conversations)
 *     > Client X
 *         - Contract review           ... (rename, archive, conversations)
 *     Show archived
 *
 * The Inbox is a normal node with one rule removed: it cannot be archived
 * (the server answers 403), so no archive action is drawn for it. Archived
 * projects are hidden until the footer toggle asks for them, which is the
 * route's own default too.
 */

import { ChevronRight, MessageSquare, MoreHorizontal, Pencil, Plus, Trash2 } from "lucide-react";

import {
  ActionMenu,
  Button,
  cn,
} from "@vellumai/design-library";

import type { ProjectNode } from "@/domains/chat/components/projects/projects-api";
import {
  canArchiveProject,
  isInboxProject,
  visibleProjectRows,
} from "@/domains/chat/utils/project-tree";
import {
  SIDEBAR_ROW_PADDING_X,
  SIDEBAR_STACK_GAP,
  SIDEBAR_SECTION_TITLE_TEXT_CLASSES,
} from "@/components/sidebar-nav-geometry";
import { useTranslation } from "@/i18n";

/** One nesting level's indent, in px. */
const DEPTH_INDENT = 12;

const ROW_HEIGHT = 30;

export interface ProjectsTreeProps {
  projects: readonly ProjectNode[];
  isLoading: boolean;
  isError: boolean;
  showArchived: boolean;
  expandedIds: ReadonlySet<string>;
  onToggleExpanded: (projectId: string) => void;
  onToggleShowArchived: () => void;
  onRetry: () => void;
  onNewProject: (parentId: string | null) => void;
  onRename: (project: ProjectNode) => void;
  onArchive: (project: ProjectNode) => void;
  onManageConversations: (project: ProjectNode) => void;
}

function ProjectRow({
  project,
  depth,
  hasChildren,
  expanded,
  showArchived,
  onToggleExpanded,
  onNewProject,
  onRename,
  onArchive,
  onManageConversations,
}: {
  project: ProjectNode;
  depth: number;
  hasChildren: boolean;
  expanded: boolean;
  showArchived: boolean;
  onToggleExpanded: (projectId: string) => void;
  onNewProject: (parentId: string | null) => void;
  onRename: (project: ProjectNode) => void;
  onArchive: (project: ProjectNode) => void;
  onManageConversations: (project: ProjectNode) => void;
}) {
  const { t } = useTranslation("chat");
  const inbox = isInboxProject(project);
  const archived = project.isArchived && showArchived;

  return (
    <div
      className="group/project flex items-center rounded-[10px] hover:bg-[var(--surface-hover)]"
      style={{
        height: ROW_HEIGHT,
        paddingLeft: SIDEBAR_ROW_PADDING_X + depth * DEPTH_INDENT,
      }}
      data-project-id={project.id}
    >
      {hasChildren ? (
        <Button
          variant="ghost"
          iconOnly={<ChevronRight />}
          expandOnMobile={false}
          aria-label={
            expanded
              ? t("projectsNav.collapseAria", { name: project.name })
              : t("projectsNav.expandAria", { name: project.name })
          }
          aria-expanded={expanded}
          className={cn(
            "size-5 shrink-0 p-0",
            expanded && "rotate-90",
          )}
          onClick={() => onToggleExpanded(project.id)}
        />
      ) : (
        <span aria-hidden className="size-5 shrink-0" />
      )}
      <span
        className={cn(
          "flex min-w-0 flex-1 items-center truncate pl-[6px] text-left text-body-medium-lighter",
          archived
            ? "text-[var(--content-tertiary)]"
            : "text-[var(--content-primary)]",
        )}
        title={project.name}
      >
        <span className="truncate">{project.name}</span>
        {archived ? (
          <span className="ml-1 shrink-0 text-body-small-default text-[var(--content-tertiary)]">
            {t("projectsNav.archivedBadge")}
          </span>
        ) : null}
      </span>
      <ActionMenu.Root>
        <ActionMenu.Trigger asChild>
          <Button
            variant="ghost"
            iconOnly={<MoreHorizontal />}
            expandOnMobile={false}
            className="size-6 shrink-0 opacity-0 group-hover/project:opacity-100 focus-visible:opacity-100 data-[state=open]:opacity-100"
            aria-label={t("projectsNav.nodeActionsAria", {
              name: project.name,
            })}
          />
        </ActionMenu.Trigger>
        <ActionMenu.Content
          title={project.name}
          align="end"
          closeLabel={t("projectsNav.actionsClose")}
        >
          {inbox ? null : (
            <ActionMenu.Item
              icon={Plus}
              label={t("projectsNav.newSubproject")}
              onSelect={() => onNewProject(project.id)}
            />
          )}
          <ActionMenu.Item
            icon={Pencil}
            label={t("projectsNav.rename")}
            onSelect={() => onRename(project)}
          />
          <ActionMenu.Item
            icon={MessageSquare}
            label={t("projectsNav.conversations")}
            onSelect={() => onManageConversations(project)}
          />
          {canArchiveProject(project) ? (
            <ActionMenu.Item
              icon={Trash2}
              label={t("projectsNav.archive")}
              tone="destructive"
              onSelect={() => onArchive(project)}
            />
          ) : null}
        </ActionMenu.Content>
      </ActionMenu.Root>
    </div>
  );
}

export function ProjectsTree({
  projects,
  isLoading,
  isError,
  showArchived,
  expandedIds,
  onToggleExpanded,
  onToggleShowArchived,
  onRetry,
  onNewProject,
  onRename,
  onArchive,
  onManageConversations,
}: ProjectsTreeProps) {
  const { t } = useTranslation("chat");
  const rows =
    projects.length === 0
      ? []
      : visibleProjectRows(projects, (id) => expandedIds.has(id));

  return (
    <div
      className={cn(
        SIDEBAR_STACK_GAP,
        "flex w-full flex-col rounded-[16px] bg-[var(--sidebar-card-surface,var(--surface-lift))] px-1 py-1",
      )}
    >
      <div
        className="flex items-center justify-between"
        style={{ paddingLeft: SIDEBAR_ROW_PADDING_X - 4, height: 28 }}
      >
        <span className={SIDEBAR_SECTION_TITLE_TEXT_CLASSES}>
          {t("projectsNav.title")}
        </span>
        <Button
          variant="ghost"
          iconOnly={<Plus />}
          expandOnMobile={false}
          className="size-6"
          aria-label={t("projectsNav.newProject")}
          onClick={() => onNewProject(null)}
        />
      </div>

      {isError ? (
        <div className="flex flex-col items-start gap-1 px-2 pb-2">
          <span className="text-body-small-default text-[var(--content-secondary)]">
            {t("projectsNav.loadError")}
          </span>
          <Button variant="ghost" onClick={onRetry}>
            {t("projectsNav.retry")}
          </Button>
        </div>
      ) : isLoading && rows.length === 0 ? (
        <div
          aria-hidden
          className="mx-2 mb-2 h-3 w-24 animate-pulse rounded bg-[var(--surface-overlay)]"
        />
      ) : rows.length === 0 ? (
        <span className="px-2 pb-2 text-body-small-default text-[var(--content-tertiary)]">
          {t("projectsNav.empty")}
        </span>
      ) : (
        <ul className="flex flex-col" aria-label={t("projectsNav.title")}>
          {rows.map(({ project, depth, hasChildren }) => (
            <li key={project.id}>
              <ProjectRow
                project={project}
                depth={depth}
                hasChildren={hasChildren}
                expanded={expandedIds.has(project.id)}
                showArchived={showArchived}
                onToggleExpanded={onToggleExpanded}
                onNewProject={onNewProject}
                onRename={onRename}
                onArchive={onArchive}
                onManageConversations={onManageConversations}
              />
            </li>
          ))}
        </ul>
      )}

      <div className="flex justify-start px-1 pb-1">
        <Button variant="ghost" onClick={onToggleShowArchived}>
          {showArchived
            ? t("projectsNav.hideArchived")
            : t("projectsNav.showArchived")}
        </Button>
      </div>
    </div>
  );
}
