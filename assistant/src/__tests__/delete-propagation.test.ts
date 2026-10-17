/**
 * Tests for delete propagation into stored messages.
 *
 * The gateway forwards delete events with `eventKind: "delete"` and
 * `sourceMetadata.messageId` set to the deleted message's ts. The daemon
 * marks the corresponding stored row's `slackMeta.deletedAt` while leaving
 * the `content` column untouched (audit retention; the renderer elides based
 * on the deletedAt marker).
 */
import { beforeEach, expect, mock, test } from "bun:test";

import { readProviderMetadata } from "../messaging/read-provider-metadata.js";

mock.module("../config/env.js", () => ({
  isHttpAuthDisabled: () => true,
  getGatewayInternalBaseUrl: () => "http://127.0.0.1:7830",
}));

// A client showing the conversation learns of the deletion through the
// messages-changed invalidation; capture it rather than opening the SSE hub.
const publishedConversationIds: string[] = [];
const actualSyncEvents =
  await import("../runtime/sync/resource-sync-events.js");
mock.module("../runtime/sync/resource-sync-events.js", () => ({
  ...actualSyncEvents,
  publishConversationMessagesChanged: (conversationId: string) => {
    publishedConversationIds.push(conversationId);
  },
}));

import {
  readSlackMetadata,
  readSlackMetadataFromMessageMetadata,
  writeSlackMetadata,
} from "../messaging/providers/slack/message-metadata.js";
import { requireMainDb } from "../persistence/db-facade.js";
import { linkMessage, recordInbound } from "../persistence/delivery-crud.js";
import { _setDeleteLookupConfigForTests } from "../runtime/routes/inbound-message-handler.js";
import {
  handleChannelInbound,
  seedContactChannel,
} from "./helpers/channel-test-adapter.js";
import { describePg } from "./pg-test-db.js";

interface MessageRowView {
  id: string;
  conversationId: string;
  role: string;
  content: string;
  metadata: string | null;
  createdAt: number;
}

async function insertMessage(row: {
  id: string;
  conversationId: string;
  role: string;
  content: string;
  createdAt: number;
  metadata?: string;
}): Promise<void> {
  await requireMainDb().run(
    "INSERT INTO messages (id, conversation_id, role, content, created_at, metadata) VALUES (?, ?, ?, ?, ?, ?)",
    [
      row.id,
      row.conversationId,
      row.role,
      row.content,
      row.createdAt,
      row.metadata ?? null,
    ],
  );
}

async function readMessage(id: string): Promise<MessageRowView | null> {
  return requireMainDb().get<MessageRowView>(
    'SELECT id, conversation_id AS "conversationId", role, content, metadata, created_at AS "createdAt" FROM messages WHERE id = ?',
    [id],
  );
}

async function updateMessageMetadata(
  id: string,
  metadata: string,
): Promise<void> {
  await requireMainDb().run("UPDATE messages SET metadata = ? WHERE id = ?", [
    metadata,
    id,
  ]);
}

const TEST_BEARER_TOKEN = "test-token";
// Slack `message_deleted` events stamp the deleted message's original author
// as the actor (gateway: `event.previous_message.user`). The author must be a
// recognised member for the inbound ACL to admit the event — gating delete
// behind ACL is the contract under test.
const SLACK_DELETE_ACTOR_ID = "U_DELETE_ACTOR";
const SLACK_DELETE_ACTOR_DISPLAY_NAME = "Delete Actor";

async function resetState(): Promise<void> {
  publishedConversationIds.length = 0;
  const db = requireMainDb();
  await db.run("DELETE FROM channel_inbound_events");
  await db.run("DELETE FROM messages");
  await db.run("DELETE FROM conversations");
  await db.run("DELETE FROM conversation_keys");
  await db.run("DELETE FROM contact_channels");
  await db.run("DELETE FROM contacts");
}

async function seedActiveDeleteActor(externalChatId: string): Promise<void> {
  await seedContactChannel({
    sourceChannel: "slack",
    externalUserId: SLACK_DELETE_ACTOR_ID,
    externalChatId,
    status: "active",
    policy: "allow",
    displayName: SLACK_DELETE_ACTOR_DISPLAY_NAME,
  });
}

interface SeededMessage {
  conversationId: string;
  messageId: string;
  originalTs: string;
  externalChatId: string;
}

async function seedSlackMessage(opts: {
  externalChatId: string;
  originalTs: string;
  content?: string;
  withSlackMeta?: boolean;
}): Promise<SeededMessage> {
  // Record the inbound event so channel_inbound_events has an entry
  // (sourceMessageId = ts for the lookup join).
  const inbound = await recordInbound(
    "slack",
    opts.externalChatId,
    opts.originalTs,
    {
      sourceMessageId: opts.originalTs,
    },
  );

  const messageId = `msg-${opts.originalTs}`;
  const slackMeta = opts.withSlackMeta
    ? writeSlackMetadata({
        source: "slack",
        channelId: opts.externalChatId,
        channelTs: opts.originalTs,
        eventKind: "message",
        displayName: "Test User",
      })
    : undefined;
  const metadata = slackMeta
    ? JSON.stringify({
        userMessageChannel: "slack",
        userMessageInterface: "slack",
        slackMeta,
      })
    : JSON.stringify({
        userMessageChannel: "slack",
        userMessageInterface: "slack",
      });

  await insertMessage({
    id: messageId,
    conversationId: inbound.conversationId,
    role: "user",
    content: opts.content ?? "Original message text",
    createdAt: Date.now(),
    metadata,
  });
  await linkMessage(inbound.eventId, messageId);

  return {
    conversationId: inbound.conversationId,
    messageId,
    originalTs: opts.originalTs,
    externalChatId: opts.externalChatId,
  };
}

function buildSlackDeleteRequest(opts: {
  externalChatId: string;
  deletedTs: string;
  eventId?: string;
  actorExternalId?: string;
}): Request {
  const eventId = opts.eventId ?? `evt-del-${opts.deletedTs}`;
  return new Request("http://localhost:8080/channels/inbound", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "X-Gateway-Origin": TEST_BEARER_TOKEN,
    },
    body: JSON.stringify({
      sourceChannel: "slack",
      interface: "slack",
      conversationExternalId: opts.externalChatId,
      // Delete events get a fresh externalMessageId per-event (PR 5).
      externalMessageId: eventId,
      content: "",
      callbackData: "message_deleted",
      actorExternalId: opts.actorExternalId ?? SLACK_DELETE_ACTOR_ID,
      sourceMetadata: {
        // The original (deleted) message's ts — the lookup key.
        messageId: opts.deletedTs,
      },
    }),
  });
}

describePg("Discord delete propagation (unattributed)", () => {
  beforeEach(async () => {
    await resetState();
    _setDeleteLookupConfigForTests(2, 20);
  });

  test("an unattributed delete applies only to an ingested row, without ACL identity", async () => {
    // Discord's MESSAGE_DELETE names no actor, so the gateway forwards the
    // synthetic discord-system id with actorUnattributed stated. No member
    // exists for that id and no trust verdict rides the event; the delete
    // still applies, because the original's author cleared the ACL when the
    // message arrived and the stamp touches only that ingested row.
    const chatId = "999888777666555444";
    const originalId = "111222333444555001";
    const inbound = await recordInbound("discord", chatId, originalId, {
      sourceMessageId: originalId,
    });
    const messageId = `msg-${originalId}`;
    await insertMessage({
      id: messageId,
      conversationId: inbound.conversationId,
      role: "user",
      content: "A message someone later deleted",
      metadata: JSON.stringify({ userMessageChannel: "discord" }),
      createdAt: Date.now(),
    });
    await linkMessage(inbound.eventId, messageId);

    const req = new Request("http://localhost:8080/channels/inbound", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-Gateway-Origin": TEST_BEARER_TOKEN,
      },
      body: JSON.stringify({
        sourceChannel: "discord",
        interface: "discord",
        conversationExternalId: chatId,
        externalMessageId: `${originalId}:delete`,
        eventKind: "delete",
        content: "",
        actorExternalId: "discord-system",
        sourceMetadata: {
          messageId: originalId,
          actorUnattributed: true,
        },
      }),
    });
    const resp = await handleChannelInbound(req, undefined, TEST_BEARER_TOKEN);
    const json = (await resp.json()) as Record<string, unknown>;

    expect(json.accepted).toBe(true);
    expect(json.deleted).toBe(true);

    const row = await readMessage(messageId);
    expect(row!.content).toBe("A message someone later deleted");
    const neutral = readProviderMetadata(row!.metadata);
    expect(neutral).not.toBeNull();
    expect(neutral!.source).toBe("discord");
    expect(neutral!.deletedAt).toBeDefined();
  });

  test("deleting the assistant's own post stamps its row via the stored provider id", async () => {
    // A moderator removing the assistant's reply: the post opened no inbound
    // event, so resolution can only go through the provider id its row
    // carries (stamped at reserve, reconciled at delivery). The retry window
    // is not paid: no inbound event exists to wait on.
    const chatId = "999888777666555444";
    const sentId = "111222333444555777";
    const minted = await recordInbound(
      "discord",
      chatId,
      "evt-earlier-user-msg",
    );
    const messageId = "assistant-reply-1";
    await insertMessage({
      id: messageId,
      conversationId: minted.conversationId,
      role: "assistant",
      content: "The reply a moderator later removed",
      metadata: JSON.stringify({
        assistantMessageChannel: "discord",
        providerMeta: JSON.stringify({
          source: "discord",
          conversationExternalId: chatId,
          messageId: sentId,
          eventKind: "message",
        }),
      }),
      createdAt: Date.now(),
    });

    const req = new Request("http://localhost:8080/channels/inbound", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-Gateway-Origin": TEST_BEARER_TOKEN,
      },
      body: JSON.stringify({
        sourceChannel: "discord",
        interface: "discord",
        conversationExternalId: chatId,
        externalMessageId: `${sentId}:delete`,
        eventKind: "delete",
        content: "",
        actorExternalId: "discord-system",
        sourceMetadata: {
          messageId: sentId,
          actorUnattributed: true,
        },
      }),
    });
    const resp = await handleChannelInbound(req, undefined, TEST_BEARER_TOKEN);
    const json = (await resp.json()) as Record<string, unknown>;

    expect(json.accepted).toBe(true);
    expect(json.deleted).toBe(true);
    expect(json.messageId).toBe(messageId);

    const row = await readMessage(messageId);
    // Content survives: the stamp records loss of channel visibility, not an
    // erasure of what the assistant said.
    expect(row!.content).toBe("The reply a moderator later removed");
    const neutral = readProviderMetadata(row!.metadata);
    expect(neutral!.deletedAt).toBeDefined();
    expect(neutral!.messageId).toBe(sentId);
    expect(publishedConversationIds).toEqual([minted.conversationId]);
  });

  test("deleting one post of a split reply keeps the surviving posts live", async () => {
    const chatId = "999888777666555444";
    const minted = await recordInbound("discord", chatId, "evt-split-seed");
    const primaryId = "111222333444555801";
    const additionalId = "111222333444555802";
    await insertMessage({
      id: "assistant-split-reply",
      conversationId: minted.conversationId,
      role: "assistant",
      content: "part one and part two",
      metadata: JSON.stringify({
        providerMeta: JSON.stringify({
          source: "discord",
          conversationExternalId: chatId,
          messageId: primaryId,
          additionalMessageIds: [additionalId],
          eventKind: "message",
        }),
      }),
      createdAt: Date.now(),
    });

    const deleteReq = (postId: string) =>
      new Request("http://localhost:8080/channels/inbound", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "X-Gateway-Origin": TEST_BEARER_TOKEN,
        },
        body: JSON.stringify({
          sourceChannel: "discord",
          interface: "discord",
          conversationExternalId: chatId,
          externalMessageId: `${postId}:delete`,
          eventKind: "delete",
          content: "",
          actorExternalId: "discord-system",
          sourceMetadata: { messageId: postId, actorUnattributed: true },
        }),
      });

    // Deleting the ADDITIONAL post: tracked per id, the row stays visible.
    const first = await handleChannelInbound(
      deleteReq(additionalId),
      undefined,
      TEST_BEARER_TOKEN,
    );
    expect(((await first.json()) as Record<string, unknown>).deleted).toBe(
      true,
    );
    const afterFirst = readProviderMetadata(
      (await readMessage("assistant-split-reply"))!.metadata,
    );
    expect(afterFirst!.deletedMessageIds).toEqual([additionalId]);
    expect(afterFirst!.deletedAt).toBeUndefined();

    // Deleting the PRIMARY post too: every post is gone, the row-level
    // marker lands.
    const second = await handleChannelInbound(
      deleteReq(primaryId),
      undefined,
      TEST_BEARER_TOKEN,
    );
    expect(((await second.json()) as Record<string, unknown>).deleted).toBe(
      true,
    );
    const afterSecond = readProviderMetadata(
      (await readMessage("assistant-split-reply"))!.metadata,
    );
    expect(new Set(afterSecond!.deletedMessageIds)).toEqual(
      new Set([additionalId, primaryId]),
    );
    expect(afterSecond!.deletedAt).toBeDefined();
  });

  test("a delete racing the outbound id reconciliation resolves on retry", async () => {
    _setDeleteLookupConfigForTests(3, 30);
    const chatId = "999888777666555444";
    const sentId = "111222333444555803";
    const minted = await recordInbound("discord", chatId, "evt-race-seed");
    // The pre-send stamp: the envelope names no id yet, exactly the state a
    // fast automated deletion races.
    await insertMessage({
      id: "assistant-racing-reply",
      conversationId: minted.conversationId,
      role: "assistant",
      content: "posted a moment ago",
      metadata: JSON.stringify({
        providerMeta: JSON.stringify({
          source: "discord",
          conversationExternalId: chatId,
          eventKind: "message",
        }),
      }),
      createdAt: Date.now(),
    });
    // The post-send reconciliation lands while the delete lookup is in its
    // backoff window.
    setTimeout(() => {
      void updateMessageMetadata(
        "assistant-racing-reply",
        JSON.stringify({
          providerMeta: JSON.stringify({
            source: "discord",
            conversationExternalId: chatId,
            messageId: sentId,
            eventKind: "message",
          }),
        }),
      );
    }, 45);

    const resp = await handleChannelInbound(
      new Request("http://localhost:8080/channels/inbound", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "X-Gateway-Origin": TEST_BEARER_TOKEN,
        },
        body: JSON.stringify({
          sourceChannel: "discord",
          interface: "discord",
          conversationExternalId: chatId,
          externalMessageId: `${sentId}:delete`,
          eventKind: "delete",
          content: "",
          actorExternalId: "discord-system",
          sourceMetadata: { messageId: sentId, actorUnattributed: true },
        }),
      }),
      undefined,
      TEST_BEARER_TOKEN,
    );
    expect(((await resp.json()) as Record<string, unknown>).deleted).toBe(true);
    const meta = readProviderMetadata(
      (await readMessage("assistant-racing-reply"))!.metadata,
    );
    expect(meta!.deletedAt).toBeDefined();
  });

  test("deleting an old post beyond the recency window resolves via the deep scan", async () => {
    const chatId = "999888777666555444";
    const oldId = "111222333444555804";
    const minted = await recordInbound("discord", chatId, "evt-old-seed");
    await insertMessage({
      id: "assistant-old-post",
      conversationId: minted.conversationId,
      role: "assistant",
      content: "an old reply",
      metadata: JSON.stringify({
        providerMeta: JSON.stringify({
          source: "discord",
          conversationExternalId: chatId,
          messageId: oldId,
          eventKind: "message",
        }),
      }),
      createdAt: 1_000_000,
    });
    // Bury it under more metadata-bearing rows than the recency-capped
    // reaction lookup examines.
    for (let start = 0; start < 450; start += 50) {
      const values: string[] = [];
      const params: Array<string | number> = [];
      for (let i = start; i < Math.min(start + 50, 450); i++) {
        values.push("(?, ?, 'user', 'filler', ?, ?)");
        params.push(
          `filler-${i}`,
          minted.conversationId,
          2_000_000 + i,
          JSON.stringify({
            providerMeta: JSON.stringify({
              source: "discord",
              conversationExternalId: chatId,
              messageId: `filler-post-${i}`,
              eventKind: "message",
            }),
          }),
        );
      }
      await requireMainDb().run(
        `INSERT INTO messages (id, conversation_id, role, content, created_at, metadata) VALUES ${values.join(", ")}`,
        params,
      );
    }

    const resp = await handleChannelInbound(
      new Request("http://localhost:8080/channels/inbound", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "X-Gateway-Origin": TEST_BEARER_TOKEN,
        },
        body: JSON.stringify({
          sourceChannel: "discord",
          interface: "discord",
          conversationExternalId: chatId,
          externalMessageId: `${oldId}:delete`,
          eventKind: "delete",
          content: "",
          actorExternalId: "discord-system",
          sourceMetadata: { messageId: oldId, actorUnattributed: true },
        }),
      }),
      undefined,
      TEST_BEARER_TOKEN,
    );
    const json = (await resp.json()) as Record<string, unknown>;
    expect(json.deleted).toBe(true);
    expect(json.messageId).toBe("assistant-old-post");
  });

  test("an unattributed delete for a never-ingested message is a no-op", async () => {
    const req = new Request("http://localhost:8080/channels/inbound", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-Gateway-Origin": TEST_BEARER_TOKEN,
      },
      body: JSON.stringify({
        sourceChannel: "discord",
        interface: "discord",
        conversationExternalId: "999888777666555444",
        externalMessageId: "111222333444555002:delete",
        eventKind: "delete",
        content: "",
        actorExternalId: "discord-system",
        sourceMetadata: {
          messageId: "111222333444555002",
          actorUnattributed: true,
        },
      }),
    });
    const resp = await handleChannelInbound(req, undefined, TEST_BEARER_TOKEN);
    const json = (await resp.json()) as Record<string, unknown>;

    expect(json.accepted).toBe(true);
    expect(json.deleted).toBe(false);
  });
});

describePg("Slack delete propagation", () => {
  beforeEach(async () => {
    await resetState();
    seedActiveDeleteActor("C0123CHANNEL");
    // Keep the lookup retry-loop fast by default so the "no such message"
    // paths don't pay the full production backoff. The race-test below
    // overrides this to a longer delay so the first retry can observe
    // the deferred linkMessage.
    _setDeleteLookupConfigForTests(2, 20);
  });

  test("marks slackMeta.deletedAt and leaves content untouched", async () => {
    const seeded = await seedSlackMessage({
      externalChatId: "C0123CHANNEL",
      originalTs: "1234.5678",
      content: "Original audited text",
      withSlackMeta: true,
    });

    const before = Date.now();
    const req = buildSlackDeleteRequest({
      externalChatId: seeded.externalChatId,
      deletedTs: seeded.originalTs,
    });
    const resp = await handleChannelInbound(req, undefined, TEST_BEARER_TOKEN);
    const json = (await resp.json()) as Record<string, unknown>;
    const after = Date.now();

    expect(resp.status).toBe(200);
    expect(json.accepted).toBe(true);
    expect(json.deleted).toBe(true);
    expect(json.messageId).toBe(seeded.messageId);
    const row = await readMessage(seeded.messageId);

    expect(row).toBeDefined();
    // Content column MUST be unchanged for audit.
    expect(row!.content).toBe("Original audited text");

    // Parent metadata still has its sibling keys intact.
    const parsed = JSON.parse(row!.metadata!) as Record<string, unknown>;
    expect(parsed.userMessageChannel).toBe("slack");
    expect(parsed.userMessageInterface).toBe("slack");
    expect(typeof parsed.slackMeta).toBe("string");

    // slackMeta.deletedAt is set to a recent timestamp.
    const slackMeta = readSlackMetadata(parsed.slackMeta as string);
    expect(slackMeta).not.toBeNull();
    expect(slackMeta!.deletedAt).toBeDefined();
    expect(slackMeta!.deletedAt!).toBeGreaterThanOrEqual(before);
    expect(slackMeta!.deletedAt!).toBeLessThanOrEqual(after);
    // Existing slackMeta fields are preserved.
    expect(slackMeta!.channelId).toBe("C0123CHANNEL");
    expect(slackMeta!.channelTs).toBe("1234.5678");
    expect(slackMeta!.eventKind).toBe("message");
    expect(slackMeta!.displayName).toBe("Test User");
    // A client showing the conversation is told to refetch.
    expect(publishedConversationIds).toEqual([seeded.conversationId]);
  });

  test("deleting the assistant's own Slack post is recorded without an actor", async () => {
    // Slack names a deleted post's author and never who deleted it, so the
    // gateway forwards a deletion of the assistant's own post unattributed
    // (LUM-3521). The post opened no inbound event; the row resolves through
    // the `channelTs` its Slack envelope carries, and the stamp lands on
    // that envelope, where the Slack renderers read it.
    const chatId = "C0123CHANNEL";
    const postTs = "1725100000.000900";
    const minted = await recordInbound("slack", chatId, "evt-earlier-user-msg");
    const messageId = "assistant-slack-reply-1";
    await insertMessage({
      id: messageId,
      conversationId: minted.conversationId,
      role: "assistant",
      content: "The reply that was later deleted from the thread",
      metadata: JSON.stringify({
        assistantMessageChannel: "slack",
        slackMeta: writeSlackMetadata({
          source: "slack",
          channelId: chatId,
          channelTs: postTs,
          threadTs: "1725100000.000100",
          eventKind: "message",
        }),
      }),
      createdAt: Date.now(),
    });

    const req = new Request("http://localhost:8080/channels/inbound", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-Gateway-Origin": TEST_BEARER_TOKEN,
      },
      body: JSON.stringify({
        sourceChannel: "slack",
        interface: "slack",
        conversationExternalId: chatId,
        externalMessageId: "evt-del-own-post",
        eventKind: "delete",
        content: "",
        actorExternalId: "slack-system",
        sourceMetadata: {
          messageId: postTs,
          threadId: "1725100000.000100",
          actorUnattributed: true,
        },
      }),
    });
    const resp = await handleChannelInbound(req, undefined, TEST_BEARER_TOKEN);
    const json = (await resp.json()) as Record<string, unknown>;

    expect(json.accepted).toBe(true);
    expect(json.deleted).toBe(true);
    expect(json.messageId).toBe(messageId);

    const row = await readMessage(messageId);
    // Content survives: the stamp records loss of channel visibility, not an
    // erasure of what the assistant said.
    expect(row!.content).toBe(
      "The reply that was later deleted from the thread",
    );
    const parsed = JSON.parse(row!.metadata!) as Record<string, unknown>;
    const slackMeta = readSlackMetadata(parsed.slackMeta as string);
    expect(slackMeta!.deletedAt).toBeDefined();
    expect(slackMeta!.channelTs).toBe(postTs);
    expect(readProviderMetadata(row!.metadata)!.deletedAt).toBeDefined();
  });

  test("deleting the assistant's own Slack post stamps its neutral envelope per post", async () => {
    // A Slack reply row carries the neutral envelope every channel writes,
    // so its deletion takes the same per-post path as any channel's: the
    // gateway forwards the delete unattributed (Slack names the author,
    // never the deleter), the row resolves through the id its envelope
    // names, and the Slack renderers read the stamp through the Slack view.
    const chatId = "C0123CHANNEL";
    const postTs = "1725100000.000900";
    const minted = await recordInbound("slack", chatId, "evt-earlier-user-msg");
    const messageId = "assistant-slack-reply-1";
    await insertMessage({
      id: messageId,
      conversationId: minted.conversationId,
      role: "assistant",
      content: "The reply that was later deleted from the thread",
      metadata: JSON.stringify({
        assistantMessageChannel: "slack",
        providerMeta: JSON.stringify({
          source: "slack",
          conversationExternalId: chatId,
          messageId: postTs,
          threadId: "1725100000.000100",
          eventKind: "message",
          timestampTimezone: "America/New_York",
        }),
      }),
      createdAt: Date.now(),
    });

    const req = new Request("http://localhost:8080/channels/inbound", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-Gateway-Origin": TEST_BEARER_TOKEN,
      },
      body: JSON.stringify({
        sourceChannel: "slack",
        interface: "slack",
        conversationExternalId: chatId,
        externalMessageId: "evt-del-own-post",
        eventKind: "delete",
        content: "",
        actorExternalId: "slack-system",
        sourceMetadata: {
          messageId: postTs,
          threadId: "1725100000.000100",
          actorUnattributed: true,
        },
      }),
    });
    const resp = await handleChannelInbound(req, undefined, TEST_BEARER_TOKEN);
    const json = (await resp.json()) as Record<string, unknown>;
    expect(json.accepted).toBe(true);
    expect(json.deleted).toBe(true);
    expect(json.messageId).toBe(messageId);

    const row = await readMessage(messageId);
    expect(row!.content).toBe(
      "The reply that was later deleted from the thread",
    );
    const neutral = readProviderMetadata(row!.metadata);
    expect(neutral!.deletedMessageIds).toEqual([postTs]);
    expect(neutral!.deletedAt).toBeDefined();
    const view = readSlackMetadataFromMessageMetadata(row!.metadata);
    expect(view!.channelTs).toBe(postTs);
    expect(view!.deletedAt).toBe(neutral!.deletedAt);
    expect(view!.timestampTimezone).toBe("America/New_York");
  });

  test("delete for unknown ts is a no-op", async () => {
    // Seed an unrelated message so the conversation exists but ts mismatches.
    const seeded = await seedSlackMessage({
      externalChatId: "C0123CHANNEL",
      originalTs: "1111.1111",
      content: "Should remain untouched",
      withSlackMeta: true,
    });

    const req = buildSlackDeleteRequest({
      externalChatId: seeded.externalChatId,
      deletedTs: "9999.9999", // not seeded
    });
    const resp = await handleChannelInbound(req, undefined, TEST_BEARER_TOKEN);
    const json = (await resp.json()) as Record<string, unknown>;

    expect(resp.status).toBe(200);
    expect(json.accepted).toBe(true);
    expect(json.deleted).toBe(false);

    // Original message must not be modified.
    const row = await readMessage(seeded.messageId);

    expect(row!.content).toBe("Should remain untouched");
    const parsed = JSON.parse(row!.metadata!) as Record<string, unknown>;
    const slackMeta = readSlackMetadata(parsed.slackMeta as string);
    expect(slackMeta!.deletedAt).toBeUndefined();
  });

  test("a never-ingested delete returns without paying the retry window", async () => {
    // The retry loop exists for one race: an inbound-event row written
    // before its message link lands. No row at all means nothing can appear
    // by waiting, and the wait would hold the conversation's serialized
    // forward lane for every unrelated delete a busy room produces.
    _setDeleteLookupConfigForTests(2, 500);
    const started = Date.now();
    const req = buildSlackDeleteRequest({
      externalChatId: "C0123CHANNEL",
      deletedTs: "0000.0000",
    });
    const resp = await handleChannelInbound(req, undefined, TEST_BEARER_TOKEN);
    const json = (await resp.json()) as Record<string, unknown>;

    expect(json.accepted).toBe(true);
    expect(json.deleted).toBe(false);
    // Far under a single 500ms retry delay: the loop short-circuited.
    expect(Date.now() - started).toBeLessThan(400);
  });

  test("delete for row without slackMeta stamps the neutral metadata", async () => {
    // A legacy pre-enrichment row still gets its delete marked: the neutral
    // envelope is synthesized so readProviderMetadata serves the stamp to
    // every channel-agnostic reader, and content stays for audit.
    const seeded = await seedSlackMessage({
      externalChatId: "C0123CHANNEL",
      originalTs: "2222.2222",
      content: "Legacy pre-upgrade text",
      withSlackMeta: false,
    });

    const before = Date.now();
    const req = buildSlackDeleteRequest({
      externalChatId: seeded.externalChatId,
      deletedTs: seeded.originalTs,
    });
    const resp = await handleChannelInbound(req, undefined, TEST_BEARER_TOKEN);
    const json = (await resp.json()) as Record<string, unknown>;

    expect(json.accepted).toBe(true);
    expect(json.deleted).toBe(true);
    const row = await readMessage(seeded.messageId);

    expect(row!.content).toBe("Legacy pre-upgrade text");
    const parsed = JSON.parse(row!.metadata!) as Record<string, unknown>;
    expect(parsed.slackMeta).toBeUndefined();
    const neutral = readProviderMetadata(row!.metadata);
    expect(neutral).not.toBeNull();
    expect(neutral!.source).toBe("slack");
    expect(neutral!.messageId).toBe(seeded.originalTs);
    expect(neutral!.deletedAt).toBeDefined();
    expect(neutral!.deletedAt!).toBeGreaterThanOrEqual(before);
  });

  test("a flat-legacy row's fields survive the delete stamp", async () => {
    // Rows written before slackMeta nesting carry the Slack envelope flat in
    // messages.metadata. The stamp bases on the mapped envelope, so thread
    // and display identity remain readable beside deletedAt instead of
    // being shadowed by a minimal synthesis.
    const seeded = await seedSlackMessage({
      externalChatId: "C0123CHANNEL",
      originalTs: "3333.3333",
      content: "Flat legacy text",
      withSlackMeta: false,
    });
    await updateMessageMetadata(
      seeded.messageId,
      JSON.stringify({
        source: "slack",
        channelId: seeded.externalChatId,
        channelTs: seeded.originalTs,
        threadTs: "3000.0001",
        eventKind: "message",
        displayName: "Flat User",
      }),
    );

    const req = buildSlackDeleteRequest({
      externalChatId: seeded.externalChatId,
      deletedTs: seeded.originalTs,
    });
    const resp = await handleChannelInbound(req, undefined, TEST_BEARER_TOKEN);
    const json = (await resp.json()) as Record<string, unknown>;
    expect(json.deleted).toBe(true);

    const row = await readMessage(seeded.messageId);
    const neutral = readProviderMetadata(row!.metadata);
    expect(neutral).not.toBeNull();
    expect(neutral!.deletedAt).toBeDefined();
    expect(neutral!.threadId).toBe("3000.0001");
    expect(neutral!.displayName).toBe("Flat User");
  });

  test("a row with malformed metadata still records its delete", async () => {
    const seeded = await seedSlackMessage({
      externalChatId: "C0123CHANNEL",
      originalTs: "4444.4444",
      content: "Row with broken envelope",
      withSlackMeta: false,
    });
    await updateMessageMetadata(seeded.messageId, "{not json");

    const req = buildSlackDeleteRequest({
      externalChatId: seeded.externalChatId,
      deletedTs: seeded.originalTs,
    });
    const resp = await handleChannelInbound(req, undefined, TEST_BEARER_TOKEN);
    const json = (await resp.json()) as Record<string, unknown>;
    expect(json.accepted).toBe(true);
    expect(json.deleted).toBe(true);

    const row = await readMessage(seeded.messageId);
    const neutral = readProviderMetadata(row!.metadata);
    expect(neutral).not.toBeNull();
    expect(neutral!.deletedAt).toBeDefined();
  });

  test("delete missing sourceMetadata.messageId is a no-op", async () => {
    const seeded = await seedSlackMessage({
      externalChatId: "C0123CHANNEL",
      originalTs: "3333.3333",
      content: "Untouched",
      withSlackMeta: true,
    });

    const req = new Request("http://localhost:8080/channels/inbound", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-Gateway-Origin": TEST_BEARER_TOKEN,
      },
      body: JSON.stringify({
        sourceChannel: "slack",
        interface: "slack",
        conversationExternalId: seeded.externalChatId,
        externalMessageId: "evt-del-no-source",
        content: "",
        callbackData: "message_deleted",
        actorExternalId: SLACK_DELETE_ACTOR_ID,
        // sourceMetadata intentionally omitted
      }),
    });
    const resp = await handleChannelInbound(req, undefined, TEST_BEARER_TOKEN);
    const json = (await resp.json()) as Record<string, unknown>;

    expect(json.accepted).toBe(true);
    expect(json.deleted).toBe(false);
    const row = await readMessage(seeded.messageId);
    const parsed = JSON.parse(row!.metadata!) as Record<string, unknown>;
    const slackMeta = readSlackMetadata(parsed.slackMeta as string);
    expect(slackMeta!.deletedAt).toBeUndefined();
  });

  test("delete that races ahead of linkMessage is retried until the link lands", async () => {
    // Simulates the race: a delete webhook arrives after `recordInbound`
    // has inserted the original event row but before the agent-loop path
    // has called `linkMessage` to bind it to a stored message. Without
    // the retry loop the delete would silently no-op and the deletion
    // signal would be lost.
    const externalChatId = "C0123CHANNEL";
    const originalTs = "5555.5555";
    const inbound = await recordInbound("slack", externalChatId, originalTs, {
      sourceMessageId: originalTs,
    });

    const messageId = `msg-${originalTs}`;
    const slackMeta = writeSlackMetadata({
      source: "slack",
      channelId: externalChatId,
      channelTs: originalTs,
      eventKind: "message",
      displayName: "Test User",
    });
    await insertMessage({
      id: messageId,
      conversationId: inbound.conversationId,
      role: "user",
      content: "Original text",
      createdAt: Date.now(),
      metadata: JSON.stringify({
        userMessageChannel: "slack",
        userMessageInterface: "slack",
        slackMeta,
      }),
    });

    // Shorten retries to a handful of small backoffs so the test is fast
    // while still exercising the loop.
    _setDeleteLookupConfigForTests(5, 50);

    // Link the message after a short delay — this lands during one of the
    // retry backoffs. Intentionally not awaited.
    const LINK_DELAY_MS = 120;
    setTimeout(async () => {
      await linkMessage(inbound.eventId, messageId);
    }, LINK_DELAY_MS);

    const req = buildSlackDeleteRequest({
      externalChatId,
      deletedTs: originalTs,
    });
    const resp = await handleChannelInbound(req, undefined, TEST_BEARER_TOKEN);
    const json = (await resp.json()) as Record<string, unknown>;

    expect(resp.status).toBe(200);
    expect(json.accepted).toBe(true);
    expect(json.deleted).toBe(true);
    expect(json.messageId).toBe(messageId);

    const row = await readMessage(messageId);
    const parsed = JSON.parse(row!.metadata!) as Record<string, unknown>;
    const parsedSlackMeta = readSlackMetadata(parsed.slackMeta as string);
    expect(parsedSlackMeta!.deletedAt).toBeDefined();
  });

  test("delete from non-member actor is rejected by ACL and does not apply", async () => {
    // Use a channel where NO active member is seeded so the actor cannot
    // resolve via the channel's externalChatId either. Verifies that ACL
    // enforcement rejects delete events from non-members before the delete
    // handler processes them — the delete must not apply and no row should
    // be mutated when the actor is not an active member of the target
    // channel. Also clear the C0123CHANNEL seed for the alt channel below
    // since beforeEach wires the seed on C0123CHANNEL only.
    const altChannel = "C0_NON_MEMBER_CHAN";
    const seeded = await seedSlackMessage({
      externalChatId: altChannel,
      originalTs: "7777.7777",
      content: "Original audited text",
      withSlackMeta: true,
    });

    const req = buildSlackDeleteRequest({
      externalChatId: seeded.externalChatId,
      deletedTs: seeded.originalTs,
      actorExternalId: "U_NON_MEMBER",
    });
    const resp = await handleChannelInbound(req, undefined, TEST_BEARER_TOKEN);
    const json = (await resp.json()) as Record<string, unknown>;

    // ACL denies the inbound — the response must not carry `deleted: true`.
    expect(json.deleted).not.toBe(true);

    // The original row remains unmodified — content untouched and no
    // deletedAt marker stamped on slackMeta.
    const row = await readMessage(seeded.messageId);
    expect(row!.content).toBe("Original audited text");
    const parsed = JSON.parse(row!.metadata!) as Record<string, unknown>;
    const slackMeta = readSlackMetadata(parsed.slackMeta as string);
    expect(slackMeta!.deletedAt).toBeUndefined();
  });
});
