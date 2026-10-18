/**
 * Phone-call funnel rows: which ones the call store records and what they say.
 *
 * The recorder is mocked, as in `live-voice-session-telemetry.test.ts`: the
 * outbox and its consent gate are covered by `telemetry-events-outbox.test.ts`.
 * What these tests pin is the wiring that decides whether a row exists at all,
 * which is where the measurement silently goes wrong: a call that never
 * connects still has to count, a terminal status has to emit exactly one end
 * row however many writes follow it, and a call nobody spoke on has to say so.
 */

import { beforeEach, expect, mock, test } from "bun:test";

const recordPhoneCallStarted = mock(async () => null);
const recordPhoneCallEnded = mock(async () => null);

// Spread the real module rather than replacing it: the call store pulls other
// recorders out of it, and a bare replacement makes those imports fail.
const onboardingEventsStore =
  await import("../../onboarding/onboarding-events-store.js");
mock.module("../../onboarding/onboarding-events-store.js", () => ({
  ...onboardingEventsStore,
  recordPhoneCallStarted,
  recordPhoneCallEnded,
}));

import { describePg } from "../../__tests__/pg-test-db.js";
import { requireMainDb } from "../../persistence/db-facade.js";

// Values load after `mock.module` so the store picks up the mocked recorder.
const { createCallSession, recordCallEvent, updateCallSession } =
  await import("../call-store.js");

let conversationSeq = 0;

async function makeConversation(): Promise<string> {
  const id = `conv-funnel-${++conversationSeq}`;
  const now = Date.now();
  const db = requireMainDb();
  await db.orm.insert(db.schema.conversations).values({
    id,
    title: `Test conversation ${id}`,
    createdAt: now,
    updatedAt: now,
  });
  return id;
}

async function startCall(opts?: {
  direction?: "inbound" | "outbound";
  callMode?: string;
}): Promise<string> {
  const session = await createCallSession({
    conversationId: await makeConversation(),
    provider: "twilio",
    direction: opts?.direction ?? "inbound",
    fromNumber: "+15550100",
    toNumber: "+15550101",
    ...(opts?.callMode !== undefined ? { callMode: opts.callMode } : {}),
  });
  return session.id;
}

beforeEach(async () => {
  recordPhoneCallStarted.mockClear();
  recordPhoneCallEnded.mockClear();
});

describePg("call funnel start rows", () => {
  test("an inbound call counts the moment its session row exists", async () => {
    // Before the provider has dialled and before any preflight can reject it:
    // a call that never connects is the one the funnel most needs to count.
    const callSessionId = await startCall({ callMode: "normal" });

    expect(recordPhoneCallStarted).toHaveBeenCalledTimes(1);
    expect(recordPhoneCallStarted).toHaveBeenCalledWith({
      callSessionId,
      screen: "started_inbound:normal",
    });
  });

  test("an outbound call is stamped by the direction it states", async () => {
    // Stated, not inferred: a verification or invite call dials out and
    // carries no task, so task presence would misread as inbound.
    await startCall({ direction: "outbound", callMode: "verification" });

    expect(recordPhoneCallStarted).toHaveBeenCalledWith(
      expect.objectContaining({ screen: "started_outbound:verification" }),
    );
  });

  test("an ordinary call stamps the normal mode it never writes", async () => {
    // createInboundVoiceSession and startCall leave callMode null; only the
    // verification and invite flows set one.
    await startCall();

    expect(recordPhoneCallStarted).toHaveBeenCalledWith(
      expect.objectContaining({ screen: "started_inbound:normal" }),
    );
  });
});

describePg("call funnel end rows", () => {
  test("a completed call that took a turn reports no silence", async () => {
    const callSessionId = await startCall({ callMode: "normal" });
    await updateCallSession(callSessionId, { status: "in_progress" });
    await recordCallEvent(callSessionId, "call_connected");
    await recordCallEvent(callSessionId, "caller_spoke", {
      transcript: "hello",
      transport: "media-stream",
    });

    await updateCallSession(callSessionId, { status: "completed" });

    expect(recordPhoneCallEnded).toHaveBeenCalledTimes(1);
    expect(recordPhoneCallEnded).toHaveBeenCalledWith({
      callSessionId,
      screen: "ended_completed",
      outcome: "completed",
    });
  });

  test("a call that never connected is silent for that reason", async () => {
    const callSessionId = await startCall({ callMode: "normal" });

    await updateCallSession(callSessionId, { status: "failed" });

    expect(recordPhoneCallEnded).toHaveBeenCalledWith({
      callSessionId,
      screen: "ended_failed:silent_no_connect",
      outcome: "failed",
    });
  });

  test("a connected call nobody spoke on is silent on the line", async () => {
    // The distinction the rate lives on: the telephony leg worked and the
    // conversation still never started.
    const callSessionId = await startCall({ callMode: "normal" });
    await updateCallSession(callSessionId, { status: "in_progress" });
    await recordCallEvent(callSessionId, "call_connected");

    await updateCallSession(callSessionId, { status: "completed" });

    expect(recordPhoneCallEnded).toHaveBeenCalledWith(
      expect.objectContaining({ screen: "ended_completed:silent_no_turn" }),
    );
  });

  test("a call where only digits were pressed took no turn", async () => {
    // DTMF digits ride `caller_spoke` too; only a transcript is a turn.
    const callSessionId = await startCall({ callMode: "normal" });
    await updateCallSession(callSessionId, { status: "in_progress" });
    await recordCallEvent(callSessionId, "call_connected");
    await recordCallEvent(callSessionId, "caller_spoke", {
      dtmfDigit: "4",
      transport: "media-stream",
    });

    await updateCallSession(callSessionId, { status: "completed" });

    expect(recordPhoneCallEnded).toHaveBeenCalledWith(
      expect.objectContaining({ screen: "ended_completed:silent_no_turn" }),
    );
  });

  test("a cancelled call completed its course", async () => {
    // Only an error is a failure; a call cancelled before it connected ran
    // exactly as far as it was asked to.
    const callSessionId = await startCall({ callMode: "normal" });

    await updateCallSession(callSessionId, { status: "cancelled" });

    expect(recordPhoneCallEnded).toHaveBeenCalledWith(
      expect.objectContaining({ outcome: "completed" }),
    );
  });

  test("only the first terminal write records an end", async () => {
    // Terminal states are immutable, so the rejected second write must not
    // produce a second row to pair with the one start.
    const callSessionId = await startCall({ callMode: "normal" });
    await updateCallSession(callSessionId, { status: "completed" });

    await updateCallSession(callSessionId, { status: "failed" });

    expect(recordPhoneCallEnded).toHaveBeenCalledTimes(1);
    expect(recordPhoneCallEnded).toHaveBeenCalledWith(
      expect.objectContaining({ screen: "ended_completed:silent_no_connect" }),
    );
  });

  test("a non-status update records nothing", async () => {
    const callSessionId = await startCall({ callMode: "normal" });

    await updateCallSession(callSessionId, { providerCallSid: "CA-test" });

    expect(recordPhoneCallEnded).not.toHaveBeenCalled();
  });
});
