import { bigint, boolean, index, pgTable, text } from "drizzle-orm/pg-core";

export const contacts = pgTable("contacts", {
  id: text("id").primaryKey(),
  displayName: text("display_name").notNull(),
  notes: text("notes"),
  createdAt: bigint("created_at", { mode: "number" }).notNull(),
  updatedAt: bigint("updated_at", { mode: "number" }).notNull(),
  userFile: text("user_file"), // workspace-relative path to per-user persona file
  contactType: text("contact_type", { enum: ["human", "assistant"] })
    .notNull()
    .default("human"),
});

export const contactChannels = pgTable(
  "contact_channels",
  {
    id: text("id").primaryKey(),
    contactId: text("contact_id")
      .notNull()
      .references(() => contacts.id, { onDelete: "cascade" }),
    type: text("type").notNull(), // 'email', 'slack', 'whatsapp', 'phone', etc.
    address: text("address").notNull(), // the actual identifier on that channel
    isPrimary: boolean("is_primary").notNull().default(false),
    externalChatId: text("external_chat_id"), // delivery/notification routing address (e.g., Telegram chat ID)
    updatedAt: bigint("updated_at", { mode: "number" }), // epoch ms
    createdAt: bigint("created_at", { mode: "number" }).notNull(),
  },
  (table) => [
    index("idx_contact_channels_type_ext_chat").on(
      table.type,
      table.externalChatId,
    ),
  ],
);

export const assistantContactMetadata = pgTable("assistant_contact_metadata", {
  contactId: text("contact_id")
    .primaryKey()
    .references(() => contacts.id, { onDelete: "cascade" }),
  species: text("species").notNull(), // 'vellum' | 'openclaw'
  metadata: text("metadata"), // JSON blob for species-specific fields
});
