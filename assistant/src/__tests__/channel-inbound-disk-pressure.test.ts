import { afterAll, beforeEach, describe, expect, mock, test } from "bun:test";

import { eq } from "drizzle-orm";

import type { DiskPressureStatus } from "../daemon/disk-pressure-guard.js";

const deliverChannelReplyMock = mock(
  async (_callbackUrl: string, _payload: Record<string, unknown>) => {},
);
const expectedRemoteBlockReply =
  "Storage is critically low, so remote messages are ignored until the guardian frees enough space. Please try again later.";

mock.module("../runtime/gateway-client.js", () => ({
  deliverChannelReply: deliverChannelReplyMock,
}));

const lockedDiskPressureStatus: DiskPressureStatus = {
  enabled: true,
  state: "critical",
  locked: true,
  acknowledged: true,
  overrideActive: false,
  effectivelyLocked: true,
  lockId: "disk-pressure-test",
  usagePercent: 98,
  thresholdPercent: 95,
  path: "/workspace",
  lastCheckedAt: "2026-05-05T00:00:00.000Z",
  blockedCapabilities: ["agent-turns", "background-work", "remote-ingress"],
  error: null,
};
const disabledDiskPressureStatus: DiskPressureStatus = {
  enabled: false,
  state: "disabled",
  locked: false,
  acknowledged: false,
  overrideActive: false,
  effectivelyLocked: false,
  lockId: null,
  usagePercent: null,
  thresholdPercent: 95,
  path: null,
  lastCheckedAt: null,
  blockedCapabilities: [],
  error: null,
};
let diskPressureStatus = lockedDiskPressureStatus;
let diskPressureStatusSequence: DiskPressureStatus[] | undefined;

mock.module("../daemon/disk-pressure-guard.js", () => ({
  getDiskPressureStatus: () =>
    diskPressureStatusSequence?.shift() ?? diskPressureStatus,
}));

import { requireMainDb } from "../persistence/db-facade.js";
import * as deliveryCrud from "../persistence/delivery-crud.js";
import {
  channelInboundEvents,
  messages,
} from "../persistence/pg-schema/index.js";
import { sweepFailedEvents } from "../runtime/channel-retry-sweep.js";
import {
  handleChannelInbound,
  seedContactChannel,
  setAdapterProcessMessage,
} from "./helpers/channel-test-adapter.js";
import { createGuardianBinding } from "./helpers/create-guardian-binding.js";
import { bridgeState } from "./helpers/gateway-guardian-requests-store-bridge.js";

async function resetTables(): Promise<void> {
  bridgeState.reset();
  const db = requireMainDb();
  await db.run("DELETE FROM channel_inbound_events");
  await db.run("DELETE FROM conversation_keys");
  await db.run("DELETE FROM messages");
  await db.run("DELETE FROM conversations");
  await db.run("DELETE FROM external_conversation_bindings");
  await db.run("DELETE FROM contact_channels");
  await db.run("DELETE FROM contacts");
}

async function seedTrustedContact(): Promise<void> {
  await seedContactChannel({
    sourceChannel: "telegram",
    externalUserId: "telegram-user-1",
    displayName: "Example User",
    status: "active",
    policy: "allow",
  });
}

function makeInboundRequest(overrides: Record<string, unknown> = {}): Request {
  return new Request("http://localhost/channels/inbound", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "X-Gateway-Origin": "test-token",
    },
    body: JSON.stringify({
      sourceChannel: "telegram",
      interface: "telegram",
      conversationExternalId: "chat-123",
      externalMessageId: `msg-${Date.now()}-${Math.random()
        .toString(36)
        .slice(2, 8)}`,
      content: "hello",
      actorExternalId: "telegram-user-1",
      replyCallbackUrl: "https://gateway.test/deliver/telegram",
      ...overrides,
    }),
  });
}

describe("channel inbound disk pressure gate", () => {
  beforeEach(async () => {
    await resetTables();
    await seedTrustedContact();
    setAdapterProcessMessage(undefined);
    deliverChannelReplyMock.mockClear();
    deliverChannelReplyMock.mockImplementation(
      async (_callbackUrl: string, _payload: Record<string, unknown>) => {},
    );
    diskPressureStatus = lockedDiskPressureStatus;
    diskPressureStatusSequence = undefined;
  });

  afterAll(() => {
    diskPressureStatus = disabledDiskPressureStatus;
  });

  test("blocks trusted-contact ingress before payload persistence or processing", async () => {
    const processMessage = mock(async () => {
      throw new Error("processMessage should not run");
    });
    setAdapterProcessMessage(processMessage);

    const res = await handleChannelInbound(makeInboundRequest());
    const body = (await res.json()) as Record<string, unknown>;

    expect(res.status).toBe(200);
    expect(body).toMatchObject({
      accepted: true,
      duplicate: false,
      diskPressure: "blocked",
      reason: "trusted-contact",
    });
    expect(processMessage).not.toHaveBeenCalled();
    expect(deliverChannelReplyMock).toHaveBeenCalledWith(
      "https://gateway.test/deliver/telegram",
      expect.objectContaining({
        chatId: "chat-123",
        text: expect.stringContaining("remote messages are ignored"),
      }),
    );

    const db = requireMainDb();
    const event = (await db.orm.select().from(channelInboundEvents))[0];
    expect(event?.processingStatus).toBe("processed");
    expect(event?.messageId).toBeNull();
    expect(event?.rawPayload).toBeNull();
    expect(await db.orm.select().from(messages)).toHaveLength(0);
  });

  test("preserves retryable duplicate ingress without re-sending block replies", async () => {
    const inbound = await deliveryCrud.recordInbound(
      "telegram",
      "chat-123",
      "msg-duplicate-blocked",
    );
    await deliveryCrud.storePayload(inbound.eventId, {
      content: "retry me",
      sourceChannel: "telegram",
      interface: "telegram",
      externalChatId: "chat-123",
      trustCtx: {
        trustClass: "trusted_contact",
        sourceChannel: "telegram",
        requesterExternalUserId: "telegram-user-1",
        requesterChatId: "chat-123",
      },
      replyCallbackUrl: "https://gateway.test/deliver/telegram",
    });

    const db = requireMainDb();
    await db.orm
      .update(channelInboundEvents)
      .set({
        processingStatus: "failed",
        processingAttempts: 1,
        retryAfter: Date.now() - 1,
      })
      .where(eq(channelInboundEvents.id, inbound.eventId));

    const processMessage = mock(async () => {
      throw new Error("processMessage should not run");
    });
    setAdapterProcessMessage(processMessage);

    const res = await handleChannelInbound(
      makeInboundRequest({ externalMessageId: "msg-duplicate-blocked" }),
    );
    const body = (await res.json()) as Record<string, unknown>;

    expect(body).toMatchObject({
      accepted: true,
      duplicate: true,
      diskPressure: "blocked",
      reason: "trusted-contact",
    });
    expect(processMessage).not.toHaveBeenCalled();
    expect(deliverChannelReplyMock).not.toHaveBeenCalled();

    const event = (
      await db.orm
        .select()
        .from(channelInboundEvents)
        .where(eq(channelInboundEvents.id, inbound.eventId))
    )[0];
    expect(event?.processingStatus).toBe("failed");
    expect(event?.messageId).toBeNull();
    expect(event?.rawPayload).not.toBeNull();
    expect(await db.orm.select().from(messages)).toHaveLength(0);
  });

  test("blocks non-guardian Slack reactions silently (no reply) before persistence while locked", async () => {
    await seedContactChannel({
      sourceChannel: "slack",
      externalUserId: "slack-user-1",
      displayName: "Example Slack User",
      status: "active",
      policy: "allow",
    });
    const processMessage = mock(async () => {
      throw new Error("processMessage should not run");
    });
    setAdapterProcessMessage(processMessage);

    const res = await handleChannelInbound(
      makeInboundRequest({
        sourceChannel: "slack",
        interface: "slack",
        conversationExternalId: "slack-channel-1",
        externalMessageId: "slack-reaction-blocked",
        content: "reaction:thumbsup",
        actorExternalId: "slack-user-1",
        callbackData: "reaction:thumbsup",
        sourceMetadata: { messageId: "1700000000.1" },
        replyCallbackUrl: "https://gateway.test/deliver/slack",
      }),
    );
    const body = (await res.json()) as Record<string, unknown>;

    expect(body).toMatchObject({
      accepted: true,
      reaction: "dropped_disk_pressure",
      diskPressure: "blocked",
      reason: "trusted-contact",
    });
    expect(processMessage).not.toHaveBeenCalled();
    // Reactions are blocked silently during disk pressure: a passive signal
    // has nothing to "try again", so no block reply is delivered (unlike the
    // message path, which does reply).
    expect(deliverChannelReplyMock).not.toHaveBeenCalled();

    const db = requireMainDb();
    const event = (
      await db.orm
        .select()
        .from(channelInboundEvents)
        .where(
          eq(channelInboundEvents.externalMessageId, "slack-reaction-blocked"),
        )
    )[0];
    // A blocked reaction writes nothing at all: it is dropped before the
    // reacted message is resolved, so no event row is opened either.
    expect(event).toBeUndefined();
    expect(await db.orm.select().from(messages)).toHaveLength(0);
  });

  test("blocks trusted-contact ingress without creating guardian requests", async () => {
    await resetTables();
    await createGuardianBinding({
      channel: "telegram",
      guardianExternalUserId: "guardian-user-1",
      guardianDeliveryChatId: "guardian-chat-1",
      guardianPrincipalId: "guardian-user-1",
    });
    await seedTrustedContact();
    const processMessage = mock(async () => {
      throw new Error("processMessage should not run");
    });
    setAdapterProcessMessage(processMessage);

    const res = await handleChannelInbound(
      makeInboundRequest({ externalMessageId: "msg-guardian-bound-blocked" }),
    );
    const body = (await res.json()) as Record<string, unknown>;

    expect(body).toMatchObject({
      accepted: true,
      duplicate: false,
      diskPressure: "blocked",
      reason: "trusted-contact",
    });
    expect(processMessage).not.toHaveBeenCalled();

    const db = requireMainDb();
    const event = (
      await db.orm
        .select()
        .from(channelInboundEvents)
        .where(
          eq(
            channelInboundEvents.externalMessageId,
            "msg-guardian-bound-blocked",
          ),
        )
    )[0];
    expect(event?.processingStatus).toBe("processed");
    expect(event?.messageId).toBeNull();
    expect(event?.rawPayload).toBeNull();

    expect(bridgeState.requests.size).toBe(0);
    expect(await db.orm.select().from(messages)).toHaveLength(0);
  });

  test("marks trusted-contact retry-sweep events processed without replaying", async () => {
    const inbound = await deliveryCrud.recordInbound(
      "telegram",
      "chat-retry",
      "msg-retry",
    );
    await deliveryCrud.storePayload(inbound.eventId, {
      content: "retry me",
      sourceChannel: "telegram",
      interface: "telegram",
      externalChatId: "chat-retry",
      trustCtx: {
        trustClass: "trusted_contact",
        sourceChannel: "telegram",
        requesterExternalUserId: "telegram-user-1",
        requesterChatId: "chat-retry",
      },
      replyCallbackUrl: "https://gateway.test/deliver/telegram",
    });

    const db = requireMainDb();
    await db.orm
      .update(channelInboundEvents)
      .set({
        processingStatus: "failed",
        processingAttempts: 1,
        retryAfter: Date.now() - 1,
      })
      .where(eq(channelInboundEvents.id, inbound.eventId));

    const processMessage = mock(async () => ({ messageId: "msg-should-not" }));
    await sweepFailedEvents(processMessage);

    expect(processMessage).not.toHaveBeenCalled();
    expect(deliverChannelReplyMock).toHaveBeenCalledWith(
      "https://gateway.test/deliver/telegram",
      expect.objectContaining({
        chatId: "chat-retry",
        text: expect.stringContaining("remote messages are ignored"),
      }),
    );

    const row = (
      await db.orm
        .select()
        .from(channelInboundEvents)
        .where(eq(channelInboundEvents.id, inbound.eventId))
    )[0];
    expect(row?.processingStatus).toBe("processed");
    expect(row?.messageId).toBeNull();
    expect(row?.rawPayload).toBeNull();
  });

  test("uses ephemeral Slack retry block replies targeted to the requester", async () => {
    const inbound = await deliveryCrud.recordInbound(
      "slack",
      "slack-channel-1",
      "slack-msg-retry",
    );
    await deliveryCrud.storePayload(inbound.eventId, {
      content: "retry me",
      sourceChannel: "slack",
      interface: "slack",
      externalChatId: "slack-channel-1",
      trustCtx: {
        trustClass: "trusted_contact",
        sourceChannel: "slack",
        requesterExternalUserId: "slack-user-1",
        requesterChatId: "slack-channel-1",
      },
      replyCallbackUrl: "https://gateway.test/deliver/slack",
      assistantId: "self",
    });

    const db = requireMainDb();
    await db.orm
      .update(channelInboundEvents)
      .set({
        processingStatus: "failed",
        processingAttempts: 1,
        retryAfter: Date.now() - 1,
      })
      .where(eq(channelInboundEvents.id, inbound.eventId));

    const processMessage = mock(async () => ({ messageId: "msg-should-not" }));
    await sweepFailedEvents(processMessage);

    expect(processMessage).not.toHaveBeenCalled();
    expect(deliverChannelReplyMock.mock.calls).toEqual([
      [
        "https://gateway.test/deliver/slack",
        {
          chatId: "slack-channel-1",
          text: expectedRemoteBlockReply,
          assistantId: "self",
          audience: { kind: "oneReader", userId: "slack-user-1" },
        },
      ],
    ]);

    const row = (
      await db.orm
        .select()
        .from(channelInboundEvents)
        .where(eq(channelInboundEvents.id, inbound.eventId))
    )[0];
    expect(row?.processingStatus).toBe("processed");
    expect(row?.messageId).toBeNull();
    expect(row?.rawPayload).toBeNull();
  });

  test("rechecks disk pressure between retry-sweep events", async () => {
    const blocked = await deliveryCrud.recordInbound(
      "telegram",
      "chat-retry-blocked",
      "msg-retry-blocked",
    );
    await deliveryCrud.storePayload(blocked.eventId, {
      content: "retry while locked",
      sourceChannel: "telegram",
      interface: "telegram",
      externalChatId: "chat-retry-blocked",
      trustCtx: {
        trustClass: "trusted_contact",
        sourceChannel: "telegram",
        requesterExternalUserId: "telegram-user-1",
        requesterChatId: "chat-retry-blocked",
      },
      replyCallbackUrl: "https://gateway.test/deliver/telegram",
    });

    const replayed = await deliveryCrud.recordInbound(
      "telegram",
      "chat-retry-replayed",
      "msg-retry-replayed",
    );
    await deliveryCrud.storePayload(replayed.eventId, {
      content: "retry after unlock",
      sourceChannel: "telegram",
      interface: "telegram",
      externalChatId: "chat-retry-replayed",
      trustCtx: {
        trustClass: "trusted_contact",
        sourceChannel: "telegram",
        requesterExternalUserId: "telegram-user-1",
        requesterChatId: "chat-retry-replayed",
      },
      replyCallbackUrl: "https://gateway.test/deliver/telegram",
    });

    const db = requireMainDb();
    for (const eventId of [blocked.eventId, replayed.eventId]) {
      await db.orm
        .update(channelInboundEvents)
        .set({
          processingStatus: "failed",
          processingAttempts: 1,
          retryAfter: Date.now() - 1,
        })
        .where(eq(channelInboundEvents.id, eventId));
    }

    diskPressureStatusSequence = [
      lockedDiskPressureStatus,
      disabledDiskPressureStatus,
    ];
    const processMessage = mock(
      async (conversationId: string, content: string) => {
        await db.orm.insert(messages).values({
          id: "msg-replayed",
          conversationId,
          role: "user",
          content: JSON.stringify([{ type: "text", text: content }]),
          createdAt: Date.now(),
        });
        return { messageId: "msg-replayed" };
      },
    );

    await sweepFailedEvents(processMessage);

    expect(processMessage).toHaveBeenCalledTimes(1);
    expect(deliverChannelReplyMock).toHaveBeenCalledTimes(1);
    const rows = await db.orm.select().from(channelInboundEvents);
    expect(rows.filter((row) => row.rawPayload === null)).toHaveLength(1);
    expect(rows.filter((row) => row.messageId === "msg-replayed")).toHaveLength(
      1,
    );
  });
});
