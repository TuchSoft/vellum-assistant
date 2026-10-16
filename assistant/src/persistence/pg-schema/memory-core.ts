import { bigint, pgTable, text, uniqueIndex } from "drizzle-orm/pg-core";

import { conversations, messages } from "./conversations.js";
import { bytea } from "./custom-types.js";

export const memorySegments = pgTable("memory_segments", {
  id: text("id").primaryKey(),
  messageId: text("message_id")
    .notNull()
    .references(() => messages.id, { onDelete: "cascade" }),
  conversationId: text("conversation_id")
    .notNull()
    .references(() => conversations.id, { onDelete: "cascade" }),
  role: text("role").notNull(),
  segmentIndex: bigint("segment_index", { mode: "number" }).notNull(),
  text: text("text").notNull(),
  tokenEstimate: bigint("token_estimate", { mode: "number" }).notNull(),
  contentHash: text("content_hash"),
  createdAt: bigint("created_at", { mode: "number" }).notNull(),
  updatedAt: bigint("updated_at", { mode: "number" }).notNull(),
});

export const memorySummaries = pgTable(
  "memory_summaries",
  {
    id: text("id").primaryKey(),
    scope: text("scope").notNull(),
    scopeKey: text("scope_key").notNull(),
    summary: text("summary").notNull(),
    tokenEstimate: bigint("token_estimate", { mode: "number" }).notNull(),
    version: bigint("version", { mode: "number" }).notNull().default(1),
    startAt: bigint("start_at", { mode: "number" }).notNull(),
    endAt: bigint("end_at", { mode: "number" }).notNull(),
    createdAt: bigint("created_at", { mode: "number" }).notNull(),
    updatedAt: bigint("updated_at", { mode: "number" }).notNull(),
  },
  (table) => [
    uniqueIndex("idx_memory_summaries_scope_scope_key").on(
      table.scope,
      table.scopeKey,
    ),
  ],
);

export const memoryEmbeddings = pgTable(
  "memory_embeddings",
  {
    id: text("id").primaryKey(),
    targetType: text("target_type").notNull(),
    targetId: text("target_id").notNull(),
    provider: text("provider").notNull(),
    model: text("model").notNull(),
    dimensions: bigint("dimensions", { mode: "number" }).notNull(),
    vectorJson: text("vector_json"),
    vectorBlob: bytea("vector_blob"),
    contentHash: text("content_hash"),
    createdAt: bigint("created_at", { mode: "number" }).notNull(),
    updatedAt: bigint("updated_at", { mode: "number" }).notNull(),
  },
  (table) => [
    uniqueIndex("idx_memory_embeddings_target_provider_model").on(
      table.targetType,
      table.targetId,
      table.provider,
      table.model,
    ),
  ],
);

// Background job queue for the memory plugin. Lives in the dedicated memory
// database (`assistant-memory.db`), not main — access it via the memory
// connection (`getMemoryDb()` / `getMemorySqlite()`).
export const memoryJobs = pgTable("memory_jobs", {
  id: text("id").primaryKey(),
  type: text("type").notNull(),
  payload: text("payload").notNull(),
  status: text("status").notNull(),
  attempts: bigint("attempts", { mode: "number" }).notNull().default(0),
  deferrals: bigint("deferrals", { mode: "number" }).notNull().default(0),
  runAfter: bigint("run_after", { mode: "number" }).notNull(),
  lastError: text("last_error"),
  startedAt: bigint("started_at", { mode: "number" }),
  createdAt: bigint("created_at", { mode: "number" }).notNull(),
  updatedAt: bigint("updated_at", { mode: "number" }).notNull(),
});

export const memoryCheckpoints = pgTable("memory_checkpoints", {
  key: text("key").primaryKey(),
  value: text("value").notNull(),
  updatedAt: bigint("updated_at", { mode: "number" }).notNull(),
});

// Per-conversation retrospective job pointers and cumulative remembered log.
// Lives in the dedicated memory database (`assistant-memory.db`), not main —
// access it via the memory connection (`getMemoryDb()` / `getMemorySqlite()`).
export const memoryRetrospectiveState = pgTable("memory_retrospective_state", {
  conversationId: text("conversation_id").primaryKey(),
  lastProcessedMessageId: text("last_processed_message_id").notNull(),
  lastRunAt: bigint("last_run_at", { mode: "number" }).notNull(),
  // `createdAt` of the `last_processed_message_id` row when the pointer was
  // written, so the cursor still bounds reads after that row is deleted.
  // NULL when unknown. Added lazily by `ensureRetrospectiveCursorColumn`
  // (memory-retrospective-state.ts), not by the migration chain.
  lastProcessedCreatedAt: bigint("last_processed_created_at", {
    mode: "number",
  }),
  // JSON array of strings — cumulative `remember` contents from prior
  // retrospective passes (capped; see memory-retrospective-state.ts).
  // NULL for rows that predate migration 281 or have no saves yet.
  rememberedLog: text("remembered_log"),
});
