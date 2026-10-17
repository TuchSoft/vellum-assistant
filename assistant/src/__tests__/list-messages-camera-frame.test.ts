import { beforeEach, expect, setDefaultTimeout, test } from "bun:test";
setDefaultTimeout(30_000);

import { setConfig } from "./helpers/set-config.js";

setConfig("memory", { enabled: false });

import {
  type ConversationMessage,
  ConversationMessageSchema,
} from "../api/responses/conversation-message.js";
import {
  addMessage,
  createConversation,
} from "../persistence/conversation-crud.js";
import { requireMainDb } from "../persistence/db-facade.js";
import { handleListMessages } from "../runtime/routes/conversation-routes.js";
import { describePg } from "./pg-test-db.js";

describePg("handleListMessages camera-frame projection", () => {
  beforeEach(async () => {
    const db = requireMainDb();
    await db.run("DELETE FROM message_attachments");
    await db.run("DELETE FROM attachments");
    await db.run("DELETE FROM messages");
    await db.run("DELETE FROM conversations");
  });

  test.each([
    {
      name: "an ambient keep",
      metadata: { scripted: true, sightFrameAttachmentIds: ["att-keep"] },
      cameraFrame: true,
    },
    {
      name: "a spoken turn carrying a parked frame",
      metadata: {
        sightFrameAttachmentIds: ["att-parked"],
        voiceSessionTurn: true,
      },
      cameraFrame: false,
    },
    {
      name: "a shutter photo",
      metadata: { livePhoto: true, voiceSessionTurn: true, scripted: false },
      cameraFrame: false,
    },
    {
      name: "a plain user row with literal camera-frame text",
      metadata: undefined,
      cameraFrame: false,
    },
    {
      name: "a scripted row with no frame tag",
      metadata: { scripted: true },
      cameraFrame: false,
    },
    {
      name: "a scripted row with an empty frame tag",
      metadata: { scripted: true, sightFrameAttachmentIds: [] },
      cameraFrame: false,
    },
    {
      name: "a scripted row with invalid frame ids",
      metadata: { scripted: true, sightFrameAttachmentIds: [""] },
      cameraFrame: false,
    },
  ])("classifies $name from metadata", async ({ metadata, cameraFrame }) => {
    const conv = await createConversation();
    const row = await addMessage(
      conv.id,
      "user",
      JSON.stringify([{ type: "text", text: "(camera frame)" }]),
      { metadata },
    );

    const response = (await handleListMessages({
      queryParams: { conversationId: conv.id },
    })) as { messages: ConversationMessage[] };

    expect(response.messages).toHaveLength(1);
    const projected = response.messages[0]!;
    expect(projected.id).toBe(row.id);
    expect(() => ConversationMessageSchema.parse(projected)).not.toThrow();
    if (cameraFrame) {
      expect(projected.cameraFrame).toBe(true);
    } else {
      expect(projected).not.toHaveProperty("cameraFrame");
    }
    expect(
      ConversationMessageSchema.safeParse({ ...projected, cameraFrame: false })
        .success,
    ).toBe(false);
  });

  test.each(["not-json", "null", "", "{}"])(
    "omits cameraFrame for unreadable or empty metadata %j",
    async (metadata) => {
      const conv = await createConversation();
      const row = await addMessage(
        conv.id,
        "user",
        JSON.stringify([{ type: "text", text: "(camera frame)" }]),
      );
      await requireMainDb().run(
        "UPDATE messages SET metadata = ? WHERE id = ?",
        [metadata, row.id],
      );

      const response = (await handleListMessages({
        queryParams: { conversationId: conv.id },
      })) as { messages: ConversationMessage[] };

      expect(response.messages).toHaveLength(1);
      const projected = response.messages[0]!;
      expect(projected.id).toBe(row.id);
      expect(projected).not.toHaveProperty("cameraFrame");
      expect(() => ConversationMessageSchema.parse(projected)).not.toThrow();
    },
  );
});
