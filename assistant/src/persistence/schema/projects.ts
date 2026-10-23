import {
  type AnySQLiteColumn,
  integer,
  primaryKey,
  real,
  sqliteTable,
  text,
} from "drizzle-orm/sqlite-core";

import { conversations } from "./conversations.js";
import { cronJobs } from "./infrastructure.js";

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
export const projects = sqliteTable("projects", {
  id: text("id").primaryKey(),
  name: text("name").notNull(),
  description: text("description"),
  parentId: text("parent_id").references((): AnySQLiteColumn => projects.id, {
    onDelete: "set null",
  }),
  kind: text("kind").notNull().default("user"),
  sortPosition: real("sort_position").notNull().default(0),
  isArchived: integer("is_archived", { mode: "boolean" })
    .notNull()
    .default(false),
  createdAt: integer("created_at").notNull(),
  updatedAt: integer("updated_at").notNull(),
  archivedAt: integer("archived_at"),
});

/**
 * Project membership of a conversation: an unordered set, with no primary
 * project. A conversation sees the union of its projects' material.
 *
 * Both keys cascade so a deleted conversation or project leaves no orphaned
 * membership behind.
 */
export const conversationProjects = sqliteTable(
  "conversation_projects",
  {
    conversationId: text("conversation_id")
      .notNull()
      .references(() => conversations.id, { onDelete: "cascade" }),
    projectId: text("project_id")
      .notNull()
      .references(() => projects.id, { onDelete: "cascade" }),
  },
  (table) => [primaryKey({ columns: [table.conversationId, table.projectId] })],
);

/**
 * Project membership of a schedule: an unordered set, with no primary project.
 * A scheduled run inherits it, so the memory and skill scope of the run follows
 * the project the schedule was filed under.
 *
 * Both keys cascade so a deleted schedule or project leaves no orphaned
 * membership behind.
 */
export const cronJobProjects = sqliteTable(
  "cron_job_projects",
  {
    cronJobId: text("cron_job_id")
      .notNull()
      .references(() => cronJobs.id, { onDelete: "cascade" }),
    projectId: text("project_id")
      .notNull()
      .references(() => projects.id, { onDelete: "cascade" }),
  },
  (table) => [primaryKey({ columns: [table.cronJobId, table.projectId] })],
);
