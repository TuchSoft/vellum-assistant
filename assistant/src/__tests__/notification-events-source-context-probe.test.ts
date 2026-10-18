/**
 * Tests for `hasNotifiedSourceContextSince`, the probe the schedule-result
 * producer uses to ask "did this run already notify?".
 *
 * Two things are worth pinning down. The `since` bound: a recurring schedule
 * with `reuseConversation` runs every firing in the same conversation, so an
 * unbounded probe would find run #1's notification forever and silence every
 * run after it. And the outcome test: `emitNotificationSignal` persists the
 * event before the pipeline can fail, so an event row alone proves an attempt,
 * not a notification — counting it would suppress the fallback in exactly the
 * case it exists for.
 */

import { beforeEach, describe, expect, test } from "bun:test";

import { eq } from "drizzle-orm";

import { createDecision } from "../notifications/decisions-store.js";
import { createDelivery } from "../notifications/deliveries-store.js";
import {
  createEvent,
  hasNotifiedSourceContextSince,
} from "../notifications/events-store.js";
import type { NotificationDeliveryStatus } from "../notifications/types.js";
import { requireMainDb } from "../persistence/db-facade.js";
import { describePg } from "./pg-test-db.js";

const CONVERSATION_ID = "conv-schedule-run";

beforeEach(async () => {
  const db = requireMainDb();
  await db.run("DELETE FROM notification_deliveries");
  await db.run("DELETE FROM notification_decisions");
  await db.run("DELETE FROM notification_events");
});

/**
 * How far the seeded signal got through the pipeline.
 *
 * - `no-verdict`: the event row exists and nothing else — the pipeline threw
 *   before the decision stage.
 * - `declined`: the engine decided not to notify.
 * - a delivery status: the engine said notify and dispatch recorded a delivery
 *   in that state.
 */
type SeedOutcome = "no-verdict" | "declined" | NotificationDeliveryStatus;

/**
 * Seed a signal and backdate its event: `createEvent` stamps `Date.now()`, but
 * the `since` cases turn entirely on where a row sits relative to a run's start.
 */
async function seedSignalAt(
  sourceContextId: string,
  createdAt: number,
  outcome: SeedOutcome = "sent",
  sourceEventName = "assistant.share",
): Promise<void> {
  const eventId = crypto.randomUUID();
  await createEvent({
    id: eventId,
    sourceEventName,
    sourceChannel: "assistant_tool",
    sourceContextId,
    attentionHints: {
      requiresAction: false,
      urgency: "low",
      isAsyncBackground: true,
      visibleInSourceNow: false,
    },
    payload: { requestedMessage: "sent by the run itself" },
  });
  {
    const db = requireMainDb();
    await db.orm
      .update(db.schema.notificationEvents)
      .set({ createdAt })
      .where(eq(db.schema.notificationEvents.id, eventId));
  }

  if (outcome === "no-verdict") {
    return;
  }
  const decision = await createDecision({
    id: crypto.randomUUID(),
    notificationEventId: eventId,
    shouldNotify: outcome !== "declined",
    selectedChannels: outcome === "declined" ? [] : ["vellum"],
    reasoningSummary: "test",
    confidence: 1,
    fallbackUsed: false,
  });
  if (outcome === "declined") {
    return;
  }
  await createDelivery({
    id: crypto.randomUUID(),
    notificationDecisionId: decision.id,
    channel: "vellum",
    destination: "vellum",
    status: outcome,
    attempt: 1,
  });
}

describePg("hasNotifiedSourceContextSince", () => {
  const runStartedAt = 1_700_000_000_000;

  test("result-only probes ignore approval cards while the scheduler keeps its broad contract", async () => {
    await seedSignalAt(
      CONVERSATION_ID,
      runStartedAt + 100,
      "sent",
      "guardian.question",
    );
    const resultEvents = ["assistant.share", "activity.complete"];
    expect(
      await hasNotifiedSourceContextSince(CONVERSATION_ID, runStartedAt),
    ).toBe(true);
    expect(
      await hasNotifiedSourceContextSince(
        CONVERSATION_ID,
        runStartedAt,
        resultEvents,
      ),
    ).toBe(false);
    await seedSignalAt(
      CONVERSATION_ID,
      runStartedAt + 200,
      "failed",
      "activity.complete",
    );
    expect(
      await hasNotifiedSourceContextSince(
        CONVERSATION_ID,
        runStartedAt,
        resultEvents,
      ),
    ).toBe(false);
    await seedSignalAt(
      CONVERSATION_ID,
      runStartedAt + 300,
      "declined",
      "assistant.share",
    );
    expect(
      await hasNotifiedSourceContextSince(
        CONVERSATION_ID,
        runStartedAt,
        resultEvents,
      ),
    ).toBe(true);
  });

  describe("the since bound", () => {
    test("finds a notification sent during the run", async () => {
      await seedSignalAt(CONVERSATION_ID, runStartedAt + 500);

      expect(
        await hasNotifiedSourceContextSince(CONVERSATION_ID, runStartedAt),
      ).toBe(true);
    });

    test("ignores a notification from a prior run in the same conversation", async () => {
      // The reused-conversation case: yesterday's firing notified, today's did
      // not. Today's run still owes the user a notification.
      const todaysRunStartedAt = runStartedAt + 86_400_000;
      await seedSignalAt(CONVERSATION_ID, runStartedAt + 500);

      expect(
        await hasNotifiedSourceContextSince(
          CONVERSATION_ID,
          todaysRunStartedAt,
        ),
      ).toBe(false);
    });

    test("counts a notification landing exactly at the run's start", async () => {
      // The bound is inclusive: a notification stamped in the same millisecond
      // the run began belongs to that run.
      await seedSignalAt(CONVERSATION_ID, runStartedAt);

      expect(
        await hasNotifiedSourceContextSince(CONVERSATION_ID, runStartedAt),
      ).toBe(true);
    });

    test("ignores a notification from a different conversation", async () => {
      await seedSignalAt("some-other-conversation", runStartedAt + 500);

      expect(
        await hasNotifiedSourceContextSince(CONVERSATION_ID, runStartedAt),
      ).toBe(false);
    });

    test("returns false when nothing was ever emitted", async () => {
      expect(
        await hasNotifiedSourceContextSince(CONVERSATION_ID, runStartedAt),
      ).toBe(false);
    });
  });

  describe("the outcome test", () => {
    test("ignores an event whose pipeline never reached a verdict", async () => {
      // The audit row of an emit that threw before the decision stage. Nobody
      // was told, so the run still owes its notification.
      await seedSignalAt(CONVERSATION_ID, runStartedAt + 500, "no-verdict");

      expect(
        await hasNotifiedSourceContextSince(CONVERSATION_ID, runStartedAt),
      ).toBe(false);
    });

    test("ignores an event whose only delivery failed", async () => {
      await seedSignalAt(CONVERSATION_ID, runStartedAt + 500, "failed");

      expect(
        await hasNotifiedSourceContextSince(CONVERSATION_ID, runStartedAt),
      ).toBe(false);
    });

    test("ignores an event whose only delivery was skipped", async () => {
      await seedSignalAt(CONVERSATION_ID, runStartedAt + 500, "skipped");

      expect(
        await hasNotifiedSourceContextSince(CONVERSATION_ID, runStartedAt),
      ).toBe(false);
    });

    test("counts a delivery still pending", async () => {
      // Something is on its way; the fallback must not race it.
      await seedSignalAt(CONVERSATION_ID, runStartedAt + 500, "pending");

      expect(
        await hasNotifiedSourceContextSince(CONVERSATION_ID, runStartedAt),
      ).toBe(true);
    });

    test("counts a decision not to notify", async () => {
      // The engine ruled on the run's own signal. The fallback covers runs that
      // never asked; it does not appeal verdicts the user's settings produced.
      await seedSignalAt(CONVERSATION_ID, runStartedAt + 500, "declined");

      expect(
        await hasNotifiedSourceContextSince(CONVERSATION_ID, runStartedAt),
      ).toBe(true);
    });

    test("one delivered signal among failed ones is enough", async () => {
      await seedSignalAt(CONVERSATION_ID, runStartedAt + 100, "failed");
      await seedSignalAt(CONVERSATION_ID, runStartedAt + 200, "sent");

      expect(
        await hasNotifiedSourceContextSince(CONVERSATION_ID, runStartedAt),
      ).toBe(true);
    });
  });
});
