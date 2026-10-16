import { bigint, pgTable, text } from "drizzle-orm/pg-core";

import { contacts } from "./contacts.js";

export const followups = pgTable("followups", {
  id: text("id").primaryKey(),
  channel: text("channel").notNull(), // 'email', 'slack', 'whatsapp', etc.
  conversationId: text("conversation_id").notNull(), // external conversation identifier
  contactId: text("contact_id").references(() => contacts.id, {
    onDelete: "set null",
  }),
  sentAt: bigint("sent_at", { mode: "number" }).notNull(), // epoch ms — when the outbound message was sent
  expectedResponseBy: bigint("expected_response_by", { mode: "number" }), // epoch ms — deadline for expected reply
  status: text("status").notNull().default("pending"), // 'pending' | 'resolved' | 'overdue' | 'nudged'
  reminderCronId: text("reminder_cron_id"), // optional cron job ID for reminder
  createdAt: bigint("created_at", { mode: "number" }).notNull(),
  updatedAt: bigint("updated_at", { mode: "number" }).notNull(),
});
