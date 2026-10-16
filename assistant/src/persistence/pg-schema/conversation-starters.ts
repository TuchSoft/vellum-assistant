import { bigint, index, pgTable, text } from "drizzle-orm/pg-core";

// Proactive conversation-starter suggestions (home-surface chips/cards),
// regenerated in batches by the home job handler
// (`home/job-handlers/conversation-starters.ts`) and served by
// `runtime/routes/conversation-starter-routes.ts`. Product state owned by the
// home surface — the generator draws on memory content, but the table is not
// part of the memory plugin's storage.
export const conversationStarters = pgTable(
  "conversation_starters",
  {
    id: text("id").primaryKey(),
    label: text("label").notNull(),
    prompt: text("prompt").notNull(),
    generationBatch: bigint("generation_batch", { mode: "number" }).notNull(),
    sourceMemoryKinds: text("source_memory_kinds"),
    category: text("category"),
    icon: text("icon"),
    description: text("description"),
    tags: text("tags"),
    cardType: text("card_type").notNull().default("chip"),
    createdAt: bigint("created_at", { mode: "number" }).notNull(),
  },
  (table) => [
    index("idx_conversation_starters_batch").on(
      table.generationBatch,
      table.createdAt,
    ),
    index("idx_conversation_starters_card_type").on(table.cardType),
  ],
);
