import { expect, test } from "bun:test";

import { createConversation } from "../persistence/conversation-crud.js";
import {
  getBindingByConversation,
  upsertBinding,
} from "../persistence/external-conversation-store.js";
import { describePg } from "./pg-test-db.js";

async function boundConversation(): Promise<string> {
  const conversation = await createConversation({ title: "t" });
  await upsertBinding({
    conversationId: conversation.id,
    sourceChannel: "slack",
    externalChatId: "C0123CHANNEL",
    externalChatName: "user-feedback",
  });
  return conversation.id;
}

describePg("upsertBinding chat-name preservation", () => {
  test("a nameless upsert for the same chat keeps the stored name", async () => {
    const conversationId = await boundConversation();
    await upsertBinding({
      conversationId,
      sourceChannel: "slack",
      externalChatId: "C0123CHANNEL",
    });
    expect(
      (await getBindingByConversation(conversationId))?.externalChatName,
    ).toBe("user-feedback");
  });

  test("a move to a nameless chat clears the stored name", async () => {
    const conversationId = await boundConversation();
    await upsertBinding({
      conversationId,
      sourceChannel: "slack",
      externalChatId: "D0MOVEDHERE",
    });
    const binding = await getBindingByConversation(conversationId);
    expect(binding?.externalChatId).toBe("D0MOVEDHERE");
    expect(binding?.externalChatName ?? null).toBeNull();
  });

  test("a move that reports a name takes the new name", async () => {
    const conversationId = await boundConversation();
    await upsertBinding({
      conversationId,
      sourceChannel: "slack",
      externalChatId: "C0ELSEWHERE",
      externalChatName: "new-home",
    });
    expect(
      (await getBindingByConversation(conversationId))?.externalChatName,
    ).toBe("new-home");
  });
});
