/**
 * The message that interrupted a turn carries the note saying what to do about
 * the interruption, on its LLM-facing content only: the persisted row stays
 * exactly what the user typed, so no client renders it, and
 * `interruptedPriorTurn` in the row's metadata is what rebuilds the identical
 * block on every later load.
 */
import { beforeEach, expect, setDefaultTimeout, test } from "bun:test";
setDefaultTimeout(30_000);

import { reinjectInterruptTurnNote } from "../daemon/conversation-lifecycle.js";
import type { MessagingConversationContext } from "../daemon/conversation-messaging.js";
import { persistQueuedMessageBody } from "../daemon/conversation-messaging.js";
import { createConversation } from "../persistence/conversation-crud.js";
import { requireMainDb } from "../persistence/db-facade.js";
import type { ContentBlock } from "../providers/types.js";
import { INTERRUPTED_TURN_NOTE_TEXT } from "../util/abort-reasons.js";
import { describePg } from "./pg-test-db.js";

async function resetTables() {
  const db = requireMainDb();
  await db.run("DELETE FROM message_attachments");
  await db.run("DELETE FROM attachments");
  await db.run("DELETE FROM messages");
  await db.run("DELETE FROM conversations");
}

function makeCtx(conversationId: string): MessagingConversationContext {
  return {
    conversationId,
    messages: [],
    abortController: null,
    currentRequestId: undefined,
    queue: {} as never,
    pendingInterruptNote: false,
    isProcessing: () => false,
    setProcessing: () => {},
    getTurnChannelContext: () => null,
    getTurnInterfaceContext: () => null,
  } as unknown as MessagingConversationContext;
}

async function messageRow(
  id: string,
): Promise<{ content: string; metadata: string | null }> {
  return (await requireMainDb().get<{
    content: string;
    metadata: string | null;
  }>("SELECT content, metadata FROM messages WHERE id = ?", [id]))!;
}

describePg("interrupted-turn note on the interrupting message", () => {
  beforeEach(async () => {
    await resetTables();
  });

  test("rides on the LLM-facing content while the persisted row stays clean", async () => {
    const conv = await createConversation();
    const ctx = makeCtx(conv.id);
    ctx.pendingInterruptNote = true;

    const persisted = await persistQueuedMessageBody(ctx, {
      content: "wait, quick one first: what is 31 times 12?",
    });

    const llmContent = ctx.messages[0].content as ContentBlock[];
    expect(llmContent.at(-1)).toEqual({
      type: "text",
      text: INTERRUPTED_TURN_NOTE_TEXT,
    });
    expect(llmContent[0]).toEqual({
      type: "text",
      text: "wait, quick one first: what is 31 times 12?",
    });

    const row = await messageRow(persisted.id);
    expect(row.content).not.toContain("interrupted_turn");
    expect(JSON.parse(row.content)).toEqual([
      { type: "text", text: "wait, quick one first: what is 31 times 12?" },
    ]);
    expect(JSON.parse(row.metadata!).interruptedPriorTurn).toBe(true);
  });

  test("history reload rebuilds the identical block", async () => {
    const conv = await createConversation();
    const ctx = makeCtx(conv.id);
    ctx.pendingInterruptNote = true;

    const persisted = await persistQueuedMessageBody(ctx, {
      content: "hold on",
    });
    const live = (ctx.messages[0].content as ContentBlock[]).at(-1) as {
      type: "text";
      text: string;
    };

    const row = await messageRow(persisted.id);
    const rebuilt = reinjectInterruptTurnNote(
      JSON.parse(row.content) as ContentBlock[],
      "user",
      row.metadata,
    );

    expect(rebuilt.at(-1)).toEqual(live);
    expect(rebuilt).toHaveLength(2);
  });

  test("an ordinary send carries no note", async () => {
    const conv = await createConversation();
    const ctx = makeCtx(conv.id);

    const persisted = await persistQueuedMessageBody(ctx, {
      content: "just a message",
    });

    const llmContent = ctx.messages[0].content as ContentBlock[];
    expect(llmContent).toHaveLength(1);

    const row = await messageRow(persisted.id);
    expect(
      JSON.parse(row.metadata ?? "{}").interruptedPriorTurn,
    ).toBeUndefined();
    expect(
      reinjectInterruptTurnNote(
        JSON.parse(row.content) as ContentBlock[],
        "user",
        row.metadata,
      ),
    ).toHaveLength(1);
  });

  test("the flag is consumed once, so the next message is untouched", async () => {
    const conv = await createConversation();
    const ctx = makeCtx(conv.id);
    ctx.pendingInterruptNote = true;

    await persistQueuedMessageBody(ctx, { content: "first" });
    await persistQueuedMessageBody(ctx, { content: "second" });

    expect(ctx.pendingInterruptNote).toBe(false);
    expect(ctx.messages[0].content as ContentBlock[]).toHaveLength(2);
    expect(ctx.messages[1].content as ContentBlock[]).toHaveLength(1);
  });

  test("the note sits after the attachment annotations, live and reloaded", async () => {
    const conv = await createConversation();
    const ctx = makeCtx(conv.id);
    ctx.pendingInterruptNote = true;

    // "aGVsbG8=" = "hello"
    const persisted = await persistQueuedMessageBody(ctx, {
      content: "look at this instead",
      attachments: [
        { filename: "report.csv", mimeType: "text/csv", data: "aGVsbG8=" },
      ],
    });

    const llmContent = ctx.messages[0].content as ContentBlock[];
    const note = llmContent.at(-1) as { type: "text"; text: string };
    const annotation = llmContent.at(-2) as { type: "text"; text: string };
    expect(note.text).toBe(INTERRUPTED_TURN_NOTE_TEXT);
    expect(annotation.text).toContain("is stored at:");

    const row = await messageRow(persisted.id);
    expect(row.content).not.toContain("interrupted_turn");
    expect(JSON.parse(row.metadata!).interruptedPriorTurn).toBe(true);
  });

  test("an assistant row is never annotated", () => {
    expect(
      reinjectInterruptTurnNote(
        [{ type: "text", text: "on it." }],
        "assistant",
        JSON.stringify({ interruptedPriorTurn: true }),
      ),
    ).toHaveLength(1);
  });
});
