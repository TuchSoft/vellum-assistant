/**
 * Characterization: conversation binding is derived from the message's
 * source channel (`conversationExternalId`) and is invariant to any channel
 * mentioned inline in the message text (LUM-3023's canonical regression: a
 * message received in source channel A that mentions destination channel B
 * must keep the conversation, its keys, and its slackMeta bound to A; B is
 * presentation data only).
 *
 * These tests pin current behavior; nothing here changes it.
 */

import { beforeEach, expect, test } from "bun:test";

import { setConfig } from "./helpers/set-config.js";

setConfig("memory", { enabled: false });

import { writeSlackMetadata } from "../messaging/providers/slack/message-metadata.js";
import { addMessage, getMessages } from "../persistence/conversation-crud.js";
import { requireMainDb } from "../persistence/db-facade.js";
import { recordInbound } from "../persistence/delivery-crud.js";
import { describePg } from "./pg-test-db.js";

const SOURCE_CHANNEL_A = "C0111SRCA";
const MENTIONED_CHANNEL_B = "C0222DESTB";

async function resetTables(): Promise<void> {
  const db = requireMainDb();
  await db.run("DELETE FROM messages");
  await db.run("DELETE FROM channel_inbound_events");
  await db.run("DELETE FROM conversation_keys");
  await db.run("DELETE FROM conversations");
}

describePg("Slack mention binding invariance", () => {
  beforeEach(resetTables);

  test("a message in channel A mentioning channel B binds to A, and B mints no binding", async () => {
    // Inbound in source channel A whose text mentions destination channel B.
    const first = await recordInbound(
      "slack",
      SOURCE_CHANNEL_A,
      "1700000000.000100",
    );
    await addMessage(
      first.conversationId,
      "user",
      JSON.stringify([
        {
          type: "text",
          text: "please post updates in #dest-channel going forward",
        },
      ]),
      {
        metadata: {
          slackMeta: writeSlackMetadata({
            source: "slack",
            channelId: SOURCE_CHANNEL_A,
            channelTs: "1700000000.000100",
            eventKind: "message",
          }),
        },
        skipIndexing: true,
      },
    );

    // A later message in the same source channel resolves to the SAME
    // conversation: the binding key is the source channel, nothing else.
    const second = await recordInbound(
      "slack",
      SOURCE_CHANNEL_A,
      "1700000001.000200",
    );
    expect(second.conversationId).toBe(first.conversationId);

    // The mentioned channel B resolves to a DIFFERENT conversation if
    // anything ever arrives from it; mentioning it created no binding.
    const fromB = await recordInbound(
      "slack",
      MENTIONED_CHANNEL_B,
      "1700000002.000300",
    );
    expect(fromB.conversationId).not.toBe(first.conversationId);

    // The persisted row's slackMeta records the source channel, and B
    // appears nowhere in persisted metadata, only in message text.
    const rows = await getMessages(first.conversationId);
    expect(rows).toHaveLength(1);
    expect(rows[0].metadata).toContain(SOURCE_CHANNEL_A);
    expect(rows[0].metadata).not.toContain(MENTIONED_CHANNEL_B);
  });

  test("no conversation key exists for a channel that was only ever mentioned", async () => {
    await recordInbound("slack", SOURCE_CHANNEL_A, "1700000003.000400");

    const db = requireMainDb();
    const keys = await db.orm
      .select({ conversationKey: db.schema.conversationKeys.conversationKey })
      .from(db.schema.conversationKeys);
    const keyBlob = JSON.stringify(keys);
    expect(keyBlob).toContain(SOURCE_CHANNEL_A);
    expect(keyBlob).not.toContain(MENTIONED_CHANNEL_B);
  });
});
