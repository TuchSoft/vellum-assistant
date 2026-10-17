/**
 * Processing status tracking and dead-letter queue management for
 * channel inbound events.
 *
 * Handles marking events as processed/failed/dead-lettered, fetching
 * retryable and dead-lettered events, and replaying dead letters.
 */

import { and, eq, lte, ne, or } from "drizzle-orm";

import type { SchemaTables } from "./db-facade.js";
import { requireMainDb } from "./db-facade.js";
import {
  classifyError,
  RETRY_MAX_ATTEMPTS,
  retryDelayForAttempt,
} from "./job-utils.js";

type ChannelInboundEventRow =
  SchemaTables["channelInboundEvents"]["$inferSelect"];
type ChannelDeliveryStatus = ChannelInboundEventRow["deliveryStatus"];

/**
 * Whether a delivery status means the row owes no further delivery.
 *
 * A total map over the union rather than a `!== "pending"` comparison: adding
 * a status is then a compile error until its terminality is decided, and that
 * decision is load-bearing. `isDeduplicatedDeliveryOwnedBySibling` reads it to
 * decide whether a sibling event already owns this turn's reply, and the
 * stranded-delivery recovery step treats a non-terminal row as a reply still
 * owed. A new status silently defaulting to one side or the other either
 * double-posts a reply or drops one.
 */
const DELIVERY_STATUS_IS_TERMINAL: Record<ChannelDeliveryStatus, boolean> = {
  pending: false,
  delivered: true,
  failed: true,
  dead_letter: true,
};

/**
 * How long {@link deferRetryUntilIdle} pushes `retryAfter` forward. Shorter than
 * the retry sweep's own interval so a busy-deferred event is re-evaluated on the
 * next sweep (and delivered soon after its conversation frees the lock), without
 * being re-selected in a tight loop within a single sweep run.
 */
const BUSY_DEFER_RETRY_DELAY_MS = 15_000;

/**
 * Acknowledge delivery of an outbound message for a channel event.
 */
export async function acknowledgeDelivery(
  sourceChannel: string,
  externalChatId: string,
  externalMessageId: string,
): Promise<boolean> {
  const db = requireMainDb();
  const channelInboundEvents = db.schema.channelInboundEvents;
  const now = Date.now();

  const rows = await db.orm
    .select({ id: channelInboundEvents.id })
    .from(channelInboundEvents)
    .where(
      and(
        eq(channelInboundEvents.sourceChannel, sourceChannel),
        eq(channelInboundEvents.externalChatId, externalChatId),
        eq(channelInboundEvents.externalMessageId, externalMessageId),
      ),
    );
  const existing = rows[0];

  if (!existing) {
    return false;
  }

  await db.orm
    .update(channelInboundEvents)
    .set({
      deliveryStatus: "delivered",
      retryAfter: null,
      updatedAt: now,
    })
    .where(eq(channelInboundEvents.id, existing.id));

  return true;
}

/** Mark an event as successfully processed. */
export async function markProcessed(eventId: string): Promise<void> {
  const db = requireMainDb();
  const channelInboundEvents = db.schema.channelInboundEvents;
  await db.orm
    .update(channelInboundEvents)
    .set({ processingStatus: "processed", updatedAt: Date.now() })
    .where(eq(channelInboundEvents.id, eventId));
}

/** Mark an event's outbound callback delivery as complete. */
export async function markDeliveryDelivered(eventId: string): Promise<void> {
  const db = requireMainDb();
  const channelInboundEvents = db.schema.channelInboundEvents;
  await db.orm
    .update(channelInboundEvents)
    .set({
      deliveryStatus: "delivered",
      retryAfter: null,
      updatedAt: Date.now(),
    })
    .where(eq(channelInboundEvents.id, eventId));
}

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/**
 * Record a processing failure. Classifies the error to decide whether
 * the event should be retried (status='failed') or dead-lettered
 * (status='dead_letter') when the error is fatal or max attempts
 * are exhausted.
 */
export async function recordProcessingFailure(
  eventId: string,
  err: unknown,
): Promise<void> {
  const db = requireMainDb();
  const channelInboundEvents = db.schema.channelInboundEvents;
  const now = Date.now();

  const rows = await db.orm
    .select({ attempts: channelInboundEvents.processingAttempts })
    .from(channelInboundEvents)
    .where(eq(channelInboundEvents.id, eventId));
  const row = rows[0];

  const attempts = (row?.attempts ?? 0) + 1;
  const category = classifyError(err);
  const errorMsg = errorMessage(err);

  if (category === "fatal" || attempts >= RETRY_MAX_ATTEMPTS) {
    await db.orm
      .update(channelInboundEvents)
      .set({
        processingStatus: "dead_letter",
        processingAttempts: attempts,
        lastProcessingError: errorMsg,
        retryAfter: null,
        updatedAt: now,
      })
      .where(eq(channelInboundEvents.id, eventId));
  } else {
    const delay = retryDelayForAttempt(attempts);
    await db.orm
      .update(channelInboundEvents)
      .set({
        processingStatus: "failed",
        processingAttempts: attempts,
        lastProcessingError: errorMsg,
        retryAfter: Math.round(now + delay),
        updatedAt: now,
      })
      .where(eq(channelInboundEvents.id, eventId));
  }
}

/**
 * Record an outbound callback delivery failure without changing the processing
 * status. Delivery uses its own retry budget so a turn that needed processing
 * retries still gets a full delivery retry window.
 */
export async function recordDeliveryFailure(
  eventId: string,
  err: unknown,
): Promise<void> {
  const db = requireMainDb();
  const channelInboundEvents = db.schema.channelInboundEvents;
  const now = Date.now();

  const rows = await db.orm
    .select({ attempts: channelInboundEvents.deliveryAttempts })
    .from(channelInboundEvents)
    .where(eq(channelInboundEvents.id, eventId));
  const row = rows[0];

  const attempts = (row?.attempts ?? 0) + 1;
  const category = classifyError(err);
  const errorMsg = errorMessage(err);

  if (category === "fatal" || attempts >= RETRY_MAX_ATTEMPTS) {
    await db.orm
      .update(channelInboundEvents)
      .set({
        deliveryStatus: "dead_letter",
        deliveryAttempts: attempts,
        lastProcessingError: errorMsg,
        retryAfter: null,
        updatedAt: now,
      })
      .where(eq(channelInboundEvents.id, eventId));
  } else {
    const delay = retryDelayForAttempt(attempts);
    await db.orm
      .update(channelInboundEvents)
      .set({
        deliveryStatus: "failed",
        deliveryAttempts: attempts,
        lastProcessingError: errorMsg,
        retryAfter: Math.round(now + delay),
        updatedAt: now,
      })
      .where(eq(channelInboundEvents.id, eventId));
  }
}

/**
 * Mark an event as failed with a specific error message, bypassing error
 * classification. Use this when the failure reason is known and the event
 * should remain retryable (up to max attempts).
 */
export async function markRetryableFailure(
  eventId: string,
  errorMessage: string,
): Promise<void> {
  const db = requireMainDb();
  const channelInboundEvents = db.schema.channelInboundEvents;
  const now = Date.now();

  const rows = await db.orm
    .select({ attempts: channelInboundEvents.processingAttempts })
    .from(channelInboundEvents)
    .where(eq(channelInboundEvents.id, eventId));
  const row = rows[0];

  const attempts = (row?.attempts ?? 0) + 1;

  if (attempts >= RETRY_MAX_ATTEMPTS) {
    await db.orm
      .update(channelInboundEvents)
      .set({
        processingStatus: "dead_letter",
        processingAttempts: attempts,
        lastProcessingError: errorMessage,
        retryAfter: null,
        updatedAt: now,
      })
      .where(eq(channelInboundEvents.id, eventId));
  } else {
    const delay = retryDelayForAttempt(attempts);
    await db.orm
      .update(channelInboundEvents)
      .set({
        processingStatus: "failed",
        processingAttempts: attempts,
        lastProcessingError: errorMessage,
        retryAfter: Math.round(now + delay),
        updatedAt: now,
      })
      .where(eq(channelInboundEvents.id, eventId));
  }
}

/**
 * Reschedule a retryable channel event for a later sweep WITHOUT consuming its
 * processing-attempt budget or ever dead-lettering it.
 *
 * Used when a channel turn is deferred purely because its conversation is
 * mid-turn (lock contention) — the turn never ran, so it is not a processing
 * failure and must not count toward {@link RETRY_MAX_ATTEMPTS}. Counting it would
 * dead-letter (silently drop) the deferred reply once a conversation stayed busy
 * across ~8 sweeps — the exact failure this defer path exists to prevent. Keeps
 * `processingStatus = 'failed'` so the sweep re-selects the event (promoting a
 * still-`pending` orphan onto the retry path), leaves `processingAttempts`
 * untouched, and pushes `retryAfter` forward so it is not re-selected in a tight
 * loop. A conversation that stays busy indefinitely re-defers indefinitely
 * rather than dropping the reply — matching the event-driven inbound admission
 * gate, which also waits without a deadline.
 */
export async function deferRetryUntilIdle(eventId: string): Promise<void> {
  const db = requireMainDb();
  const channelInboundEvents = db.schema.channelInboundEvents;
  const now = Date.now();
  await db.orm
    .update(channelInboundEvents)
    .set({
      processingStatus: "failed",
      retryAfter: now + BUSY_DEFER_RETRY_DELAY_MS,
      updatedAt: now,
    })
    .where(eq(channelInboundEvents.id, eventId));
}

/** Fetch events eligible for automatic retry (failed + past their backoff). */
export async function getRetryableEvents(limit = 20): Promise<
  Array<{
    id: string;
    conversationId: string;
    processingAttempts: number;
    rawPayload: string | null;
  }>
> {
  const db = requireMainDb();
  const channelInboundEvents = db.schema.channelInboundEvents;
  const now = Date.now();
  return await db.orm
    .select({
      id: channelInboundEvents.id,
      conversationId: channelInboundEvents.conversationId,
      processingAttempts: channelInboundEvents.processingAttempts,
      rawPayload: channelInboundEvents.rawPayload,
    })
    .from(channelInboundEvents)
    .where(
      and(
        eq(channelInboundEvents.processingStatus, "failed"),
        lte(channelInboundEvents.retryAfter, now),
      ),
    )
    .limit(limit);
}

/** Fetch callback deliveries eligible for retry without rerunning processing. */
export async function getRetryableDeliveryEvents(limit = 20): Promise<
  Array<{
    id: string;
    conversationId: string;
    messageId: string | null;
    processingAttempts: number;
    rawPayload: string | null;
    deliveredSegmentCount: number;
  }>
> {
  const db = requireMainDb();
  const channelInboundEvents = db.schema.channelInboundEvents;
  const now = Date.now();
  return await db.orm
    .select({
      id: channelInboundEvents.id,
      conversationId: channelInboundEvents.conversationId,
      messageId: channelInboundEvents.messageId,
      processingAttempts: channelInboundEvents.processingAttempts,
      rawPayload: channelInboundEvents.rawPayload,
      deliveredSegmentCount: channelInboundEvents.deliveredSegmentCount,
    })
    .from(channelInboundEvents)
    .where(
      and(
        eq(channelInboundEvents.processingStatus, "processed"),
        eq(channelInboundEvents.deliveryStatus, "failed"),
        lte(channelInboundEvents.retryAfter, now),
      ),
    )
    .limit(limit);
}

/**
 * Fetch the `deliveryStatus` of every OTHER inbound event linked to the given
 * user message (excluding `excludeEventId`).
 *
 * An at-least-once redelivery that deduplicates against the original turn is
 * `linkMessage`d to that turn's `messageId`, so the original and the
 * redelivered event become siblings sharing `messageId`. The dedup dispatch
 * path reads these statuses to tell an already-owned delivery from the crash
 * window where the reply was persisted but never delivered.
 */
export async function getSiblingEventDeliveryStatuses(
  messageId: string,
  excludeEventId: string,
): Promise<ChannelDeliveryStatus[]> {
  const db = requireMainDb();
  const channelInboundEvents = db.schema.channelInboundEvents;
  const rows = await db.orm
    .select({ deliveryStatus: channelInboundEvents.deliveryStatus })
    .from(channelInboundEvents)
    .where(
      and(
        eq(channelInboundEvents.messageId, messageId),
        ne(channelInboundEvents.id, excludeEventId),
      ),
    );
  return rows.map((row) => row.deliveryStatus);
}

/**
 * True when another inbound event linked to the same user message has already
 * taken ownership of delivering this turn's reply — its delivery status has left
 * `pending` (delivered, failed, or dead-lettered). A deduplicated replay must
 * skip `finalizeEventDelivery` in that case, or it would re-post a reply the
 * owning event already delivered (or is retrying). Shared by the live
 * background dispatch and the retry sweep so both gate delivery identically.
 */
export async function isDeduplicatedDeliveryOwnedBySibling(
  messageId: string,
  excludeEventId: string,
): Promise<boolean> {
  const statuses = await getSiblingEventDeliveryStatuses(
    messageId,
    excludeEventId,
  );
  return statuses.some((status) => DELIVERY_STATUS_IS_TERMINAL[status]);
}

/** Fetch dead-lettered events. */
export async function getDeadLetterEvents(): Promise<
  Array<{
    id: string;
    sourceChannel: string;
    externalChatId: string;
    externalMessageId: string;
    conversationId: string;
    processingAttempts: number;
    lastProcessingError: string | null;
    createdAt: number;
  }>
> {
  const db = requireMainDb();
  const channelInboundEvents = db.schema.channelInboundEvents;
  return await db.orm
    .select({
      id: channelInboundEvents.id,
      sourceChannel: channelInboundEvents.sourceChannel,
      externalChatId: channelInboundEvents.externalChatId,
      externalMessageId: channelInboundEvents.externalMessageId,
      conversationId: channelInboundEvents.conversationId,
      processingAttempts: channelInboundEvents.processingAttempts,
      lastProcessingError: channelInboundEvents.lastProcessingError,
      createdAt: channelInboundEvents.createdAt,
    })
    .from(channelInboundEvents)
    .where(
      or(
        eq(channelInboundEvents.processingStatus, "dead_letter"),
        and(
          eq(channelInboundEvents.processingStatus, "processed"),
          eq(channelInboundEvents.deliveryStatus, "dead_letter"),
        ),
      ),
    );
}

/**
 * Reset dead-lettered events back to 'failed' so the sweep can retry
 * them. Resets attempt counter and sets an immediate retry_after.
 */
export async function replayDeadLetters(eventIds: string[]): Promise<number> {
  const db = requireMainDb();
  const channelInboundEvents = db.schema.channelInboundEvents;
  const now = Date.now();
  let count = 0;
  for (const id of eventIds) {
    const rows = await db.orm
      .select({
        id: channelInboundEvents.id,
        processingStatus: channelInboundEvents.processingStatus,
        deliveryStatus: channelInboundEvents.deliveryStatus,
      })
      .from(channelInboundEvents)
      .where(
        and(
          eq(channelInboundEvents.id, id),
          or(
            eq(channelInboundEvents.processingStatus, "dead_letter"),
            and(
              eq(channelInboundEvents.processingStatus, "processed"),
              eq(channelInboundEvents.deliveryStatus, "dead_letter"),
            ),
          ),
        ),
      );
    const existing = rows[0];
    if (!existing) {
      continue;
    }

    if (existing.processingStatus === "dead_letter") {
      await db.orm
        .update(channelInboundEvents)
        .set({
          processingStatus: "failed",
          processingAttempts: 0,
          lastProcessingError: null,
          retryAfter: now,
          updatedAt: now,
        })
        .where(eq(channelInboundEvents.id, id));
    } else {
      await db.orm
        .update(channelInboundEvents)
        .set({
          deliveryStatus: "failed",
          deliveryAttempts: 0,
          lastProcessingError: null,
          retryAfter: now,
          updatedAt: now,
        })
        .where(eq(channelInboundEvents.id, id));
    }
    count++;
  }
  return count;
}
