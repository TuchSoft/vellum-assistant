import { beforeEach, expect, test } from "bun:test";

import {
  addMessage,
  createConversation,
  ensureConversationExists,
  getConversation,
} from "../persistence/conversation-crud.js";
import { requireMainDb } from "../persistence/db-facade.js";
import { describePg } from "./pg-test-db.js";

describePg("ensureConversationExists", () => {
  beforeEach(async () => {
    const db = requireMainDb();
    await db.run("DELETE FROM messages");
    await db.run("DELETE FROM conversations");
  });

  test("adopts the given id so a first message persists without an FK error", async () => {
    // Regression (JARVIS-1259): the live-voice first turn of a new chat adopts
    // an unpersisted client conversation id. Persisting the user message before
    // the row exists tripped `FOREIGN KEY constraint failed`.
    const conversationId = "brand-new-live-voice-conversation";

    // Reports that it inserted the row so callers can emit a one-time
    // conversations-list invalidation.
    expect(await ensureConversationExists(conversationId, "vellum")).toBe(true);

    const row = await getConversation(conversationId);
    expect(row?.id).toBe(conversationId);

    // The FK target now exists, so the user-message insert succeeds.
    const message = await addMessage(
      conversationId,
      "user",
      "hello from voice",
      {
        skipIndexing: true,
      },
    );
    expect(message.conversationId).toBe(conversationId);
  });

  test("is idempotent and never clobbers an existing conversation", async () => {
    const created = await createConversation({ title: "already here" });

    // Two extra ensures must be no-ops — return false (did not create), no
    // throw, no title/row change.
    expect(await ensureConversationExists(created.id, "vellum")).toBe(false);
    expect(await ensureConversationExists(created.id, "vellum")).toBe(false);

    const row = await getConversation(created.id);
    expect(row?.id).toBe(created.id);
    expect(row?.title).toBe("already here");
  });

  test("rejects an unsafe adopted id instead of writing outside the conversations dir", async () => {
    // The id becomes a path component of the on-disk conversation dir, so a
    // traversal value from an untrusted live-voice start frame must be refused
    // before createConversation() touches disk.
    for (const unsafe of ["../../tmp/x", "a/b", "..", "with space", ""]) {
      await expect(async () => {
        await ensureConversationExists(unsafe, "vellum");
      }).toThrow(/unsafe conversation id/);
      expect(await getConversation(unsafe)).toBeNull();
    }

    // A plain uuid-shaped id is still accepted.
    expect(
      await ensureConversationExists(
        "0f9c1e2a-3b4d-5e6f-7a8b-9c0d1e2f3a4b",
        "vellum",
      ),
    ).toBe(true);
  });
});
