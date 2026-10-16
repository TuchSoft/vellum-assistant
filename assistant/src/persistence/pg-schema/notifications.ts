import {
  bigint,
  boolean,
  doublePrecision,
  index,
  pgTable,
  text,
  uniqueIndex,
} from "drizzle-orm/pg-core";

import { conversations } from "./conversations.js";

export const notificationEvents = pgTable("notification_events", {
  id: text("id").primaryKey(),
  sourceEventName: text("source_event_name").notNull(),
  sourceChannel: text("source_channel").notNull(),
  sourceContextId: text("source_context_id").notNull(),
  attentionHintsJson: text("attention_hints_json").notNull().default("{}"),
  payloadJson: text("payload_json").notNull().default("{}"),
  dedupeKey: text("dedupe_key"),
  createdAt: bigint("created_at", { mode: "number" }).notNull(),
  updatedAt: bigint("updated_at", { mode: "number" }).notNull(),
});

export const notificationDecisions = pgTable("notification_decisions", {
  id: text("id").primaryKey(),
  notificationEventId: text("notification_event_id")
    .notNull()
    .references(() => notificationEvents.id, { onDelete: "cascade" }),
  shouldNotify: bigint("should_notify", { mode: "number" }).notNull(),
  selectedChannels: text("selected_channels").notNull().default("[]"),
  reasoningSummary: text("reasoning_summary").notNull(),
  confidence: doublePrecision("confidence").notNull(),
  fallbackUsed: bigint("fallback_used", { mode: "number" })
    .notNull()
    .default(0),
  promptVersion: text("prompt_version"),
  validationResults: text("validation_results"),
  createdAt: bigint("created_at", { mode: "number" }).notNull(),
});

export const notificationPreferences = pgTable("notification_preferences", {
  id: text("id").primaryKey(),
  preferenceText: text("preference_text").notNull(),
  appliesWhenJson: text("applies_when_json").notNull().default("{}"),
  priority: bigint("priority", { mode: "number" }).notNull().default(0),
  createdAt: bigint("created_at", { mode: "number" }).notNull(),
  updatedAt: bigint("updated_at", { mode: "number" }).notNull(),
});

export const sequences = pgTable("sequences", {
  id: text("id").primaryKey(),
  name: text("name").notNull(),
  description: text("description"),
  channel: text("channel").notNull(),
  steps: text("steps").notNull(), // JSON array of SequenceStep
  exitOnReply: boolean("exit_on_reply").notNull().default(true),
  status: text("status").notNull().default("active"), // active | paused | archived
  createdAt: bigint("created_at", { mode: "number" }).notNull(),
  updatedAt: bigint("updated_at", { mode: "number" }).notNull(),
});

export const sequenceEnrollments = pgTable(
  "sequence_enrollments",
  {
    id: text("id").primaryKey(),
    sequenceId: text("sequence_id")
      .notNull()
      .references(() => sequences.id, { onDelete: "cascade" }),
    contactEmail: text("contact_email").notNull(),
    contactName: text("contact_name"),
    currentStep: bigint("current_step", { mode: "number" })
      .notNull()
      .default(0),
    status: text("status").notNull().default("active"), // active | paused | completed | replied | cancelled | failed
    conversationId: text("conversation_id"),
    nextStepAt: bigint("next_step_at", { mode: "number" }), // epoch ms
    context: text("context"), // JSON
    createdAt: bigint("created_at", { mode: "number" }).notNull(),
    updatedAt: bigint("updated_at", { mode: "number" }).notNull(),
  },
  (table) => [
    index("idx_seq_enrollments_status_next_step").on(
      table.status,
      table.nextStepAt,
    ),
    index("idx_seq_enrollments_sequence_id").on(table.sequenceId),
    index("idx_seq_enrollments_contact_email").on(table.contactEmail),
  ],
);

export const notificationDeliveries = pgTable(
  "notification_deliveries",
  {
    id: text("id").primaryKey(),
    notificationDecisionId: text("notification_decision_id")
      .notNull()
      .references(() => notificationDecisions.id, { onDelete: "cascade" }),
    channel: text("channel").notNull(),
    destination: text("destination").notNull(),
    status: text("status").notNull().default("pending"),
    attempt: bigint("attempt", { mode: "number" }).notNull().default(1),
    renderedTitle: text("rendered_title"),
    renderedBody: text("rendered_body"),
    errorCode: text("error_code"),
    errorMessage: text("error_message"),
    sentAt: bigint("sent_at", { mode: "number" }),
    conversationId: text("conversation_id"),
    messageId: text("message_id"),
    /**
     * The assistant row a successful channel delivery was recorded as, once
     * the channel acknowledged it. `messageId` keeps its meaning (provider
     * id for a channel delivery, row id for a vellum delivery); this names
     * the row for the edit and delete paths. NULL for vellum and platform
     * deliveries and for any channel delivery that did not succeed.
     */
    canonicalMessageId: text("canonical_message_id"),
    conversationStrategy: text("conversation_strategy"),
    conversationAction: text("conversation_action"),
    conversationTargetId: text("conversation_target_id"),
    conversationFallbackUsed: bigint("conversation_fallback_used", {
      mode: "number",
    }),
    clientDeliveryStatus: text("client_delivery_status"),
    clientDeliveryError: text("client_delivery_error"),
    clientDeliveryAt: bigint("client_delivery_at", { mode: "number" }),
    createdAt: bigint("created_at", { mode: "number" }).notNull(),
    updatedAt: bigint("updated_at", { mode: "number" }).notNull(),
  },
  (table) => [
    uniqueIndex("idx_notification_deliveries_decision_channel").on(
      table.notificationDecisionId,
      table.channel,
    ),
  ],
);

export const conversationAttentionEvents = pgTable(
  "conversation_attention_events",
  {
    id: text("id").primaryKey(),
    conversationId: text("conversation_id")
      .notNull()
      .references(() => conversations.id, { onDelete: "cascade" }),
    sourceChannel: text("source_channel").notNull(),
    signalType: text("signal_type").notNull(),
    confidence: text("confidence").notNull(),
    source: text("source").notNull(),
    evidenceText: text("evidence_text"),
    metadataJson: text("metadata_json").notNull().default("{}"),
    observedAt: bigint("observed_at", { mode: "number" }).notNull(),
    createdAt: bigint("created_at", { mode: "number" }).notNull(),
  },
  (table) => [
    index("idx_conv_attn_events_conv_observed").on(
      table.conversationId,
      table.observedAt,
    ),
    index("idx_conv_attn_events_observed").on(table.observedAt),
    index("idx_conv_attn_events_channel_observed").on(
      table.sourceChannel,
      table.observedAt,
    ),
  ],
);

export const conversationAssistantAttentionState = pgTable(
  "conversation_assistant_attention_state",
  {
    conversationId: text("conversation_id")
      .primaryKey()
      .references(() => conversations.id, { onDelete: "cascade" }),
    latestAssistantMessageId: text("latest_assistant_message_id"),
    latestAssistantMessageAt: bigint("latest_assistant_message_at", {
      mode: "number",
    }),
    lastSeenAssistantMessageId: text("last_seen_assistant_message_id"),
    lastSeenAssistantMessageAt: bigint("last_seen_assistant_message_at", {
      mode: "number",
    }),
    lastSeenEventAt: bigint("last_seen_event_at", { mode: "number" }),
    lastSeenConfidence: text("last_seen_confidence"),
    lastSeenSignalType: text("last_seen_signal_type"),
    lastSeenSourceChannel: text("last_seen_source_channel"),
    lastSeenSource: text("last_seen_source"),
    lastSeenEvidenceText: text("last_seen_evidence_text"),
    createdAt: bigint("created_at", { mode: "number" }).notNull(),
    updatedAt: bigint("updated_at", { mode: "number" }).notNull(),
  },
  (table) => [
    index("idx_conv_attn_state_latest_msg").on(table.latestAssistantMessageAt),
    index("idx_conv_attn_state_last_seen").on(table.lastSeenAssistantMessageAt),
  ],
);
