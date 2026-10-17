import { expect, test } from "bun:test";

import {
  addMessage,
  createConversation,
  getRecentConversationMessages,
} from "../conversation-crud.js";
import { requireMainDb } from "../db-facade.js";

test("recent conversation rows preserve insertion order at timestamp ties and stay bounded", async () => {
  const conversation = await createConversation({ title: "Example task" });
  const other = await createConversation({ title: "Other task" });
  const first = await addMessage(conversation.id, "user", "Start work");
  const success = await addMessage(
    conversation.id,
    "assistant",
    "The result is ready",
  );
  const failure = await addMessage(conversation.id, "user", "A sibling failed");
  await addMessage(other.id, "assistant", "Unrelated result");
  await requireMainDb().run(
    "UPDATE messages SET created_at = 100 WHERE conversation_id = ?",
    [conversation.id],
  );

  expect(
    (await getRecentConversationMessages(conversation.id, 2)).map(
      (row) => row.id,
    ),
  ).toEqual([success.id, failure.id]);
  expect(
    (await getRecentConversationMessages(conversation.id, 3)).map(
      (row) => row.id,
    ),
  ).toEqual([first.id, success.id, failure.id]);
  expect(
    (await getRecentConversationMessages(conversation.id, 2, failure.id)).map(
      (row) => row.id,
    ),
  ).toEqual([first.id, success.id]);
});
