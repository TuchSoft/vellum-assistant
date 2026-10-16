import { bigint, pgTable, text } from "drizzle-orm/pg-core";

export const a2aInvites = pgTable("a2a_invites", {
  id: text("id").primaryKey(),
  tokenHash: text("token_hash").notNull(),
  contactId: text("contact_id").notNull(),
  maxUses: bigint("max_uses", { mode: "number" }).notNull().default(1),
  useCount: bigint("use_count", { mode: "number" }).notNull().default(0),
  expiresAt: bigint("expires_at", { mode: "number" }).notNull(),
  status: text("status").notNull().default("active"),
  redeemedByExternalUserId: text("redeemed_by_external_user_id"),
  redeemedAt: bigint("redeemed_at", { mode: "number" }),
  createdAt: bigint("created_at", { mode: "number" }).notNull(),
  updatedAt: bigint("updated_at", { mode: "number" }).notNull(),
});

export const a2aTasks = pgTable("a2a_tasks", {
  id: text("id").primaryKey(),
  contextId: text("context_id"),
  conversationId: text("conversation_id"),
  state: text("state").notNull().default("submitted"),
  statusMessage: text("status_message"),
  requestMessageJson: text("request_message_json").notNull(),
  artifactsJson: text("artifacts_json"),
  pushUrl: text("push_url"),
  senderAssistantId: text("sender_assistant_id").notNull(),
  createdAt: bigint("created_at", { mode: "number" }).notNull(),
  updatedAt: bigint("updated_at", { mode: "number" }).notNull(),
});
