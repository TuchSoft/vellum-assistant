import { expect, test } from "bun:test";

import { describePg } from "../__tests__/pg-test-db.js";
import {
  advanceConversationModeSessionRevision,
  beginConversationModeSession,
  finalizeConversationModeSession,
  getConversationModeSession,
  listConversationModeSessionsByIds,
  repairConversationModeSessionBoundaries,
  updateConversationModeSessionActivity,
  updateConversationModeSessionBoundaries,
} from "./conversation-mode-sessions.js";
import { requireMainDb } from "./db-facade.js";

async function createStore() {
  const db = requireMainDb();
  await db.run("DELETE FROM conversation_mode_sessions");
  await db.run("DELETE FROM messages");
  await db.run("DELETE FROM conversations");
  await db.run(
    "INSERT INTO conversations (id, created_at, updated_at) VALUES ('conv-123', 0, 0), ('conv-456', 0, 0)",
  );
  return { db, options: { db } };
}

describePg("conversation mode session store", () => {
  test("records activity and display boundaries with monotonic revisions", async () => {
    const { options } = await createStore();
    const started = await beginConversationModeSession(
      {
        id: "session-123",
        conversationId: "conv-123",
        mode: "computer_use",
        sourceStartedAt: 100,
      },
      options,
    );
    expect(started).toMatchObject({
      ok: true,
      session: {
        revision: 1,
        status: "active",
        lastActivityAt: 100,
      },
    });

    const activity = await updateConversationModeSessionActivity(
      {
        id: "session-123",
        conversationId: "conv-123",
        expectedRevision: 1,
        lastActivityAt: 150,
        lastOwnedMessageId: "message-456",
      },
      options,
    );
    expect(activity).toMatchObject({
      ok: true,
      session: {
        revision: 2,
        lastActivityAt: 150,
        lastOwnedMessageId: "message-456",
      },
    });

    const boundaries = await updateConversationModeSessionBoundaries(
      {
        id: "session-123",
        conversationId: "conv-123",
        expectedRevision: 2,
        firstIncluded: { at: 90, messageId: "message-123" },
        lastActivityAt: 175,
        lastOwnedMessageId: "message-789",
      },
      options,
    );
    expect(boundaries).toMatchObject({
      ok: true,
      session: {
        revision: 3,
        firstIncludedAt: 90,
        firstIncludedMessageId: "message-123",
        lastActivityAt: 175,
        lastOwnedMessageId: "message-789",
      },
    });

    expect(
      await updateConversationModeSessionActivity(
        {
          id: "session-123",
          conversationId: "conv-123",
          expectedRevision: 3,
          lastActivityAt: 125,
        },
        options,
      ),
    ).toMatchObject({
      ok: true,
      session: { revision: 4, lastActivityAt: 175 },
    });
  });

  test("rejects stale writes and keeps terminal records immutable", async () => {
    const { options } = await createStore();
    await beginConversationModeSession(
      {
        id: "session-123",
        conversationId: "conv-123",
        mode: "browser",
        sourceStartedAt: 100,
      },
      options,
    );
    const advanced = await advanceConversationModeSessionRevision(
      {
        id: "session-123",
        conversationId: "conv-123",
        expectedRevision: 1,
      },
      options,
    );
    expect(advanced).toMatchObject({ ok: true, session: { revision: 2 } });

    expect(
      await finalizeConversationModeSession(
        {
          id: "session-123",
          conversationId: "conv-123",
          expectedRevision: 1,
          status: "completed",
          endedAt: 180,
          endReason: "settled",
        },
        options,
      ),
    ).toMatchObject({
      ok: false,
      reason: "stale_revision",
      session: { revision: 2, status: "active" },
    });

    const finalized = await finalizeConversationModeSession(
      {
        id: "session-123",
        conversationId: "conv-123",
        expectedRevision: 2,
        status: "completed",
        endedAt: 180,
        endReason: "settled",
      },
      options,
    );
    expect(finalized).toMatchObject({
      ok: true,
      session: { revision: 3, status: "completed", endedAt: 180 },
    });

    expect(
      await finalizeConversationModeSession(
        {
          id: "session-123",
          conversationId: "conv-123",
          expectedRevision: 2,
          status: "completed",
          endedAt: 180,
          endReason: "settled",
        },
        options,
      ),
    ).toMatchObject({
      ok: true,
      session: { revision: 3, status: "completed", endedAt: 180 },
    });

    expect(
      await finalizeConversationModeSession(
        {
          id: "session-123",
          conversationId: "conv-123",
          expectedRevision: 2,
          status: "interrupted",
          endedAt: null,
          endReason: "late_callback",
        },
        options,
      ),
    ).toMatchObject({
      ok: false,
      reason: "terminal",
      session: { revision: 3, status: "completed", endedAt: 180 },
    });
  });

  test("rejects a terminal timestamp before confirmed activity", async () => {
    const { options } = await createStore();
    await beginConversationModeSession(
      {
        id: "session-123",
        conversationId: "conv-123",
        mode: "browser",
        sourceStartedAt: 100,
      },
      options,
    );

    await expect(
      finalizeConversationModeSession(
        {
          id: "session-123",
          conversationId: "conv-123",
          expectedRevision: 1,
          status: "completed",
          endedAt: 90,
          endReason: "settled",
        },
        options,
      ),
    ).rejects.toThrow("Mode session end cannot precede its last activity");
    expect(
      await getConversationModeSession("conv-123", "session-123", options),
    ).toMatchObject({ status: "active", revision: 1 });
  });

  test("does not reopen an existing id and scopes batched reads by conversation", async () => {
    const { options } = await createStore();
    await beginConversationModeSession(
      {
        id: "session-123",
        conversationId: "conv-123",
        mode: "browser",
        sourceStartedAt: 100,
      },
      options,
    );
    await beginConversationModeSession(
      {
        id: "session-456",
        conversationId: "conv-456",
        mode: "ambient",
        sourceStartedAt: 200,
      },
      options,
    );

    expect(
      await beginConversationModeSession(
        {
          id: "session-123",
          conversationId: "conv-123",
          mode: "computer_use",
          sourceStartedAt: 300,
        },
        options,
      ),
    ).toMatchObject({
      ok: false,
      reason: "already_exists",
      session: { mode: "browser", sourceStartedAt: 100, revision: 1 },
    });

    expect(
      (
        await listConversationModeSessionsByIds(
          "conv-123",
          ["session-456", "session-123", "session-123"],
          options,
        )
      ).map((session) => session.id),
    ).toEqual(["session-123"]);
    expect(
      await getConversationModeSession("conv-123", "session-456", options),
    ).toBe(null);
  });

  test("repairs replaceable boundaries without reopening a terminal session", async () => {
    const { db, options } = await createStore();
    await beginConversationModeSession(
      {
        id: "session-123",
        conversationId: "conv-123",
        mode: "browser",
        sourceStartedAt: 100,
      },
      options,
    );
    await updateConversationModeSessionBoundaries(
      {
        id: "session-123",
        conversationId: "conv-123",
        expectedRevision: 1,
        firstIncluded: { at: 90, messageId: "message-deleted" },
        lastActivityAt: 100,
        lastOwnedMessageId: "message-last",
      },
      options,
    );
    await finalizeConversationModeSession(
      {
        id: "session-123",
        conversationId: "conv-123",
        expectedRevision: 2,
        status: "completed",
        endedAt: 150,
        endReason: "settled",
      },
      options,
    );
    await db.run(
      "INSERT INTO messages (id, conversation_id, created_at, metadata) VALUES (?, ?, ?, ?), (?, ?, ?, ?), (?, ?, ?, ?), (?, ?, ?, ?)",
      [
        "message-leading",
        "conv-123",
        110,
        '{"modeSession":{"mode":"browser","id":"session-123"}}',
        "message-middle",
        "conv-123",
        120,
        '{"modeSession":{"mode":"browser","id":"session-123"},"sentAt":115}',
        "message-last",
        "conv-123",
        130,
        '{"modeSession":{"mode":"browser","id":"session-123"}}',
        "message-other",
        "conv-456",
        90,
        '{"modeSession":{"mode":"browser","id":"session-123"}}',
      ],
    );
    await db.run(
      "UPDATE messages SET role = 'user' WHERE id = 'message-leading'",
    );

    expect(
      await repairConversationModeSessionBoundaries("conv-123", options),
    ).toBe(1);
    expect(
      await getConversationModeSession("conv-123", "session-123", options),
    ).toMatchObject({
      status: "completed",
      endedAt: 150,
      endReason: "settled",
      revision: 4,
      firstIncludedAt: 115,
      firstIncludedMessageId: "message-middle",
      lastOwnedMessageId: "message-last",
      lastActivityAt: 130,
    });
  });

  test("repairs Ambient to an assistant-first boundary while Live keeps its leading frame", async () => {
    const { db, options } = await createStore();
    await beginConversationModeSession(
      {
        id: "ambient-session",
        conversationId: "conv-123",
        mode: "ambient",
        sourceStartedAt: 100,
      },
      options,
    );
    await beginConversationModeSession(
      {
        id: "live-session",
        conversationId: "conv-123",
        mode: "live_vision",
        sourceStartedAt: 200,
      },
      options,
    );
    await db.run(
      "INSERT INTO messages (id, conversation_id, role, created_at, metadata) VALUES (?, ?, ?, ?, ?), (?, ?, ?, ?, ?), (?, ?, ?, ?, ?), (?, ?, ?, ?, ?), (?, ?, ?, ?, ?), (?, ?, ?, ?, ?)",
      [
        "ambient-deleted",
        "conv-123",
        "user",
        105,
        '{"modeSession":{"mode":"ambient","id":"ambient-session"}}',
        "ambient-frame",
        "conv-123",
        "user",
        110,
        '{"modeSession":{"mode":"ambient","id":"ambient-session"}}',
        "ambient-assistant",
        "conv-123",
        "assistant",
        120,
        '{"modeSession":{"mode":"ambient","id":"ambient-session"}}',
        "live-deleted",
        "conv-123",
        "user",
        205,
        '{"modeSession":{"mode":"live_vision","id":"live-session"}}',
        "live-frame",
        "conv-123",
        "user",
        210,
        '{"modeSession":{"mode":"live_vision","id":"live-session"}}',
        "live-assistant",
        "conv-123",
        "assistant",
        220,
        '{"modeSession":{"mode":"live_vision","id":"live-session"}}',
      ],
    );
    await updateConversationModeSessionBoundaries(
      {
        id: "ambient-session",
        conversationId: "conv-123",
        expectedRevision: 1,
        firstIncluded: { at: 105, messageId: "ambient-deleted" },
        lastActivityAt: 120,
        lastOwnedMessageId: "ambient-assistant",
      },
      options,
    );
    await updateConversationModeSessionBoundaries(
      {
        id: "live-session",
        conversationId: "conv-123",
        expectedRevision: 1,
        firstIncluded: { at: 205, messageId: "live-deleted" },
        lastActivityAt: 220,
        lastOwnedMessageId: "live-assistant",
      },
      options,
    );
    await db.run(
      "DELETE FROM messages WHERE id IN ('ambient-deleted', 'live-deleted')",
    );

    expect(
      await repairConversationModeSessionBoundaries("conv-123", options),
    ).toBe(2);
    expect(
      await getConversationModeSession("conv-123", "ambient-session", options),
    ).toMatchObject({
      firstIncludedAt: 120,
      firstIncludedMessageId: "ambient-assistant",
      lastOwnedMessageId: "ambient-assistant",
      lastActivityAt: 120,
    });
    expect(
      await getConversationModeSession("conv-123", "live-session", options),
    ).toMatchObject({
      firstIncludedAt: 210,
      firstIncludedMessageId: "live-frame",
      lastOwnedMessageId: "live-assistant",
      lastActivityAt: 220,
    });
  });
});
