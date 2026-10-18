import { beforeEach, expect, test } from "bun:test";

import {
  answerPendingQuestion,
  claimCallback,
  createCallSession,
  createPendingQuestion,
  expirePendingQuestions,
  finalizeCallbackClaim,
  getActiveCallSessionForConversation,
  getCallEvents,
  getCallSession,
  getCallSessionByCallSid,
  getPendingQuestion,
  recordCallEvent,
  releaseCallbackClaim,
  updateCallSession,
} from "../calls/call-store.js";
import { requireMainDb } from "../persistence/db-facade.js";
import { describePg } from "./pg-test-db.js";

/** Ensure a conversation row exists for the given ID so FK constraints pass. */
let ensuredConvIds = new Set<string>();
async function ensureConversation(id: string): Promise<void> {
  if (ensuredConvIds.has(id)) {
    return;
  }
  const db = requireMainDb();
  const now = Date.now();
  await db.run(
    "INSERT INTO conversations (id, title, created_at, updated_at) VALUES (?, ?, ?, ?)",
    [id, `Test conversation ${id}`, now, now],
  );
  ensuredConvIds.add(id);
}

async function resetTables(): Promise<void> {
  const db = requireMainDb();
  await db.run("DELETE FROM call_pending_questions");
  await db.run("DELETE FROM call_events");
  await db.run("DELETE FROM call_sessions");
  await db.run("DELETE FROM processed_callbacks");
  await db.run("DELETE FROM messages");
  await db.run("DELETE FROM conversations");
  ensuredConvIds = new Set();
}

/** Wrapper that ensures the FK conversation row exists before creating a session. */
async function createTestCallSession(
  opts: Omit<Parameters<typeof createCallSession>[0], "direction"> & {
    direction?: Parameters<typeof createCallSession>[0]["direction"];
  },
): Promise<ReturnType<typeof createCallSession>> {
  await ensureConversation(opts.conversationId);
  // Direction only shapes the funnel stamp; these suites test other things.
  return createCallSession({ direction: "inbound", ...opts });
}

describePg("call-store", () => {
  beforeEach(async () => {
    await resetTables();
  });

  // ── Call Sessions ─────────────────────────────────────────────────

  test("createCallSession creates a session with correct defaults", async () => {
    const session = await createTestCallSession({
      conversationId: "conv-1",
      provider: "twilio",
      fromNumber: "+15551234567",
      toNumber: "+15559876543",
      task: "Book appointment",
    });

    expect(session.id).toBeDefined();
    expect(session.conversationId).toBe("conv-1");
    expect(session.provider).toBe("twilio");
    expect(session.fromNumber).toBe("+15551234567");
    expect(session.toNumber).toBe("+15559876543");
    expect(session.task).toBe("Book appointment");
    expect(session.status).toBe("initiated");
    expect(session.providerCallSid).toBeNull();
    expect(session.startedAt).toBeNull();
    expect(session.endedAt).toBeNull();
    expect(session.lastError).toBeNull();
    expect(typeof session.createdAt).toBe("number");
    expect(typeof session.updatedAt).toBe("number");
  });

  test("createCallSession defaults task to null when not provided", async () => {
    const session = await createTestCallSession({
      conversationId: "conv-2",
      provider: "twilio",
      fromNumber: "+15551111111",
      toNumber: "+15552222222",
    });

    expect(session.task).toBeNull();
  });

  test("getCallSession retrieves by ID", async () => {
    const created = await createTestCallSession({
      conversationId: "conv-3",
      provider: "twilio",
      fromNumber: "+15551111111",
      toNumber: "+15552222222",
    });

    const retrieved = await getCallSession(created.id);
    expect(retrieved).not.toBeNull();
    expect(retrieved!.id).toBe(created.id);
    expect(retrieved!.conversationId).toBe("conv-3");
  });

  test("getCallSession returns null for missing ID", async () => {
    const result = await getCallSession("nonexistent-id");
    expect(result).toBeNull();
  });

  test("getCallSessionByCallSid looks up by provider call SID", async () => {
    const session = await createTestCallSession({
      conversationId: "conv-4",
      provider: "twilio",
      fromNumber: "+15551111111",
      toNumber: "+15552222222",
    });

    await updateCallSession(session.id, { providerCallSid: "CA_test_sid_123" });

    const found = await getCallSessionByCallSid("CA_test_sid_123");
    expect(found).not.toBeNull();
    expect(found!.id).toBe(session.id);
    expect(found!.providerCallSid).toBe("CA_test_sid_123");
  });

  test("getCallSessionByCallSid returns null for unknown SID", async () => {
    const result = await getCallSessionByCallSid("CA_unknown");
    expect(result).toBeNull();
  });

  test("getActiveCallSessionForConversation finds non-terminal sessions", async () => {
    const session = await createTestCallSession({
      conversationId: "conv-5",
      provider: "twilio",
      fromNumber: "+15551111111",
      toNumber: "+15552222222",
    });

    const active = await getActiveCallSessionForConversation("conv-5");
    expect(active).not.toBeNull();
    expect(active!.id).toBe(session.id);
  });

  test("getActiveCallSessionForConversation returns null when all sessions are completed", async () => {
    const session = await createTestCallSession({
      conversationId: "conv-6",
      provider: "twilio",
      fromNumber: "+15551111111",
      toNumber: "+15552222222",
    });

    await updateCallSession(session.id, { status: "completed" });

    const active = await getActiveCallSessionForConversation("conv-6");
    expect(active).toBeNull();
  });

  test("getActiveCallSessionForConversation returns null when all sessions are failed", async () => {
    const session = await createTestCallSession({
      conversationId: "conv-7",
      provider: "twilio",
      fromNumber: "+15551111111",
      toNumber: "+15552222222",
    });

    await updateCallSession(session.id, { status: "failed" });

    const active = await getActiveCallSessionForConversation("conv-7");
    expect(active).toBeNull();
  });

  test("getActiveCallSessionForConversation returns most recent active session", async () => {
    // Create two sessions for the same conversation
    const older = await createTestCallSession({
      conversationId: "conv-8",
      provider: "twilio",
      fromNumber: "+15551111111",
      toNumber: "+15552222222",
    });
    // Mark older as completed
    await updateCallSession(older.id, { status: "completed" });

    const newer = await createTestCallSession({
      conversationId: "conv-8",
      provider: "twilio",
      fromNumber: "+15551111111",
      toNumber: "+15553333333",
    });

    const active = await getActiveCallSessionForConversation("conv-8");
    expect(active).not.toBeNull();
    expect(active!.id).toBe(newer.id);
  });

  test("updateCallSession updates status, providerCallSid, and timestamps", async () => {
    const session = await createTestCallSession({
      conversationId: "conv-9",
      provider: "twilio",
      fromNumber: "+15551111111",
      toNumber: "+15552222222",
    });

    const now = Date.now();
    await updateCallSession(session.id, {
      status: "in_progress",
      providerCallSid: "CA_updated_sid",
      startedAt: now,
    });

    const updated = await getCallSession(session.id);
    expect(updated).not.toBeNull();
    expect(updated!.status).toBe("in_progress");
    expect(updated!.providerCallSid).toBe("CA_updated_sid");
    expect(updated!.startedAt).toBe(now);
    // updatedAt should be updated
    expect(updated!.updatedAt).toBeGreaterThanOrEqual(session.updatedAt);
  });

  test("updateCallSession sets endedAt and lastError", async () => {
    const session = await createTestCallSession({
      conversationId: "conv-10",
      provider: "twilio",
      fromNumber: "+15551111111",
      toNumber: "+15552222222",
    });

    const endTime = Date.now();
    await updateCallSession(session.id, {
      status: "failed",
      endedAt: endTime,
      lastError: "Network timeout",
    });

    const updated = await getCallSession(session.id);
    expect(updated!.status).toBe("failed");
    expect(updated!.endedAt).toBe(endTime);
    expect(updated!.lastError).toBe("Network timeout");
  });

  // ── Call Events ───────────────────────────────────────────────────

  test("recordCallEvent creates events with correct fields", async () => {
    const session = await createTestCallSession({
      conversationId: "conv-11",
      provider: "twilio",
      fromNumber: "+15551111111",
      toNumber: "+15552222222",
    });

    const event = await recordCallEvent(session.id, "call_started", {
      twilioStatus: "initiated",
    });

    expect(event.id).toBeDefined();
    expect(event.callSessionId).toBe(session.id);
    expect(event.eventType).toBe("call_started");
    expect(typeof event.createdAt).toBe("number");
  });

  test("recordCallEvent stores JSON payload", async () => {
    const session = await createTestCallSession({
      conversationId: "conv-12",
      provider: "twilio",
      fromNumber: "+15551111111",
      toNumber: "+15552222222",
    });

    const payload = { text: "Hello, how are you?", lang: "en-US" };
    const event = await recordCallEvent(session.id, "caller_spoke", payload);

    const parsed = JSON.parse(event.payloadJson);
    expect(parsed.text).toBe("Hello, how are you?");
    expect(parsed.lang).toBe("en-US");
  });

  test("recordCallEvent defaults payload to empty JSON object", async () => {
    const session = await createTestCallSession({
      conversationId: "conv-13",
      provider: "twilio",
      fromNumber: "+15551111111",
      toNumber: "+15552222222",
    });

    const event = await recordCallEvent(session.id, "call_connected");

    expect(event.payloadJson).toBe("{}");
  });

  test("getCallEvents retrieves events in creation order", async () => {
    const session = await createTestCallSession({
      conversationId: "conv-14",
      provider: "twilio",
      fromNumber: "+15551111111",
      toNumber: "+15552222222",
    });

    await recordCallEvent(session.id, "call_started");
    await recordCallEvent(session.id, "call_connected");
    await recordCallEvent(session.id, "caller_spoke", { transcript: "Hi" });

    const events = await getCallEvents(session.id);
    expect(events).toHaveLength(3);
    expect(events[0].eventType).toBe("call_started");
    expect(events[1].eventType).toBe("call_connected");
    expect(events[2].eventType).toBe("caller_spoke");
    // Should be in ascending creation order
    expect(events[0].createdAt).toBeLessThanOrEqual(events[1].createdAt);
    expect(events[1].createdAt).toBeLessThanOrEqual(events[2].createdAt);
  });

  test("getCallEvents returns empty array for session with no events", async () => {
    const session = await createTestCallSession({
      conversationId: "conv-15",
      provider: "twilio",
      fromNumber: "+15551111111",
      toNumber: "+15552222222",
    });

    const events = await getCallEvents(session.id);
    expect(events).toHaveLength(0);
  });

  // ── Pending Questions ─────────────────────────────────────────────

  test("createPendingQuestion creates with status pending", async () => {
    const session = await createTestCallSession({
      conversationId: "conv-16",
      provider: "twilio",
      fromNumber: "+15551111111",
      toNumber: "+15552222222",
    });

    const question = await createPendingQuestion(
      session.id,
      "What is your preferred date?",
    );

    expect(question.id).toBeDefined();
    expect(question.callSessionId).toBe(session.id);
    expect(question.questionText).toBe("What is your preferred date?");
    expect(question.status).toBe("pending");
    expect(typeof question.askedAt).toBe("number");
    expect(question.answeredAt).toBeNull();
    expect(question.answerText).toBeNull();
  });

  test("getPendingQuestion finds pending question for session", async () => {
    const session = await createTestCallSession({
      conversationId: "conv-17",
      provider: "twilio",
      fromNumber: "+15551111111",
      toNumber: "+15552222222",
    });

    const created = await createPendingQuestion(
      session.id,
      "What is your name?",
    );

    const found = await getPendingQuestion(session.id);
    expect(found).not.toBeNull();
    expect(found!.id).toBe(created.id);
    expect(found!.questionText).toBe("What is your name?");
    expect(found!.status).toBe("pending");
  });

  test("getPendingQuestion returns null when no pending questions", async () => {
    const session = await createTestCallSession({
      conversationId: "conv-18",
      provider: "twilio",
      fromNumber: "+15551111111",
      toNumber: "+15552222222",
    });

    const found = await getPendingQuestion(session.id);
    expect(found).toBeNull();
  });

  test("answerPendingQuestion updates status to answered", async () => {
    const session = await createTestCallSession({
      conversationId: "conv-19",
      provider: "twilio",
      fromNumber: "+15551111111",
      toNumber: "+15552222222",
    });

    const question = await createPendingQuestion(session.id, "What color?");
    await answerPendingQuestion(question.id, "Blue");

    // Should no longer appear as pending
    const pending = await getPendingQuestion(session.id);
    expect(pending).toBeNull();

    // Verify the record was updated by querying directly
    const updated = (await requireMainDb().get<{
      status: string;
      answer_text: string;
      answered_at: number;
    }>("SELECT * FROM call_pending_questions WHERE id = ?", [question.id]))!;
    expect(updated.status).toBe("answered");
    expect(updated.answer_text).toBe("Blue");
    expect(typeof updated.answered_at).toBe("number");
  });

  test("expirePendingQuestions marks all pending questions as expired", async () => {
    const session = await createTestCallSession({
      conversationId: "conv-20",
      provider: "twilio",
      fromNumber: "+15551111111",
      toNumber: "+15552222222",
    });

    await createPendingQuestion(session.id, "Question 1");
    await createPendingQuestion(session.id, "Question 2");

    await expirePendingQuestions(session.id);

    // No more pending questions
    const pending = await getPendingQuestion(session.id);
    expect(pending).toBeNull();

    // Verify both were expired
    const rows = await requireMainDb().all<{ status: string }>(
      "SELECT status FROM call_pending_questions WHERE call_session_id = ?",
      [session.id],
    );
    expect(rows).toHaveLength(2);
    for (const row of rows) {
      expect(row.status).toBe("expired");
    }
  });

  test("expirePendingQuestions does not affect already-answered questions", async () => {
    const session = await createTestCallSession({
      conversationId: "conv-21",
      provider: "twilio",
      fromNumber: "+15551111111",
      toNumber: "+15552222222",
    });

    const q1 = await createPendingQuestion(session.id, "Question 1");
    await createPendingQuestion(session.id, "Question 2");

    // Answer q1 first
    await answerPendingQuestion(q1.id, "Answer 1");

    // Then expire all pending
    await expirePendingQuestions(session.id);

    // q1 should still be answered, not expired
    const q1Row = (await requireMainDb().get<{ status: string }>(
      "SELECT status FROM call_pending_questions WHERE id = ?",
      [q1.id],
    ))!;
    expect(q1Row.status).toBe("answered");
  });

  // ── Callback Claim ──────────────────────────────────────────────

  test("claimCallback returns a claim ID on first call", async () => {
    const session = await createTestCallSession({
      conversationId: "conv-22",
      provider: "twilio",
      fromNumber: "+15551111111",
      toNumber: "+15552222222",
    });

    const result = await claimCallback("test-dedupe-key-1", session.id);
    expect(result).toBeTypeOf("string");
    expect(result!.length).toBeGreaterThan(0);
  });

  test("claimCallback returns null on duplicate key", async () => {
    const session = await createTestCallSession({
      conversationId: "conv-23",
      provider: "twilio",
      fromNumber: "+15551111111",
      toNumber: "+15552222222",
    });

    const first = await claimCallback("test-dedupe-key-2", session.id);
    const second = await claimCallback("test-dedupe-key-2", session.id);

    expect(first).toBeTypeOf("string");
    expect(second).toBeNull();
  });

  test("releaseCallbackClaim allows re-claim", async () => {
    const session = await createTestCallSession({
      conversationId: "conv-24",
      provider: "twilio",
      fromNumber: "+15551111111",
      toNumber: "+15552222222",
    });

    const first = await claimCallback("test-dedupe-key-3", session.id);
    expect(first).toBeTypeOf("string");

    await releaseCallbackClaim("test-dedupe-key-3", first!);

    const second = await claimCallback("test-dedupe-key-3", session.id);
    expect(second).toBeTypeOf("string");
  });

  test("releaseCallbackClaim with wrong claimId does not release", async () => {
    const session = await createTestCallSession({
      conversationId: "conv-24b",
      provider: "twilio",
      fromNumber: "+15551111111",
      toNumber: "+15552222222",
    });

    const claimId = await claimCallback("test-dedupe-key-3b", session.id);
    expect(claimId).toBeTypeOf("string");

    // Attempt to release with a wrong claim ID — should be a no-op
    await releaseCallbackClaim("test-dedupe-key-3b", "wrong-claim-id");

    // The claim should still be held, so re-claiming should fail
    const second = await claimCallback("test-dedupe-key-3b", session.id);
    expect(second).toBeNull();
  });

  test("claimCallback INSERT OR IGNORE pattern is safe for same key", async () => {
    const session = await createTestCallSession({
      conversationId: "conv-25",
      provider: "twilio",
      fromNumber: "+15551111111",
      toNumber: "+15552222222",
    });

    // Claim the key
    const first = await claimCallback("test-dedupe-key-4", session.id);
    expect(first).toBeTypeOf("string");

    // Subsequent claims with the same key should all return null without throwing
    expect(await claimCallback("test-dedupe-key-4", session.id)).toBeNull();
    expect(await claimCallback("test-dedupe-key-4", session.id)).toBeNull();

    // Only one row should exist in the table for this key
    const rows = (await requireMainDb().get<{ cnt: number }>(
      "SELECT COUNT(*)::int as cnt FROM processed_callbacks WHERE dedupe_key = ?",
      ["test-dedupe-key-4"],
    ))!;
    expect(rows.cnt).toBe(1);
  });

  test("claimCallback reclaims expired orphaned claims", async () => {
    const session = await createTestCallSession({
      conversationId: "conv-26",
      provider: "twilio",
      fromNumber: "+15551111111",
      toNumber: "+15552222222",
    });

    // Claim the key
    const first = await claimCallback("test-dedupe-key-expired", session.id);
    expect(first).toBeTypeOf("string");

    // Simulate an orphaned claim by backdating the created_at to well past expiry
    const oldTimestamp = Date.now() - 120_000; // 2 minutes ago, well past 60s expiry
    await requireMainDb().run(
      "UPDATE processed_callbacks SET created_at = ? WHERE dedupe_key = ?",
      [oldTimestamp, "test-dedupe-key-expired"],
    );

    // Reclaim should succeed because the old claim has expired
    const second = await claimCallback("test-dedupe-key-expired", session.id);
    expect(second).toBeTypeOf("string");

    // The new claim should have a different claim ID
    expect(second).not.toBe(first);
  });

  test("claimCallback does not reclaim finalized claims", async () => {
    const session = await createTestCallSession({
      conversationId: "conv-27",
      provider: "twilio",
      fromNumber: "+15551111111",
      toNumber: "+15552222222",
    });

    // Claim and finalize
    const first = await claimCallback("test-dedupe-key-finalized", session.id);
    expect(first).toBeTypeOf("string");
    await finalizeCallbackClaim("test-dedupe-key-finalized", first!);

    // Attempting to reclaim a finalized key should fail because the far-future
    // timestamp means it will never be considered expired
    const second = await claimCallback("test-dedupe-key-finalized", session.id);
    expect(second).toBeNull();
  });

  test("finalizeCallbackClaim makes claim permanent", async () => {
    const session = await createTestCallSession({
      conversationId: "conv-28",
      provider: "twilio",
      fromNumber: "+15551111111",
      toNumber: "+15552222222",
    });

    // Claim and finalize
    const claimId = await claimCallback(
      "test-dedupe-key-permanent",
      session.id,
    )!;
    await finalizeCallbackClaim("test-dedupe-key-permanent", claimId);

    // Verify the created_at is set far in the future
    const row = (await requireMainDb().get<{ created_at: number }>(
      "SELECT created_at FROM processed_callbacks WHERE dedupe_key = ?",
      ["test-dedupe-key-permanent"],
    ))!;
    // Should be at least 50 years in the future from now
    const fiftyYearsMs = 50 * 365 * 24 * 60 * 60 * 1000;
    expect(row.created_at).toBeGreaterThan(Date.now() + fiftyYearsMs);
  });

  test("finalizeCallbackClaim with wrong claimId does not finalize", async () => {
    const session = await createTestCallSession({
      conversationId: "conv-28b",
      provider: "twilio",
      fromNumber: "+15551111111",
      toNumber: "+15552222222",
    });

    // Claim the key
    const claimId = await claimCallback(
      "test-dedupe-key-permanent-b",
      session.id,
    )!;
    expect(claimId).toBeTypeOf("string");

    // Try to finalize with wrong claimId — should be a no-op
    await finalizeCallbackClaim(
      "test-dedupe-key-permanent-b",
      "wrong-claim-id",
    );

    // Verify the created_at was NOT set to far-future (it should still be close to now)
    const row = (await requireMainDb().get<{ created_at: number }>(
      "SELECT created_at FROM processed_callbacks WHERE dedupe_key = ?",
      ["test-dedupe-key-permanent-b"],
    ))!;
    const oneMinuteMs = 60 * 1000;
    expect(row.created_at).toBeLessThan(Date.now() + oneMinuteMs);
  });

  test("handler A cannot release handler B claim after reclaim", async () => {
    const session = await createTestCallSession({
      conversationId: "conv-29",
      provider: "twilio",
      fromNumber: "+15551111111",
      toNumber: "+15552222222",
    });

    // Handler A claims
    const claimA = await claimCallback(
      "test-dedupe-key-ownership",
      session.id,
    )!;
    expect(claimA).toBeTypeOf("string");

    // Simulate handler A taking too long: backdate the claim so it expires
    const db = requireMainDb();
    const oldTimestamp = Date.now() - 120_000;
    await db.run(
      "UPDATE processed_callbacks SET created_at = ? WHERE dedupe_key = ?",
      [oldTimestamp, "test-dedupe-key-ownership"],
    );

    // Handler B reclaims (succeeds because the old claim expired)
    const claimB = await claimCallback(
      "test-dedupe-key-ownership",
      session.id,
    )!;
    expect(claimB).toBeTypeOf("string");
    expect(claimB).not.toBe(claimA);

    // Handler B finalizes
    await finalizeCallbackClaim("test-dedupe-key-ownership", claimB);

    // Handler A tries to release using its old claimId — should be a no-op
    await releaseCallbackClaim("test-dedupe-key-ownership", claimA);

    // Verify B's finalized claim is still intact
    const row = (await db.get<{
      created_at: number;
      claim_id: string;
    }>(
      "SELECT created_at, claim_id FROM processed_callbacks WHERE dedupe_key = ?",
      ["test-dedupe-key-ownership"],
    ))!;
    expect(row).not.toBeNull();
    expect(row.claim_id).toBe(claimB);
    const fiftyYearsMs = 50 * 365 * 24 * 60 * 60 * 1000;
    expect(row.created_at).toBeGreaterThan(Date.now() + fiftyYearsMs);
  });
});
