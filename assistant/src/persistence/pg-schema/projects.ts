import { sql } from "drizzle-orm";
import {
  type AnyPgColumn,
  bigint,
  boolean,
  check,
  doublePrecision,
  index,
  pgTable,
  primaryKey,
  text,
  uniqueIndex,
} from "drizzle-orm/pg-core";

import { conversations } from "./conversations.js";

/**
 * A project is a name with a briefing: it says that a certain body of work
 * belongs together, where its material lives, and which items belong to it. It
 * owns no data of its own.
 *
 * `kind` separates the three shapes a row can take:
 * - `user`: created by a person or the agent.
 * - `system`: the background and scheduled buckets, kept out of the normal
 *   list and not archivable.
 * - `inbox`: the single catch-all project, not archivable.
 *
 * `parent_id` is a free-depth hierarchy. Membership lives in
 * `conversation_projects`, not in `conversations.group_id`: a pin rewrites
 * `group_id` to `system:pinned`, so project membership on that column would be
 * destroyed by pinning.
 */
export const projects = pgTable(
  "projects",
  {
    id: text("id").primaryKey(),
    name: text("name").notNull(),
    description: text("description"),
    parentId: text("parent_id").references((): AnyPgColumn => projects.id, {
      onDelete: "set null",
    }),
    kind: text("kind").notNull().default("user"),
    sortPosition: doublePrecision("sort_position").notNull().default(0),
    isArchived: boolean("is_archived").notNull().default(false),
    createdAt: bigint("created_at", { mode: "number" }).notNull(),
    updatedAt: bigint("updated_at", { mode: "number" }).notNull(),
    archivedAt: bigint("archived_at", { mode: "number" }),
  },
  (table) => [
    check(
      "projects_kind_check",
      sql`${table.kind} IN ('user', 'system', 'inbox')`,
    ),
    check(
      "projects_inbox_not_archived_check",
      sql`${table.kind} <> 'inbox' OR ${table.archivedAt} IS NULL`,
    ),
    uniqueIndex("projects_inbox_singleton")
      .on(table.kind)
      .where(sql`${table.kind} = 'inbox'`),
    index("idx_projects_parent").on(table.parentId),
    index("idx_projects_kind_archived").on(table.kind, table.isArchived),
  ],
);

/**
 * Project membership of a conversation: an unordered set, with no primary
 * project. A conversation sees the union of its projects' material.
 *
 * Both keys cascade so a deleted conversation or project leaves no orphaned
 * membership behind.
 */
export const conversationProjects = pgTable(
  "conversation_projects",
  {
    conversationId: text("conversation_id")
      .notNull()
      .references(() => conversations.id, { onDelete: "cascade" }),
    projectId: text("project_id")
      .notNull()
      .references(() => projects.id, { onDelete: "cascade" }),
  },
  (table) => [
    primaryKey({ columns: [table.conversationId, table.projectId] }),
    index("idx_conversation_projects_project").on(table.projectId),
  ],
);
