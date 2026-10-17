import { beforeEach, expect, setDefaultTimeout, test } from "bun:test";

import {
  createConversation,
  getConversation,
  resolveOverrideProfile,
  setConversationInferenceProfile,
  setConversationInferenceProfileSession,
} from "../persistence/conversation-crud.js";
import { requireMainDb } from "../persistence/db-facade.js";
import { describePg } from "./pg-test-db.js";

describePg("setConversationInferenceProfile", () => {
  beforeEach(async () => {
    const db = requireMainDb();
    await db.run(`DELETE FROM messages`);
    await db.run(`DELETE FROM conversations`);
  });

  test("round-trips null → name → null on the inferenceProfile column", async () => {
    const conv = await createConversation("inference-profile-roundtrip");
    expect((await getConversation(conv.id))?.inferenceProfile).toBeNull();

    await setConversationInferenceProfile(conv.id, "quality-optimized");
    expect((await getConversation(conv.id))?.inferenceProfile).toBe(
      "quality-optimized",
    );

    await setConversationInferenceProfile(conv.id, null);
    expect((await getConversation(conv.id))?.inferenceProfile).toBeNull();
  });

  test("does not throw when called with a valid conversation id", async () => {
    const conv = await createConversation("inference-profile-no-throw");
    await setConversationInferenceProfile(conv.id, "balanced");
    await setConversationInferenceProfile(conv.id, null);
  });

  test("getConversation surfaces the column on every fetch", async () => {
    const conv = await createConversation("inference-profile-getter");
    const fresh = await getConversation(conv.id);
    expect(fresh).not.toBeNull();
    expect(fresh).toHaveProperty("inferenceProfile", null);

    await setConversationInferenceProfile(conv.id, "cost-optimized");
    const updated = await getConversation(conv.id);
    expect(updated).toHaveProperty("inferenceProfile", "cost-optimized");
  });
});

describePg("resolveOverrideProfile — lazy expiry check", () => {
  beforeEach(async () => {
    const db = requireMainDb();
    await db.run(`DELETE FROM messages`);
    await db.run(`DELETE FROM conversations`);
  });

  test("returns undefined when inferenceProfileExpiresAt is in the past", async () => {
    const conv = await createConversation("inference-profile-expired");
    // Set a session-backed profile with an already-expired timestamp.
    await setConversationInferenceProfileSession(
      conv.id,
      "balanced",
      "session-uuid-1",
      Date.now() - 1,
    );
    const row = await getConversation(conv.id);
    expect(row).not.toBeNull();
    expect(resolveOverrideProfile(row)).toBeUndefined();
  });

  test("returns the profile when inferenceProfileExpiresAt is in the future", async () => {
    const conv = await createConversation("inference-profile-active-session");
    await setConversationInferenceProfileSession(
      conv.id,
      "balanced",
      "session-uuid-2",
      Date.now() + 60_000,
    );
    const row = await getConversation(conv.id);
    expect(row).not.toBeNull();
    expect(resolveOverrideProfile(row)).toBe("balanced");
  });

  test("returns undefined at the exact-expiry boundary (expiresAt === now)", async () => {
    // Boundary consistency with the reaper SQL (`expires_at <= now`) and
    // the active-session queries (`expiresAt > now`): the lazy check must
    // treat `expiresAt === now` as expired, not active. Otherwise a
    // just-expired session would be served for one extra turn while the
    // reaper is racing to clear it.
    const conv = await createConversation("inference-profile-boundary");
    const now = Date.now();
    await setConversationInferenceProfileSession(
      conv.id,
      "balanced",
      "session-uuid-boundary",
      now,
    );
    const row = await getConversation(conv.id);
    expect(row).not.toBeNull();
    expect(row?.inferenceProfileExpiresAt).toBe(now);
    // Freeze Date.now to the exact stored expiry so this is deterministic.
    const realNow = Date.now;
    Date.now = () => now;
    try {
      expect(resolveOverrideProfile(row)).toBeUndefined();
    } finally {
      Date.now = realNow;
    }
  });

  test("returns the profile when no expiry is set (non-session override)", async () => {
    const conv = await createConversation("inference-profile-no-expiry");
    await setConversationInferenceProfileSession(
      conv.id,
      "quality-optimized",
      null,
      null,
    );
    const row = await getConversation(conv.id);
    expect(row).not.toBeNull();
    expect(resolveOverrideProfile(row)).toBe("quality-optimized");
  });

  test.each<"background" | "scheduled">(["background", "scheduled"])(
    "returns undefined for %s conversations even when a profile is pinned",
    async (conversationType) => {
      const conv = await createConversation({
        title: `inference-profile-${conversationType}`,
        conversationType,
      });
      await setConversationInferenceProfileSession(
        conv.id,
        "quality-optimized",
        null,
        null,
      );
      const row = await getConversation(conv.id);
      expect(row).not.toBeNull();
      expect(row?.conversationType).toBe(conversationType);
      expect(row?.inferenceProfile).toBe("quality-optimized");
      expect(resolveOverrideProfile(row)).toBeUndefined();
    },
  );
});

setDefaultTimeout(30_000);
