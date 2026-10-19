/**
 * `conversation_model_updated` SSE event.
 *
 * Broadcast to clients when a conversation's model selection changes.
 * `model` is a gateway alias, or `null` when the pin is cleared and the
 * conversation falls back to `llm.defaultModel`.
 *
 * Canonical wire-contract source. Daemon code imports the type
 * directly from this file; external consumers import via
 * `@vellumai/assistant-api`.
 */

import { z } from "zod";

export const ConversationModelUpdatedEventSchema = z.object({
  type: z.literal("conversation_model_updated"),
  conversationId: z.string(),
  model: z.string().nullable(),
  reasoningEffort: z.string().nullable().optional(),
});

export type ConversationModelUpdatedEvent = z.infer<
  typeof ConversationModelUpdatedEventSchema
>;
