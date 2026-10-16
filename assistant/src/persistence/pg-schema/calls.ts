import {
  bigint,
  doublePrecision,
  index,
  pgTable,
  text,
} from "drizzle-orm/pg-core";

import { conversations } from "./conversations.js";

export const callSessions = pgTable(
  "call_sessions",
  {
    id: text("id").primaryKey(),
    conversationId: text("conversation_id")
      .notNull()
      .references(() => conversations.id, { onDelete: "cascade" }),
    provider: text("provider").notNull(),
    providerCallSid: text("provider_call_sid"),
    fromNumber: text("from_number").notNull(),
    toNumber: text("to_number").notNull(),
    task: text("task"),
    status: text("status").notNull().default("initiated"),
    callMode: text("call_mode"),
    verificationSessionId: text("verification_session_id"),
    inviteFriendName: text("invite_friend_name"),
    inviteGuardianName: text("invite_guardian_name"),
    callerIdentityMode: text("caller_identity_mode"),
    callerIdentitySource: text("caller_identity_source"),
    skipDisclosure: bigint("skip_disclosure", { mode: "number" })
      .notNull()
      .default(0),
    initiatedFromConversationId: text("initiated_from_conversation_id"),
    startedAt: bigint("started_at", { mode: "number" }),
    endedAt: bigint("ended_at", { mode: "number" }),
    lastError: text("last_error"),
    createdAt: bigint("created_at", { mode: "number" }).notNull(),
    updatedAt: bigint("updated_at", { mode: "number" }).notNull(),
  },
  (table) => [index("idx_call_sessions_status").on(table.status)],
);

export const callEvents = pgTable("call_events", {
  id: text("id").primaryKey(),
  callSessionId: text("call_session_id")
    .notNull()
    .references(() => callSessions.id, { onDelete: "cascade" }),
  eventType: text("event_type").notNull(),
  payloadJson: text("payload_json").notNull().default("{}"),
  createdAt: bigint("created_at", { mode: "number" }).notNull(),
});

export const callPendingQuestions = pgTable("call_pending_questions", {
  id: text("id").primaryKey(),
  callSessionId: text("call_session_id")
    .notNull()
    .references(() => callSessions.id, { onDelete: "cascade" }),
  questionText: text("question_text").notNull(),
  status: text("status").notNull().default("pending"),
  askedAt: bigint("asked_at", { mode: "number" }).notNull(),
  answeredAt: bigint("answered_at", { mode: "number" }),
  answerText: text("answer_text"),
});

export const processedCallbacks = pgTable("processed_callbacks", {
  id: text("id").primaryKey(),
  dedupeKey: text("dedupe_key").notNull().unique(),
  callSessionId: text("call_session_id")
    .notNull()
    .references(() => callSessions.id, { onDelete: "cascade" }),
  claimId: text("claim_id"),
  createdAt: bigint("created_at", { mode: "number" }).notNull(),
});

export const externalConversationBindings = pgTable(
  "external_conversation_bindings",
  {
    conversationId: text("conversation_id")
      .primaryKey()
      .references(() => conversations.id, { onDelete: "cascade" }),
    sourceChannel: text("source_channel").notNull(),
    externalChatId: text("external_chat_id").notNull(),
    externalChatName: text("external_chat_name"),
    externalThreadId: text("external_thread_id"),
    externalUserId: text("external_user_id"),
    displayName: text("display_name"),
    username: text("username"),
    createdAt: bigint("created_at", { mode: "number" }).notNull(),
    updatedAt: bigint("updated_at", { mode: "number" }).notNull(),
    lastInboundAt: bigint("last_inbound_at", { mode: "number" }),
    lastOutboundAt: bigint("last_outbound_at", { mode: "number" }),
  },
);

export const mediaAssets = pgTable("media_assets", {
  id: text("id").primaryKey(),
  title: text("title").notNull(),
  filePath: text("file_path").notNull(),
  mimeType: text("mime_type").notNull(),
  durationSeconds: doublePrecision("duration_seconds"),
  fileHash: text("file_hash").notNull(),
  status: text("status").notNull().default("registered"), // registered | processing | indexed | failed
  mediaType: text("media_type").notNull(), // video | audio | image
  metadata: text("metadata"), // JSON
  createdAt: bigint("created_at", { mode: "number" }).notNull(),
  updatedAt: bigint("updated_at", { mode: "number" }).notNull(),
});

export const processingStages = pgTable("processing_stages", {
  id: text("id").primaryKey(),
  assetId: text("asset_id")
    .notNull()
    .references(() => mediaAssets.id, { onDelete: "cascade" }),
  stage: text("stage").notNull(),
  status: text("status").notNull().default("pending"), // pending | running | completed | failed
  progress: bigint("progress", { mode: "number" }).notNull().default(0), // 0-100
  lastError: text("last_error"),
  startedAt: bigint("started_at", { mode: "number" }),
  completedAt: bigint("completed_at", { mode: "number" }),
});

export const mediaKeyframes = pgTable("media_keyframes", {
  id: text("id").primaryKey(),
  assetId: text("asset_id")
    .notNull()
    .references(() => mediaAssets.id, { onDelete: "cascade" }),
  timestamp: doublePrecision("timestamp").notNull(),
  filePath: text("file_path").notNull(),
  metadata: text("metadata"), // JSON
  createdAt: bigint("created_at", { mode: "number" }).notNull(),
});
