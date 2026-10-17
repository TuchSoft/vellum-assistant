/**
 * `recordDeliveredChannelPost` persists a post the daemon delivered to an
 * external chat as a first-class assistant row: the sent text, the neutral
 * provider envelope with the acknowledged provider id, `automated` so memory
 * extraction leaves it alone, and an entry in the `channel_outbound_posts`
 * index so a later reaction or delete naming the post resolves to the row.
 */

import { beforeEach, expect, test } from "bun:test";

import { readProviderMessageMetadata } from "../messaging/provider-message-metadata.js";
import { recordDeliveredChannelPost } from "../notifications/delivered-post-record.js";
import {
  createConversation,
  getMessageById,
} from "../persistence/conversation-crud.js";
import { requireMainDb } from "../persistence/db-facade.js";
import { safeParseRecord } from "../util/json.js";
import { describePg } from "./pg-test-db.js";

async function resetTables(): Promise<void> {
  const db = requireMainDb();
  await db.run("DELETE FROM channel_outbound_posts");
  await db.run("DELETE FROM messages");
  await db.run("DELETE FROM conversations");
}

describePg("recordDeliveredChannelPost", () => {
  beforeEach(async () => {
    await resetTables();
  });

  test("writes the sent text with the envelope, the acknowledged id, and the index entry", async () => {
    const conversation = await createConversation({
      title: "Slack DM",
      conversationType: "background",
      source: "notification",
    });

    const { messageId } = await recordDeliveredChannelPost({
      conversationId: conversation.id,
      channel: "slack",
      externalChatId: "D0123456789",
      text: "Morning check-in: two items need your eyes today.",
      providerMessageId: "1756800000.000100",
    });

    const row = await getMessageById(messageId);
    expect(row?.role).toBe("assistant");
    expect(JSON.stringify(row?.content)).toContain(
      "Morning check-in: two items need your eyes today.",
    );

    const metadata = safeParseRecord(row?.metadata ?? "{}");
    expect(metadata.automated).toBe(true);
    expect(metadata.assistantMessageChannel).toBe("slack");
    const envelope = readProviderMessageMetadata(metadata.providerMeta);
    expect(envelope?.source).toBe("slack");
    expect(envelope?.conversationExternalId).toBe("D0123456789");
    expect(envelope?.eventKind).toBe("message");
    expect(envelope?.messageId).toBe("1756800000.000100");

    const indexed = await requireMainDb().all<{
      sourceChannel: string;
      externalChatId: string;
      providerMessageId: string;
      conversationId: string;
    }>(
      'SELECT source_channel AS "sourceChannel", external_chat_id AS "externalChatId", provider_message_id AS "providerMessageId", conversation_id AS "conversationId" FROM channel_outbound_posts WHERE message_id = ?',
      [messageId],
    );
    expect(indexed).toHaveLength(1);
    expect(indexed[0]?.sourceChannel).toBe("slack");
    expect(indexed[0]?.externalChatId).toBe("D0123456789");
    expect(indexed[0]?.providerMessageId).toBe("1756800000.000100");
    expect(indexed[0]?.conversationId).toBe(conversation.id);
  });

  test("a Telegram post is recorded the same way", async () => {
    const conversation = await createConversation({
      title: "Telegram chat",
      conversationType: "background",
      source: "notification",
    });

    const { messageId } = await recordDeliveredChannelPost({
      conversationId: conversation.id,
      channel: "telegram",
      externalChatId: "123456789",
      text: "Backup finished.",
      providerMessageId: "4242",
    });

    const envelope = readProviderMessageMetadata(
      safeParseRecord((await getMessageById(messageId))?.metadata ?? "{}")
        .providerMeta,
    );
    expect(envelope?.source).toBe("telegram");
    expect(envelope?.messageId).toBe("4242");
    const indexed = await requireMainDb().all(
      "SELECT provider_message_id FROM channel_outbound_posts WHERE provider_message_id = ?",
      ["4242"],
    );
    expect(indexed).toHaveLength(1);
  });
});
