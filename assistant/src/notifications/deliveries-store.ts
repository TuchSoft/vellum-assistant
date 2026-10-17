/**
 * Delivery audit records for notifications.
 *
 * Each row represents a single attempt to deliver a notification decision
 * to a specific channel and destination. Multiple attempts for the same
 * (decision, channel, destination) are tracked via the `attempt` counter.
 */

import { and, eq } from "drizzle-orm";

import type { SchemaTables } from "../persistence/db-facade.js";
import { requireMainDb } from "../persistence/db-facade.js";
import type {
  NotificationChannel,
  NotificationDeliveryStatus,
} from "./types.js";

export interface NotificationDeliveryRow {
  id: string;
  notificationDecisionId: string;
  channel: string;
  destination: string;
  status: string;
  attempt: number;
  renderedTitle: string | null;
  renderedBody: string | null;
  errorCode: string | null;
  errorMessage: string | null;
  sentAt: number | null;
  conversationId: string | null;
  messageId: string | null;
  /** Assistant row a successful channel delivery was recorded as. */
  canonicalMessageId: string | null;
  conversationStrategy: string | null;
  conversationAction: string | null;
  conversationTargetId: string | null;
  conversationFallbackUsed: number | null;
  clientDeliveryStatus: string | null;
  clientDeliveryError: string | null;
  clientDeliveryAt: number | null;
  createdAt: number;
  updatedAt: number;
}

function rowToDelivery(
  row: SchemaTables["notificationDeliveries"]["$inferSelect"],
): NotificationDeliveryRow {
  return {
    id: row.id,
    notificationDecisionId: row.notificationDecisionId,
    channel: row.channel,
    destination: row.destination,
    status: row.status,
    attempt: row.attempt,
    renderedTitle: row.renderedTitle,
    renderedBody: row.renderedBody,
    errorCode: row.errorCode,
    errorMessage: row.errorMessage,
    sentAt: row.sentAt,
    conversationId: row.conversationId,
    messageId: row.messageId,
    canonicalMessageId: row.canonicalMessageId,
    conversationStrategy: row.conversationStrategy,
    conversationAction: row.conversationAction,
    conversationTargetId: row.conversationTargetId,
    conversationFallbackUsed: row.conversationFallbackUsed,
    clientDeliveryStatus: row.clientDeliveryStatus,
    clientDeliveryError: row.clientDeliveryError,
    clientDeliveryAt: row.clientDeliveryAt,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}

export interface CreateDeliveryParams {
  id: string;
  notificationDecisionId: string;
  channel: NotificationChannel;
  destination: string;
  status: NotificationDeliveryStatus;
  attempt: number;
  renderedTitle?: string;
  renderedBody?: string;
  errorCode?: string;
  errorMessage?: string;
  sentAt?: number;
  conversationId?: string;
  messageId?: string;
  conversationStrategy?: string;
  conversationAction?: string;
  conversationTargetId?: string;
  conversationFallbackUsed?: boolean;
}

/** Create a new delivery audit record. */
export async function createDelivery(
  params: CreateDeliveryParams,
): Promise<NotificationDeliveryRow> {
  const db = requireMainDb();
  const deliveries = db.schema.notificationDeliveries;
  const now = Date.now();

  const row = {
    id: params.id,
    notificationDecisionId: params.notificationDecisionId,
    channel: params.channel,
    destination: params.destination,
    status: params.status,
    attempt: params.attempt,
    renderedTitle: params.renderedTitle ?? null,
    renderedBody: params.renderedBody ?? null,
    errorCode: params.errorCode ?? null,
    errorMessage: params.errorMessage ?? null,
    sentAt: params.sentAt ?? null,
    conversationId: params.conversationId ?? null,
    messageId: params.messageId ?? null,
    canonicalMessageId: null,
    conversationStrategy: params.conversationStrategy ?? null,
    conversationAction: params.conversationAction ?? null,
    conversationTargetId: params.conversationTargetId ?? null,
    conversationFallbackUsed:
      params.conversationFallbackUsed != null
        ? params.conversationFallbackUsed
          ? 1
          : 0
        : null,
    clientDeliveryStatus: null,
    clientDeliveryError: null,
    clientDeliveryAt: null,
    createdAt: now,
    updatedAt: now,
  };

  await db.orm.insert(deliveries).values(row);

  return row;
}

/** Update the status of an existing delivery record. */
export async function updateDeliveryStatus(
  id: string,
  status: NotificationDeliveryStatus,
  error?: { code?: string; message?: string },
  patch?: { messageId?: string; canonicalMessageId?: string },
): Promise<boolean> {
  const db = requireMainDb();
  const deliveries = db.schema.notificationDeliveries;
  const now = Date.now();

  const updates: Record<string, unknown> = { status, updatedAt: now };
  if (status === "sent") {
    updates.sentAt = now;
  }
  if (error?.code) {
    updates.errorCode = error.code;
  }
  if (error?.message) {
    updates.errorMessage = error.message;
  }
  if (patch?.messageId !== undefined) {
    updates.messageId = patch.messageId;
  }
  if (patch?.canonicalMessageId !== undefined) {
    updates.canonicalMessageId = patch.canonicalMessageId;
  }

  const updated = await db.orm
    .update(deliveries)
    .set(updates)
    .where(eq(deliveries.id, id))
    .returning({ id: deliveries.id });

  return updated.length > 0;
}

/**
 * Update the rendered copy on an existing delivery row.
 *
 * Used by the edit pipeline so the delivery audit reflects the latest
 * title/body shown to the user, not just the original send.
 */
export async function updateDeliveryRenderedCopy(
  id: string,
  patch: { renderedTitle?: string; renderedBody?: string },
): Promise<boolean> {
  const db = requireMainDb();
  const deliveries = db.schema.notificationDeliveries;
  const updates: Record<string, unknown> = { updatedAt: Date.now() };
  if (patch.renderedTitle !== undefined) {
    updates.renderedTitle = patch.renderedTitle;
  }
  if (patch.renderedBody !== undefined) {
    updates.renderedBody = patch.renderedBody;
  }
  if (Object.keys(updates).length === 1) {
    return false;
  }

  const updated = await db.orm
    .update(deliveries)
    .set(updates)
    .where(eq(deliveries.id, id))
    .returning({ id: deliveries.id });

  return updated.length > 0;
}

/** Check whether a delivery already exists for a given decision+channel pair. */
export async function findDeliveryByDecisionAndChannel(
  decisionId: string,
  channel: NotificationChannel,
): Promise<NotificationDeliveryRow | undefined> {
  const db = requireMainDb();
  const deliveries = db.schema.notificationDeliveries;
  const [row] = await db.orm
    .select()
    .from(deliveries)
    .where(
      and(
        eq(deliveries.notificationDecisionId, decisionId),
        eq(deliveries.channel, channel),
      ),
    )
    .limit(1);
  return row ? rowToDelivery(row) : undefined;
}

/** Return every delivery row for a given decision. */
export async function findDeliveriesByDecisionId(
  decisionId: string,
): Promise<NotificationDeliveryRow[]> {
  const db = requireMainDb();
  const deliveries = db.schema.notificationDeliveries;
  const rows = await db.orm
    .select()
    .from(deliveries)
    .where(eq(deliveries.notificationDecisionId, decisionId));
  return rows.map(rowToDelivery);
}
