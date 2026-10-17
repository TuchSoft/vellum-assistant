import { afterEach, expect, setDefaultTimeout, test } from "bun:test";
setDefaultTimeout(30_000);

import {
  isModeSessionRecoveryHealthy,
  isSessionGroupsEnabled,
  setModeSessionRecoveryHealthy,
} from "../config/session-groups-gate.js";
import {
  getDbMigrationReadiness,
  setDbMigrating,
  setDbReady,
} from "../daemon/daemon-readiness.js";
import { recoverModeSessionsBeforeDbReady } from "../daemon/mode-session-startup-recovery.js";
import {
  beginConversationModeSession,
  finalizeConversationModeSession,
  getConversationModeSession,
  recoverActiveConversationModeSessions,
  updateConversationModeSessionActivity,
} from "../persistence/conversation-mode-sessions.js";
import { requireMainDb } from "../persistence/db-facade.js";
import { setOverridesForTesting } from "./feature-flag-test-helpers.js";
import { describePg } from "./pg-test-db.js";

afterEach(() => {
  setDbReady(true);
  setModeSessionRecoveryHealthy(true);
  setOverridesForTesting({});
});

async function createStore() {
  const db = requireMainDb();
  await db.run("DELETE FROM conversation_mode_sessions");
  await db.run("DELETE FROM conversations");
  await db.run("INSERT INTO conversations (id) VALUES ('conv-123')");
  return { db, options: { db } };
}

describePg("mode session startup recovery", () => {
  test("publishes readiness only after recovery succeeds", async () => {
    setDbMigrating();
    let readinessDuringRecovery = getDbMigrationReadiness();

    const result = await recoverModeSessionsBeforeDbReady(async () => {
      readinessDuringRecovery = getDbMigrationReadiness();
      return 2;
    });

    expect(readinessDuringRecovery).toMatchObject({
      ready: false,
      state: "running",
    });
    expect(result).toEqual({ ok: true, interruptedCount: 2 });
    expect(getDbMigrationReadiness()).toEqual({
      ready: true,
      state: "ready",
    });
  });

  test.each([false, true])(
    "keeps ordinary work ready after recovery fails with flag %s",
    async (enabled) => {
      setOverridesForTesting({ "session-groups": enabled });
      setDbMigrating();
      const recoveryError = new Error("recovery failed");
      const result = await recoverModeSessionsBeforeDbReady(async () => {
        throw recoveryError;
      });
      expect(result).toEqual({ ok: false, error: recoveryError });
      expect(getDbMigrationReadiness()).toEqual({
        ready: true,
        state: "ready",
      });
      expect(isModeSessionRecoveryHealthy()).toBe(false);
      expect(isSessionGroupsEnabled()).toBe(false);
      setOverridesForTesting({ "session-groups": true });
      expect(isSessionGroupsEnabled()).toBe(false);
      setDbMigrating();
      expect(await recoverModeSessionsBeforeDbReady(async () => 1)).toEqual({
        ok: true,
        interruptedCount: 1,
      });
      expect(isSessionGroupsEnabled()).toBe(true);
    },
  );

  test("interrupts active records without fabricating an end time", async () => {
    const { options } = await createStore();
    await beginConversationModeSession(
      {
        id: "session-active",
        conversationId: "conv-123",
        mode: "browser",
        sourceStartedAt: 100,
      },
      options,
    );
    await updateConversationModeSessionActivity(
      {
        id: "session-active",
        conversationId: "conv-123",
        expectedRevision: 1,
        lastActivityAt: 140,
        lastOwnedMessageId: "message-123",
      },
      options,
    );

    expect(await recoverActiveConversationModeSessions(options)).toBe(1);
    expect(
      await getConversationModeSession("conv-123", "session-active", options),
    ).toMatchObject({
      status: "interrupted",
      lastActivityAt: 140,
      lastOwnedMessageId: "message-123",
      endedAt: null,
      endReason: "assistant_restarted",
      revision: 3,
    });
    expect(await recoverActiveConversationModeSessions(options)).toBe(0);
  });

  test("preserves terminal truth and prevents an old callback from reopening it", async () => {
    const { options } = await createStore();
    await beginConversationModeSession(
      {
        id: "session-completed",
        conversationId: "conv-123",
        mode: "computer_use",
        sourceStartedAt: 100,
      },
      options,
    );
    await finalizeConversationModeSession(
      {
        id: "session-completed",
        conversationId: "conv-123",
        expectedRevision: 1,
        status: "completed",
        endedAt: 150,
        endReason: "settled",
      },
      options,
    );

    expect(await recoverActiveConversationModeSessions(options)).toBe(0);
    expect(
      await updateConversationModeSessionActivity(
        {
          id: "session-completed",
          conversationId: "conv-123",
          expectedRevision: 2,
          lastActivityAt: 200,
        },
        options,
      ),
    ).toMatchObject({
      ok: false,
      reason: "terminal",
      session: { status: "completed", endedAt: 150, revision: 2 },
    });
  });

  test("recovered work can only continue under a fresh session id", async () => {
    const { options } = await createStore();
    await beginConversationModeSession(
      {
        id: "session-before-restart",
        conversationId: "conv-123",
        mode: "browser",
        sourceStartedAt: 100,
      },
      options,
    );
    await recoverModeSessionsBeforeDbReady(async () => {
      throw new Error("recovery unavailable");
    });
    expect(
      (
        await getConversationModeSession(
          "conv-123",
          "session-before-restart",
          options,
        )
      )?.status,
    ).toBe("active");
    setDbMigrating();
    expect(
      await recoverModeSessionsBeforeDbReady(() =>
        recoverActiveConversationModeSessions(options),
      ),
    ).toEqual({ ok: true, interruptedCount: 1 });

    expect(
      await beginConversationModeSession(
        {
          id: "session-before-restart",
          conversationId: "conv-123",
          mode: "browser",
          sourceStartedAt: 200,
        },
        options,
      ),
    ).toMatchObject({ ok: false, reason: "already_exists" });
    expect(
      await beginConversationModeSession(
        {
          id: "session-after-restart",
          conversationId: "conv-123",
          mode: "browser",
          sourceStartedAt: 200,
        },
        options,
      ),
    ).toMatchObject({
      ok: true,
      session: { id: "session-after-restart", status: "active", revision: 1 },
    });
  });
});
