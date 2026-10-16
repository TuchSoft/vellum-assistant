import { sql } from "drizzle-orm";
import {
  bigint,
  index,
  pgTable,
  primaryKey,
  text,
  uniqueIndex,
} from "drizzle-orm/pg-core";

import { conversations } from "./conversations.js";

export const documents = pgTable(
  "documents",
  {
    surfaceId: text("surface_id").primaryKey(),
    conversationId: text("conversation_id")
      .notNull()
      .references(() => conversations.id, { onDelete: "cascade" }),
    title: text("title").notNull(),
    content: text("content").notNull(),
    wordCount: bigint("word_count", { mode: "number" }).notNull().default(0),
    createdAt: bigint("created_at", { mode: "number" }).notNull(),
    updatedAt: bigint("updated_at", { mode: "number" }).notNull(),
    // Bumped by one on every write; conditional saves compare against it.
    revision: bigint("revision", { mode: "number" }).notNull().default(0),
    // Unused by the daemon: no code reads or writes the column, and some rows
    // carry a non-NULL path. It stays in the model because migration 360 puts
    // it in the physical table and the model must keep describing that table.
    workspacePath: text("workspace_path"),
  },
  (table) => [
    // Partial, so the NULL rows stay unconstrained.
    uniqueIndex("idx_documents_workspace_path")
      .on(table.workspacePath)
      .where(sql`workspace_path IS NOT NULL`),
  ],
);

// Junction table mapping a document surface to every conversation it appears in.
export const documentConversations = pgTable(
  "document_conversations",
  {
    surfaceId: text("surface_id")
      .notNull()
      .references(() => documents.surfaceId, { onDelete: "cascade" }),
    conversationId: text("conversation_id").notNull(),
    createdAt: bigint("created_at", { mode: "number" }).notNull(),
  },
  (table) => [
    primaryKey({ columns: [table.surfaceId, table.conversationId] }),
    index("idx_doc_conv_conversation_id").on(table.conversationId),
  ],
);

export const documentComments = pgTable(
  "document_comments",
  {
    id: text("id").primaryKey(),
    surfaceId: text("surface_id")
      .notNull()
      .references(() => documents.surfaceId, { onDelete: "cascade" }),
    conversationId: text("conversation_id").notNull(),
    author: text("author").notNull(),
    content: text("content").notNull(),
    anchorStart: bigint("anchor_start", { mode: "number" }),
    anchorEnd: bigint("anchor_end", { mode: "number" }),
    anchorText: text("anchor_text"),
    // Self-referential parent link (threaded replies). The FK to
    // document_comments(id) ON DELETE CASCADE is enforced at the DB level.
    parentCommentId: text("parent_comment_id"),
    status: text("status").notNull().default("open"),
    resolvedBy: text("resolved_by"),
    resolvedAt: bigint("resolved_at", { mode: "number" }),
    createdAt: bigint("created_at", { mode: "number" }).notNull(),
    updatedAt: bigint("updated_at", { mode: "number" }).notNull(),
  },
  (table) => [
    index("idx_document_comments_surface").on(table.surfaceId),
    index("idx_document_comments_parent").on(table.parentCommentId),
  ],
);

// Snapshots of a document as it stood at `revision`, taken just before a write
// replaced that state. `author` is who made the replacing write.
export const documentRevisions = pgTable(
  "document_revisions",
  {
    surfaceId: text("surface_id")
      .notNull()
      .references(() => documents.surfaceId, { onDelete: "cascade" }),
    revision: bigint("revision", { mode: "number" }).notNull(),
    title: text("title").notNull(),
    content: text("content").notNull(),
    wordCount: bigint("word_count", { mode: "number" }).notNull().default(0),
    author: text("author").notNull(),
    createdAt: bigint("created_at", { mode: "number" }).notNull(),
  },
  (table) => [primaryKey({ columns: [table.surfaceId, table.revision] })],
);
