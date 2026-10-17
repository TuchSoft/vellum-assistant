import { and, desc, eq, like, notInArray, or } from "drizzle-orm";
import { v4 as uuid } from "uuid";

import {
  recordPhoneCallEnded,
  recordPhoneCallStarted,
} from "../onboarding/onboarding-events-store.js";
import type { SchemaTables } from "../persistence/db-facade.js";
import { requireMainDb } from "../persistence/db-facade.js";
import { fireAndForgetTelemetry } from "../telemetry/fire-and-forget.js";
import {
  type PhoneCallDirection,
  phoneCallEndScreen,
  phoneCallSilenceReason,
  phoneCallStartScreen,
} from "../telemetry/phone-call-funnel.js";
import { getLogger } from "../util/logger.js";
import { cast, createRowMapper } from "../util/row-mapper.js";
import { syncActiveCallLeaseFromSession } from "./active-call-lease.js";
import { isTerminalState, validateTransition } from "./call-state-machine.js";
import type {
  CallEvent,
  CallEventType,
  CallPendingQuestion,
  CallSession,
  CallStatus,
} from "./types.js";

const log = getLogger("call-store");

// ── Helpers ──────────────────────────────────────────────────────────

const parseCallSession = createRowMapper<
  SchemaTables["callSessions"]["$inferSelect"],
  CallSession
>({
  id: "id",
  conversationId: "conversationId",
  provider: "provider",
  providerCallSid: "providerCallSid",
  fromNumber: "fromNumber",
  toNumber: "toNumber",
  task: "task",
  status: { from: "status", transform: cast<CallSession["status"]>() },
  callMode: { from: "callMode", transform: cast<CallSession["callMode"]>() },
  verificationSessionId: "verificationSessionId",
  inviteFriendName: "inviteFriendName",
  inviteGuardianName: "inviteGuardianName",
  callerIdentityMode: "callerIdentityMode",
  callerIdentitySource: "callerIdentitySource",
  skipDisclosure: {
    from: "skipDisclosure",
    transform: (v: unknown) => v === 1,
  },
  initiatedFromConversationId: "initiatedFromConversationId",
  startedAt: "startedAt",
  endedAt: "endedAt",
  lastError: "lastError",
  createdAt: "createdAt",
  updatedAt: "updatedAt",
});

const parseCallEvent = createRowMapper<
  SchemaTables["callEvents"]["$inferSelect"],
  CallEvent
>({
  id: "id",
  callSessionId: "callSessionId",
  eventType: { from: "eventType", transform: cast<CallEvent["eventType"]>() },
  payloadJson: "payloadJson",
  createdAt: "createdAt",
});

const parsePendingQuestion = createRowMapper<
  SchemaTables["callPendingQuestions"]["$inferSelect"],
  CallPendingQuestion
>({
  id: "id",
  callSessionId: "callSessionId",
  questionText: "questionText",
  status: { from: "status", transform: cast<CallPendingQuestion["status"]>() },
  askedAt: "askedAt",
  answeredAt: "answeredAt",
  answerText: "answerText",
});

// ── Call Sessions ────────────────────────────────────────────────────

export async function createCallSession(opts: {
  conversationId: string;
  provider: string;
  fromNumber: string;
  toNumber: string;
  /**
   * Which way the call is being placed, for the funnel stamp. Stated rather
   * than derived: a verification or invite call carries no task and is still
   * outbound, so task presence is not a direction.
   */
  direction: PhoneCallDirection;
  task?: string;
  callMode?: string;
  verificationSessionId?: string;
  inviteFriendName?: string;
  inviteGuardianName?: string;
  callerIdentityMode?: string;
  callerIdentitySource?: string;
  skipDisclosure?: boolean;
  initiatedFromConversationId?: string;
}): Promise<CallSession> {
  const db = requireMainDb();
  const now = Date.now();
  const skipDisclosure = opts.skipDisclosure ?? false;
  const row = {
    id: uuid(),
    conversationId: opts.conversationId,
    provider: opts.provider,
    providerCallSid: null,
    fromNumber: opts.fromNumber,
    toNumber: opts.toNumber,
    task: opts.task ?? null,
    status: "initiated" as const,
    callMode: (opts.callMode ?? null) as CallSession["callMode"],
    verificationSessionId: opts.verificationSessionId ?? null,
    inviteFriendName: opts.inviteFriendName ?? null,
    inviteGuardianName: opts.inviteGuardianName ?? null,
    callerIdentityMode: opts.callerIdentityMode ?? null,
    callerIdentitySource: opts.callerIdentitySource ?? null,
    skipDisclosure: skipDisclosure ? 1 : 0,
    initiatedFromConversationId: opts.initiatedFromConversationId ?? null,
    startedAt: null,
    endedAt: null,
    lastError: null,
    createdAt: now,
    updatedAt: now,
  };
  await db.orm.insert(db.schema.callSessions).values(row);
  // The call is attempted the moment its row exists, which is before the
  // provider dials: a call that never connects is exactly the one the funnel
  // needs to count. An outbound attempt the ingress preflight rejects never
  // reaches here; see `telemetry/phone-call-funnel.ts`.
  fireAndForgetTelemetry(
    recordPhoneCallStarted({
      callSessionId: row.id,
      screen: phoneCallStartScreen(opts.direction, row.callMode),
    }),
    "call-store:phone-call-started",
  );
  return { ...row, skipDisclosure };
}

export async function getCallSession(id: string): Promise<CallSession | null> {
  const db = requireMainDb();
  const callSessions = db.schema.callSessions;
  const rows = await db.orm
    .select()
    .from(callSessions)
    .where(eq(callSessions.id, id))
    .limit(1);
  const row = rows[0];
  if (!row) {
    return null;
  }
  return parseCallSession(row);
}

export async function getCallSessionByCallSid(
  callSid: string,
): Promise<CallSession | null> {
  const db = requireMainDb();
  const callSessions = db.schema.callSessions;
  const rows = await db.orm
    .select()
    .from(callSessions)
    .where(eq(callSessions.providerCallSid, callSid))
    .limit(1);
  const row = rows[0];
  if (!row) {
    return null;
  }
  return parseCallSession(row);
}

export async function getActiveCallSessionForConversation(
  conversationId: string,
): Promise<CallSession | null> {
  const db = requireMainDb();
  const callSessions = db.schema.callSessions;
  const rows = await db.orm
    .select()
    .from(callSessions)
    .where(
      and(
        or(
          eq(callSessions.conversationId, conversationId),
          eq(callSessions.initiatedFromConversationId, conversationId),
        ),
        notInArray(callSessions.status, ["completed", "failed", "cancelled"]),
      ),
    )
    .orderBy(desc(callSessions.createdAt))
    .limit(1);
  const row = rows[0];
  if (!row) {
    return null;
  }
  return parseCallSession(row);
}

export async function updateCallSession(
  id: string,
  updates: Partial<
    Pick<
      CallSession,
      | "status"
      | "providerCallSid"
      | "startedAt"
      | "endedAt"
      | "lastError"
      | "conversationId"
      | "initiatedFromConversationId"
    >
  >,
  opts?: { beforeLeaseSync?: () => void },
): Promise<void> {
  const db = requireMainDb();
  const callSessions = db.schema.callSessions;
  const shouldSyncActiveLease =
    Object.prototype.hasOwnProperty.call(updates, "providerCallSid") ||
    Object.prototype.hasOwnProperty.call(updates, "status");

  // Validate status transition when a new status is provided
  if (updates.status) {
    const current = await getCallSession(id);
    if (current) {
      const result = validateTransition(
        current.status,
        updates.status as CallStatus,
      );
      if (!result.valid) {
        log.warn(
          {
            callSessionId: id,
            from: current.status,
            to: updates.status,
            reason: result.reason,
          },
          "Invalid call status transition — skipping update",
        );
        return;
      }
    }
  }

  await db.orm
    .update(callSessions)
    .set({ ...updates, updatedAt: Date.now() })
    .where(eq(callSessions.id, id));

  // Terminal states are immutable and the validator above rejects any write
  // that follows one, so the first terminal transition to get here is the only
  // one: the ended event needs no separate once-only latch.
  if (updates.status && isTerminalState(updates.status)) {
    await recordCallEndedEvent(id, updates.status);
  }

  opts?.beforeLeaseSync?.();

  if (shouldSyncActiveLease) {
    try {
      syncActiveCallLeaseFromSession(await getCallSession(id));
    } catch (err) {
      log.warn(
        { callSessionId: id, err },
        "Failed to sync active call lease from session update",
      );
    }
  }
}

// ── Recovery queries ─────────────────────────────────────────────────

/**
 * Whether the call's own event log holds an event of this type. Existence
 * only: the row itself is never read.
 */
async function hasCallEvent(
  id: string,
  eventType: CallEventType,
  payloadContains?: string,
): Promise<boolean> {
  const db = requireMainDb();
  const callEvents = db.schema.callEvents;
  const rows = await db.orm
    .select({ id: callEvents.id })
    .from(callEvents)
    .where(
      and(
        eq(callEvents.callSessionId, id),
        eq(callEvents.eventType, eventType),
        ...(payloadContains
          ? [like(callEvents.payloadJson, `%${payloadContains}%`)]
          : []),
      ),
    )
    .limit(1);
  return rows.length > 0;
}

/**
 * Emit the call's funnel end event, classifying a call that never took a
 * caller turn by how far it got. Both signals come from the call's own event
 * log: `call_connected` is written when the media stream opens, and
 * `caller_spoke` when the caller is heard.
 *
 * `caller_spoke` carries two senses, though: a transcribed utterance
 * (`transcript`) and a single DTMF digit (`dtmfDigit`). Only the first is a
 * conversational turn, so the payload discriminates them. Splitting DTMF into
 * an event type of its own would be the real fix, but that vocabulary is read
 * by other consumers and is not this change's to alter.
 */
async function recordCallEndedEvent(
  id: string,
  status: CallStatus,
): Promise<void> {
  const spoke = await hasCallEvent(id, "caller_spoke", '"transcript"');
  const silence = spoke
    ? null
    : phoneCallSilenceReason({
        connected: await hasCallEvent(id, "call_connected"),
      });

  fireAndForgetTelemetry(
    recordPhoneCallEnded({
      callSessionId: id,
      screen: phoneCallEndScreen(status, silence),
      outcome: status === "failed" ? "failed" : "completed",
    }),
    "call-store:phone-call-ended",
  );
}

/**
 * Returns all call sessions that are in a non-terminal state
 * (i.e. not completed, failed, or cancelled). Used during daemon startup
 * to reconcile in-flight calls.
 */
export async function listRecoverableCalls(): Promise<CallSession[]> {
  const db = requireMainDb();
  const callSessions = db.schema.callSessions;
  const rows = await db.orm
    .select()
    .from(callSessions)
    .where(
      notInArray(callSessions.status, ["completed", "failed", "cancelled"]),
    );
  return rows.map(parseCallSession);
}

// ── Call Events ──────────────────────────────────────────────────────

export async function recordCallEvent(
  callSessionId: string,
  eventType: CallEventType,
  payload?: Record<string, unknown>,
): Promise<CallEvent> {
  const db = requireMainDb();
  const now = Date.now();
  const event = {
    id: uuid(),
    callSessionId,
    eventType,
    payloadJson: JSON.stringify(payload ?? {}),
    createdAt: now,
  };
  await db.orm.insert(db.schema.callEvents).values(event);
  return event;
}

export async function getCallEvents(
  callSessionId: string,
): Promise<CallEvent[]> {
  const db = requireMainDb();
  const callEvents = db.schema.callEvents;
  const rows = await db.orm
    .select()
    .from(callEvents)
    .where(eq(callEvents.callSessionId, callSessionId))
    .orderBy(callEvents.createdAt);
  return rows.map(parseCallEvent);
}

// ── Pending Questions ────────────────────────────────────────────────

export async function createPendingQuestion(
  callSessionId: string,
  questionText: string,
): Promise<CallPendingQuestion> {
  const db = requireMainDb();
  const now = Date.now();
  const question = {
    id: uuid(),
    callSessionId,
    questionText,
    status: "pending" as const,
    askedAt: now,
    answeredAt: null,
    answerText: null,
  };
  await db.orm.insert(db.schema.callPendingQuestions).values(question);
  return question;
}

export async function getPendingQuestion(
  callSessionId: string,
): Promise<CallPendingQuestion | null> {
  const db = requireMainDb();
  const callPendingQuestions = db.schema.callPendingQuestions;
  const rows = await db.orm
    .select()
    .from(callPendingQuestions)
    .where(
      and(
        eq(callPendingQuestions.callSessionId, callSessionId),
        eq(callPendingQuestions.status, "pending"),
      ),
    )
    .orderBy(desc(callPendingQuestions.askedAt))
    .limit(1);
  const row = rows[0];
  if (!row) {
    return null;
  }
  return parsePendingQuestion(row);
}

export async function answerPendingQuestion(
  id: string,
  answerText: string,
): Promise<void> {
  const db = requireMainDb();
  const callPendingQuestions = db.schema.callPendingQuestions;
  const updated = await db.orm
    .update(callPendingQuestions)
    .set({
      status: "answered",
      answerText,
      answeredAt: Date.now(),
    })
    .where(
      and(
        eq(callPendingQuestions.id, id),
        eq(callPendingQuestions.status, "pending"),
      ),
    )
    .returning({ id: callPendingQuestions.id });
  if (updated.length === 0) {
    log.warn(
      { questionId: id },
      "answerPendingQuestion: no rows updated — question may have already been answered or expired",
    );
  }
}

export async function expirePendingQuestions(
  callSessionId: string,
): Promise<void> {
  const db = requireMainDb();
  const callPendingQuestions = db.schema.callPendingQuestions;
  await db.orm
    .update(callPendingQuestions)
    .set({ status: "expired" })
    .where(
      and(
        eq(callPendingQuestions.callSessionId, callSessionId),
        eq(callPendingQuestions.status, "pending"),
      ),
    );
}

// ── Callback Idempotency ─────────────────────────────────────────────

/** Claims older than this are considered orphaned (crashed mid-processing) and can be reclaimed. */
const CLAIM_EXPIRY_MS = 60_000; // 60 seconds

/**
 * Build a dedupe key for a Twilio status callback.
 * Combines CallSid + CallStatus + Timestamp (or SequenceNumber if present)
 * to uniquely identify each callback.
 */
export function buildCallbackDedupeKey(
  callSid: string,
  callStatus: string,
  timestamp?: string | null,
  sequenceNumber?: string | null,
): string {
  const discriminator = sequenceNumber ?? timestamp ?? "";
  return `${callSid}:${callStatus}:${discriminator}`;
}

/**
 * Atomically claim a callback for processing. Returns a unique claim ID
 * (string) if this caller won the claim, or null if another caller already
 * claimed it (dedupe_key conflict).
 *
 * Expired orphaned claims (older than CLAIM_EXPIRY_MS) are automatically
 * cleared before attempting the insert, so crashes mid-processing don't
 * permanently block retries.
 *
 * If processing fails, call `releaseCallbackClaim(dedupeKey, claimId)` to allow retries.
 * On success, call `finalizeCallbackClaim(dedupeKey, claimId)` to make the claim permanent.
 *
 * The returned claim ID acts as an ownership token: release and finalize
 * operations require it so that handler A cannot accidentally release or
 * finalize a claim that was reclaimed by handler B after expiry.
 */
export async function claimCallback(
  dedupeKey: string,
  callSessionId: string,
): Promise<string | null> {
  const db = requireMainDb();
  // Clear any expired orphaned claims so they can be reprocessed
  await db.run(
    `DELETE FROM processed_callbacks WHERE dedupe_key = ? AND created_at < ?`,
    [dedupeKey, Date.now() - CLAIM_EXPIRY_MS],
  );

  const claimId = uuid();
  const changes = await db.run(
    `INSERT INTO processed_callbacks (id, dedupe_key, call_session_id, claim_id, created_at) VALUES (?, ?, ?, ?, ?) ON CONFLICT DO NOTHING`,
    [uuid(), dedupeKey, callSessionId, claimId, Date.now()],
  );
  return changes > 0 ? claimId : null;
}

/**
 * Release a callback claim so that retries can reprocess it.
 * Called when processing fails after a successful claim.
 *
 * Only deletes the row if both dedupe_key AND claim_id match, preventing
 * handler A from releasing a claim that was reclaimed by handler B.
 */
export async function releaseCallbackClaim(
  dedupeKey: string,
  claimId: string,
): Promise<void> {
  const db = requireMainDb();
  await db.run(
    `DELETE FROM processed_callbacks WHERE dedupe_key = ? AND claim_id = ?`,
    [dedupeKey, claimId],
  );
}

/**
 * Finalize a callback claim after successful processing.
 * Sets the created_at to a far-future value so the claim never expires,
 * distinguishing it from in-flight claims that may need to be reclaimed.
 *
 * Only updates the row if both dedupe_key AND claim_id match, preventing
 * handler A from finalizing a claim that was reclaimed by handler B.
 *
 * Returns true if the claim was successfully finalized, or false if 0 rows
 * were updated — meaning the claim was reclaimed by another handler after
 * expiry. Callers should treat a false return as a lost-claim signal: the
 * business writes already happened but the dedupe row belongs to someone
 * else, so duplicate processing may occur on later retries.
 */
export async function finalizeCallbackClaim(
  dedupeKey: string,
  claimId: string,
): Promise<boolean> {
  const db = requireMainDb();
  // Set created_at far in the future so expiry check never matches
  const NEVER_EXPIRE = Date.now() + 100 * 365 * 24 * 60 * 60 * 1000; // ~100 years
  const changes = await db.run(
    `UPDATE processed_callbacks SET created_at = ? WHERE dedupe_key = ? AND claim_id = ?`,
    [NEVER_EXPIRE, dedupeKey, claimId],
  );
  if (changes === 0) {
    log.warn(
      { dedupeKey, claimId },
      "finalizeCallbackClaim: claim was lost — another handler reclaimed this key after expiry",
    );
    return false;
  }
  return true;
}
