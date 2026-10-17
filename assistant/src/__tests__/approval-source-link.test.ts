import { beforeEach, expect, setDefaultTimeout, test } from "bun:test";

import { requireMainDb } from "../persistence/db-facade.js";
import { recordInbound } from "../persistence/delivery-crud.js";
import { upsertBinding } from "../persistence/external-conversation-store.js";
import { resolveApprovalSourceReference } from "../runtime/approval-source-link.js";
import { describePg } from "./pg-test-db.js";

async function resetTables(): Promise<void> {
  const db = requireMainDb();
  await db.run("DELETE FROM channel_inbound_events");
  await db.run("DELETE FROM conversation_keys");
  await db.run("DELETE FROM external_conversation_bindings");
  await db.run("DELETE FROM conversations");
}

describePg("resolveApprovalSourceReference", () => {
  beforeEach(resetTables);

  test("returns null for channels without a registered resolver", async () => {
    const result = await recordInbound("telegram", "12345", "evt-1", {
      sourceMessageId: "678",
    });
    expect(
      await resolveApprovalSourceReference("telegram", result.conversationId),
    ).toBeNull();
  });

  test("returns null for a conversation with no Slack provenance", async () => {
    expect(
      await resolveApprovalSourceReference("slack", "conv-none"),
    ).toBeNull();
  });

  test("resolves chat id and message permalink from the latest inbound event (DM)", async () => {
    const result = await recordInbound("slack", "D01XYZ", "evt-1", {
      sourceMessageId: "1700000000.000100",
    });

    expect(
      await resolveApprovalSourceReference("slack", result.conversationId),
    ).toEqual({
      sourceChatId: "D01XYZ",
      sourceLink: {
        webUrl: "https://slack.com/archives/D01XYZ/p1700000000000100",
      },
    });
  });

  test("uses the most recent inbound event when several exist", async () => {
    const first = await recordInbound("slack", "D01XYZ", "evt-1", {
      sourceMessageId: "1699999900.000001",
    });
    await recordInbound("slack", "D01XYZ", "evt-2", {
      sourceMessageId: "1700000000.000100",
    });

    expect(
      await resolveApprovalSourceReference("slack", first.conversationId),
    ).toEqual({
      sourceChatId: "D01XYZ",
      sourceLink: {
        webUrl: "https://slack.com/archives/D01XYZ/p1700000000000100",
      },
    });
  });

  test("threaded conversations link the message inside its thread", async () => {
    const result = await recordInbound("slack", "C01ABC", "evt-1", {
      sourceMessageId: "1700000001.000200",
      sourceThreadId: "1700000000.000100",
    });
    await upsertBinding({
      conversationId: result.conversationId,
      sourceChannel: "slack",
      externalChatId: "C01ABC",
      externalThreadId: "1700000000.000100",
    });

    expect(
      await resolveApprovalSourceReference("slack", result.conversationId),
    ).toEqual({
      sourceChatId: "C01ABC",
      sourceLink: {
        webUrl:
          "https://slack.com/archives/C01ABC/p1700000001000200?thread_ts=1700000000.000100&cid=C01ABC",
      },
    });
  });

  test("a thread-root message carries no thread params", async () => {
    const result = await recordInbound("slack", "C01ABC", "evt-1", {
      sourceMessageId: "1700000000.000100",
      sourceThreadId: "1700000000.000100",
    });
    await upsertBinding({
      conversationId: result.conversationId,
      sourceChannel: "slack",
      externalChatId: "C01ABC",
      externalThreadId: "1700000000.000100",
    });

    expect(
      await resolveApprovalSourceReference("slack", result.conversationId),
    ).toEqual({
      sourceChatId: "C01ABC",
      sourceLink: {
        webUrl: "https://slack.com/archives/C01ABC/p1700000000000100",
      },
    });
  });

  test("falls back to a ts-shaped externalMessageId when sourceMessageId is absent", async () => {
    const result = await recordInbound("slack", "D01XYZ", "1700000000.000100");

    expect(
      await resolveApprovalSourceReference("slack", result.conversationId),
    ).toEqual({
      sourceChatId: "D01XYZ",
      sourceLink: {
        webUrl: "https://slack.com/archives/D01XYZ/p1700000000000100",
      },
    });
  });

  test("omits the link when no id is ts-shaped", async () => {
    const result = await recordInbound("slack", "D01XYZ", "evt-opaque");

    expect(
      await resolveApprovalSourceReference("slack", result.conversationId),
    ).toEqual({
      sourceChatId: "D01XYZ",
    });
  });

  test("an ingress-stamped hint identifies the exact message, immune to later inbound rows", async () => {
    // A second message lands while the first message's turn is still
    // escalating — the hint pins the card to the actual triggering message.
    const result = await recordInbound("slack", "D01XYZ", "evt-1", {
      sourceMessageId: "1699999900.000001",
    });
    await recordInbound("slack", "D01XYZ", "evt-2", {
      sourceMessageId: "1700000000.000100",
    });

    expect(
      await resolveApprovalSourceReference("slack", result.conversationId, {
        requesterChatId: "D01XYZ",
        sourceMessageId: "1699999900.000001",
      }),
    ).toEqual({
      sourceChatId: "D01XYZ",
      sourceLink: {
        webUrl: "https://slack.com/archives/D01XYZ/p1699999900000001",
      },
    });
  });

  test("a threaded hint links the message inside its thread without a DB row", async () => {
    expect(
      await resolveApprovalSourceReference("slack", "conv-unpersisted", {
        requesterChatId: "C01ABC",
        sourceMessageId: "1700000001.000200",
        sourceThreadId: "1700000000.000100",
      }),
    ).toEqual({
      sourceChatId: "C01ABC",
      sourceLink: {
        webUrl:
          "https://slack.com/archives/C01ABC/p1700000001000200?thread_ts=1700000000.000100&cid=C01ABC",
      },
    });
  });

  test("a hint without a ts-shaped message id falls back to persisted reconstruction", async () => {
    const result = await recordInbound("slack", "D01XYZ", "evt-1", {
      sourceMessageId: "1700000000.000100",
    });

    expect(
      await resolveApprovalSourceReference("slack", result.conversationId, {
        requesterChatId: "D01XYZ",
        sourceMessageId: "not-a-ts",
      }),
    ).toEqual({
      sourceChatId: "D01XYZ",
      sourceLink: {
        webUrl: "https://slack.com/archives/D01XYZ/p1700000000000100",
      },
    });
  });

  test("ignores bindings from other channels", async () => {
    const result = await recordInbound("slack", "D01XYZ", "evt-opaque");
    await upsertBinding({
      conversationId: result.conversationId,
      sourceChannel: "telegram",
      externalChatId: "12345",
      externalThreadId: "1700000000.000100",
    });

    expect(
      await resolveApprovalSourceReference("slack", result.conversationId),
    ).toEqual({
      sourceChatId: "D01XYZ",
    });
  });
});

setDefaultTimeout(30_000);
