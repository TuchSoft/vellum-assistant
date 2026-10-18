import { afterEach, expect, mock, setDefaultTimeout, test } from "bun:test";

mock.module("../plugins/defaults/memory/indexer.js", () => ({
  MIN_SEGMENT_CHARS: 50,
  indexMessageNow: async () => ({ indexedSegments: 0, enqueuedJobs: 0 }),
  enqueueBackfillJob: () => "",
  enqueueRebuildIndexJob: () => "",
}));

import { consolidateAssistantMessages } from "../daemon/conversation-history.js";
import {
  addMessage,
  createConversation,
  deleteLastExchange,
  getMessages,
} from "../persistence/conversation-crud.js";
import {
  beginConversationModeSession,
  updateConversationModeSessionBoundaries,
} from "../persistence/conversation-mode-sessions.js";
import { requireMainDb } from "../persistence/db-facade.js";
import { describePg } from "./pg-test-db.js";

const FAIL_REPAIR_TRIGGER = "fail_mode_session_boundary_repair";

async function installFailingBoundaryRepairTrigger(): Promise<void> {
  const db = requireMainDb();
  await db.run(/* sql */ `
    CREATE OR REPLACE FUNCTION ${FAIL_REPAIR_TRIGGER}()
    RETURNS trigger AS $$
    BEGIN
      RAISE EXCEPTION 'injected boundary repair failure';
    END;
    $$ LANGUAGE plpgsql
  `);
  await db.run(
    `DROP TRIGGER IF EXISTS ${FAIL_REPAIR_TRIGGER} ON conversation_mode_sessions`,
  );
  await db.run(/* sql */ `
    CREATE TRIGGER ${FAIL_REPAIR_TRIGGER}
    BEFORE UPDATE ON conversation_mode_sessions
    FOR EACH ROW EXECUTE FUNCTION ${FAIL_REPAIR_TRIGGER}()
  `);
}

afterEach(async () => {
  const db = requireMainDb();
  await db.run(
    `DROP TRIGGER IF EXISTS ${FAIL_REPAIR_TRIGGER} ON conversation_mode_sessions`,
  );
  await db.run(`DROP FUNCTION IF EXISTS ${FAIL_REPAIR_TRIGGER}()`);
});

describePg("message deletion mode-session boundary repair failures", () => {
  test("consolidation deletes every donor without duplicating copied content", async () => {
    const conversation = await createConversation(
      "Boundary repair consolidation",
    );
    const sessionId = `session-${conversation.id}`;
    const owner = { id: sessionId, mode: "browser" as const };
    const sourceStartedAt = Date.now() - 10_000;
    expect(
      await beginConversationModeSession({
        id: sessionId,
        conversationId: conversation.id,
        mode: owner.mode,
        sourceStartedAt,
      }),
    ).toMatchObject({ ok: true });

    const user = await addMessage(conversation.id, "user", "Run the tool");
    const retained = await addMessage(
      conversation.id,
      "assistant",
      JSON.stringify([
        { type: "tool_use", id: "tool-1", name: "example", input: {} },
      ]),
      { metadata: { modeSession: owner } },
    );
    const toolResult = await addMessage(
      conversation.id,
      "user",
      JSON.stringify([
        { type: "tool_result", tool_use_id: "tool-1", content: "done" },
      ]),
      { metadata: { modeSession: owner } },
    );
    const donor = await addMessage(
      conversation.id,
      "assistant",
      JSON.stringify([{ type: "text", text: "Finished once." }]),
      { metadata: { modeSession: owner } },
    );
    expect(
      await updateConversationModeSessionBoundaries({
        id: sessionId,
        conversationId: conversation.id,
        expectedRevision: 1,
        firstIncluded: {
          at: retained.createdAt,
          messageId: retained.id,
        },
        lastActivityAt: donor.createdAt,
        lastOwnedMessageId: donor.id,
      }),
    ).toMatchObject({ ok: true });
    await installFailingBoundaryRepairTrigger();

    expect(await consolidateAssistantMessages(conversation.id, user.id)).toBe(
      true,
    );
    const rows = await getMessages(conversation.id);
    expect(rows.map((row) => row.id)).toEqual([user.id, retained.id]);
    const retainedContent = rows[1]!.content;
    expect(retainedContent).toEqual([
      { type: "tool_use", id: "tool-1", name: "example", input: {} },
      { type: "text", text: "Finished once." },
      { type: "tool_result", tool_use_id: "tool-1", content: "done" },
    ]);

    expect(await consolidateAssistantMessages(conversation.id, user.id)).toBe(
      false,
    );
    expect((await getMessages(conversation.id))[1]!.content).toEqual(
      retainedContent,
    );
    expect(
      (await getMessages(conversation.id)).some((row) => row.id === donor.id),
    ).toBe(false);
    expect(
      (await getMessages(conversation.id)).some(
        (row) => row.id === toolResult.id,
      ),
    ).toBe(false);
  });

  test("tail deletion returns its committed count when boundary repair fails", async () => {
    const conversation = await createConversation(
      "Boundary repair tail delete",
    );
    const sessionId = `session-${conversation.id}`;
    const owner = { id: sessionId, mode: "browser" as const };
    expect(
      await beginConversationModeSession({
        id: sessionId,
        conversationId: conversation.id,
        mode: owner.mode,
        sourceStartedAt: Date.now() - 10_000,
      }),
    ).toMatchObject({ ok: true });
    const keptUser = await addMessage(conversation.id, "user", "Keep this");
    const keptAssistant = await addMessage(
      conversation.id,
      "assistant",
      "Kept reply",
    );
    const deletedUser = await addMessage(
      conversation.id,
      "user",
      "Delete this",
      { metadata: { modeSession: owner } },
    );
    const deletedAssistant = await addMessage(
      conversation.id,
      "assistant",
      "Deleted reply",
      { metadata: { modeSession: owner } },
    );
    expect(
      await updateConversationModeSessionBoundaries({
        id: sessionId,
        conversationId: conversation.id,
        expectedRevision: 1,
        firstIncluded: {
          at: deletedAssistant.createdAt,
          messageId: deletedAssistant.id,
        },
        lastActivityAt: deletedAssistant.createdAt,
        lastOwnedMessageId: deletedAssistant.id,
      }),
    ).toMatchObject({ ok: true });
    await installFailingBoundaryRepairTrigger();

    expect(await deleteLastExchange(conversation.id)).toBe(2);
    expect((await getMessages(conversation.id)).map((row) => row.id)).toEqual([
      keptUser.id,
      keptAssistant.id,
    ]);
    expect(
      (await getMessages(conversation.id)).some(
        (row) => row.id === deletedUser.id,
      ),
    ).toBe(false);
    expect(
      (await getMessages(conversation.id)).some(
        (row) => row.id === deletedAssistant.id,
      ),
    ).toBe(false);
  });
});

setDefaultTimeout(30_000);
