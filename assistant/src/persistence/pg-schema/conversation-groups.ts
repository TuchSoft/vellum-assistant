import {
  bigint,
  boolean,
  doublePrecision,
  pgTable,
  text,
} from "drizzle-orm/pg-core";

export const conversationGroups = pgTable("conversation_groups", {
  id: text("id").primaryKey(),
  name: text("name").notNull(),
  /** Client-chosen icon name (e.g. a Lucide icon key); null = client default. */
  icon: text("icon"),
  sortPosition: doublePrecision("sort_position").notNull().default(0),
  isSystemGroup: boolean("is_system_group").notNull().default(false),
  createdAt: bigint("created_at", { mode: "number" }).notNull(),
  updatedAt: bigint("updated_at", { mode: "number" }).notNull(),
});
