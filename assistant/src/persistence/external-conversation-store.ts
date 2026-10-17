/**
 * Store for external conversation bindings — maps internal conversation IDs
 * to external channel identifiers (e.g. Telegram chat ID, voice session).
 *
 * This enables the system to track which conversations originated from
 * external channels and expose channel metadata in session/conversation
 * list APIs.
 */

import { and, eq, inArray, isNull, type SQL, sql } from "drizzle-orm";
import type { AnyPgColumn } from "drizzle-orm/pg-core";

import { requireMainDb } from "./db-facade.js";

export interface ExternalConversationBinding {
  conversationId: string;
  sourceChannel: string;
  externalChatId: string;
  externalChatName?: string | null;
  externalThreadId?: string | null;
  externalUserId?: string | null;
  displayName?: string | null;
  username?: string | null;
  createdAt: number;
  updatedAt: number;
  lastInboundAt?: number | null;
  lastOutboundAt?: number | null;
}

export interface UpsertBindingInput {
  conversationId: string;
  sourceChannel: string;
  externalChatId: string;
  externalChatName?: string | null;
  externalThreadId?: string | null;
  externalUserId?: string | null;
  displayName?: string | null;
  username?: string | null;
}

/**
 * The form a thread id takes in a binding: trimmed, and `null` for absent or
 * blank. Every lookup keyed by thread compares in this form, and so must any
 * caller comparing a target thread against a binding's.
 */
export function normalizeExternalThreadId(
  externalThreadId?: string | null,
): string | null {
  const trimmed = externalThreadId?.trim();
  return trimmed ? trimmed : null;
}

/**
 * An upsert value that leaves the stored column alone when the caller said
 * nothing about it, distinguishing "I do not know" from "there is none".
 */
function keepStoredIfAbsent<T extends string | null | undefined>(
  value: T,
  column: AnyPgColumn,
): Exclude<T, undefined> | SQL {
  return value === undefined
    ? sql`${column}`
    : (value as Exclude<T, undefined>);
}

function normalizeExternalChatName(
  externalChatName?: string | null,
): string | null {
  const trimmed = externalChatName?.trim();
  return trimmed ? trimmed : null;
}

/**
 * Insert or update an external conversation binding on conflict (conversationId).
 * On conflict, updates channel metadata and timestamps.
 */
export async function upsertBinding(input: UpsertBindingInput): Promise<void> {
  const db = requireMainDb();
  const externalConversationBindings = db.schema.externalConversationBindings;
  const now = Date.now();
  const externalThreadId = normalizeExternalThreadId(input.externalThreadId);
  const externalChatName = normalizeExternalChatName(input.externalChatName);

  // If a stale binding exists for this channel/chat/thread tuple under a
  // different conversationId, remove it first so the unique index is not violated.
  const existing = await getBindingByChannelChatThread(
    input.sourceChannel,
    input.externalChatId,
    externalThreadId,
  );
  if (existing && existing.conversationId !== input.conversationId) {
    await db.orm
      .delete(externalConversationBindings)
      .where(
        eq(
          externalConversationBindings.conversationId,
          existing.conversationId,
        ),
      );
  }

  await db.orm
    .insert(externalConversationBindings)
    .values({
      conversationId: input.conversationId,
      sourceChannel: input.sourceChannel,
      externalChatId: input.externalChatId,
      externalChatName,
      externalThreadId,
      externalUserId: input.externalUserId ?? null,
      displayName: input.displayName ?? null,
      username: input.username ?? null,
      createdAt: now,
      updatedAt: now,
      lastInboundAt: now,
    })
    .onConflictDoUpdate({
      target: externalConversationBindings.conversationId,
      set: {
        sourceChannel: input.sourceChannel,
        externalChatId: input.externalChatId,
        // An absent chat name preserves the stored one only while the
        // binding still addresses the same chat; a move to a chat that
        // reported no name clears it, so the old chat's name can never
        // label the new one.
        externalChatName:
          externalChatName ??
          sql`CASE WHEN ${externalConversationBindings.sourceChannel} = ${input.sourceChannel} AND ${externalConversationBindings.externalChatId} = ${input.externalChatId} THEN ${externalConversationBindings.externalChatName} ELSE NULL END`,
        externalThreadId,
        // An omitted sender field keeps what is stored; an explicit value,
        // including null, replaces it. A caller that knows only the chat
        // coordinates on a message is silent about the sender rather than
        // asserting there is none, and erasing a known name on that silence
        // drops it from the conversation and session APIs.
        externalUserId: keepStoredIfAbsent(
          input.externalUserId,
          externalConversationBindings.externalUserId,
        ),
        displayName: keepStoredIfAbsent(
          input.displayName,
          externalConversationBindings.displayName,
        ),
        username: keepStoredIfAbsent(
          input.username,
          externalConversationBindings.username,
        ),
        updatedAt: now,
        lastInboundAt: now,
      },
    });
}

/**
 * Upsert an external conversation binding for outbound sends.
 * Similar to upsertBinding but touches lastOutboundAt instead of lastInboundAt,
 * and only requires channel identifiers (no sender metadata needed).
 */
export async function upsertOutboundBinding(input: {
  conversationId: string;
  sourceChannel: string;
  externalChatId: string;
  externalThreadId?: string | null;
}): Promise<void> {
  const db = requireMainDb();
  const externalConversationBindings = db.schema.externalConversationBindings;
  const now = Date.now();
  const externalThreadId = normalizeExternalThreadId(input.externalThreadId);

  // If a stale binding exists for this channel/chat/thread tuple under a
  // different conversationId, remove it first so the unique index is not violated.
  const existing = await getBindingByChannelChatThread(
    input.sourceChannel,
    input.externalChatId,
    externalThreadId,
  );
  if (existing && existing.conversationId !== input.conversationId) {
    await db.orm
      .delete(externalConversationBindings)
      .where(
        eq(
          externalConversationBindings.conversationId,
          existing.conversationId,
        ),
      );
  }

  await db.orm
    .insert(externalConversationBindings)
    .values({
      conversationId: input.conversationId,
      sourceChannel: input.sourceChannel,
      externalChatId: input.externalChatId,
      externalThreadId,
      externalUserId: null,
      displayName: null,
      username: null,
      createdAt: now,
      updatedAt: now,
      lastOutboundAt: now,
    })
    .onConflictDoUpdate({
      target: externalConversationBindings.conversationId,
      set: {
        sourceChannel: input.sourceChannel,
        externalChatId: input.externalChatId,
        externalThreadId,
        updatedAt: now,
        lastOutboundAt: now,
      },
    });
}

export async function updateExternalChatName(
  conversationId: string,
  externalChatName: string,
): Promise<void> {
  const trimmedName = externalChatName.trim();
  if (!trimmedName) {
    return;
  }

  const db = requireMainDb();
  const externalConversationBindings = db.schema.externalConversationBindings;
  await db.orm
    .update(externalConversationBindings)
    .set({
      externalChatName: trimmedName,
      updatedAt: Date.now(),
    })
    .where(eq(externalConversationBindings.conversationId, conversationId));
}

/**
 * Look up an external binding by conversation ID.
 */
export async function getBindingByConversation(
  conversationId: string,
): Promise<ExternalConversationBinding | null> {
  const db = requireMainDb();
  const externalConversationBindings = db.schema.externalConversationBindings;
  const [row] = await db.orm
    .select()
    .from(externalConversationBindings)
    .where(eq(externalConversationBindings.conversationId, conversationId));
  return row ?? null;
}

/**
 * Look up an external binding by channel + external chat ID.
 */
export async function getBindingByChannelChat(
  sourceChannel: string,
  externalChatId: string,
): Promise<ExternalConversationBinding | null> {
  return await getBindingByChannelChatThread(
    sourceChannel,
    externalChatId,
    null,
  );
}

/**
 * Look up an external binding by channel + external chat ID + optional thread ID.
 */
export async function getBindingByChannelChatThread(
  sourceChannel: string,
  externalChatId: string,
  externalThreadId?: string | null,
): Promise<ExternalConversationBinding | null> {
  const db = requireMainDb();
  const externalConversationBindings = db.schema.externalConversationBindings;
  const normalizedThreadId = normalizeExternalThreadId(externalThreadId);
  const [row] = await db.orm
    .select()
    .from(externalConversationBindings)
    .where(
      and(
        eq(externalConversationBindings.sourceChannel, sourceChannel),
        eq(externalConversationBindings.externalChatId, externalChatId),
        normalizedThreadId
          ? eq(
              externalConversationBindings.externalThreadId,
              normalizedThreadId,
            )
          : isNull(externalConversationBindings.externalThreadId),
      ),
    );
  return row ?? null;
}

/**
 * Remove an external binding by channel + external chat ID.
 * Used when disconnecting a synced conversation by its channel identifiers.
 */
export async function deleteBindingByChannelChat(
  sourceChannel: string,
  externalChatId: string,
): Promise<void> {
  const db = requireMainDb();
  const externalConversationBindings = db.schema.externalConversationBindings;
  await db.orm
    .delete(externalConversationBindings)
    .where(
      and(
        eq(externalConversationBindings.sourceChannel, sourceChannel),
        eq(externalConversationBindings.externalChatId, externalChatId),
      ),
    );
}

/**
 * Remove only the thread-less (chat-level) binding for a channel + chat,
 * leaving bindings that carry an `externalThreadId` untouched. Used when
 * resetting a chat's main conversation so sibling thread/topic conversations
 * in the same chat keep their bindings.
 */
export async function deleteBindingByChannelChatNullThread(
  sourceChannel: string,
  externalChatId: string,
): Promise<void> {
  const db = requireMainDb();
  const externalConversationBindings = db.schema.externalConversationBindings;
  await db.orm
    .delete(externalConversationBindings)
    .where(
      and(
        eq(externalConversationBindings.sourceChannel, sourceChannel),
        eq(externalConversationBindings.externalChatId, externalChatId),
        isNull(externalConversationBindings.externalThreadId),
      ),
    );
}

/**
 * Remove an external binding by channel + external chat ID + thread ID.
 */
export async function deleteBindingByChannelChatThread(
  sourceChannel: string,
  externalChatId: string,
  externalThreadId: string,
): Promise<void> {
  const normalizedThreadId = normalizeExternalThreadId(externalThreadId);
  if (!normalizedThreadId) {
    await deleteBindingByChannelChat(sourceChannel, externalChatId);
    return;
  }
  const db = requireMainDb();
  const externalConversationBindings = db.schema.externalConversationBindings;
  await db.orm
    .delete(externalConversationBindings)
    .where(
      and(
        eq(externalConversationBindings.sourceChannel, sourceChannel),
        eq(externalConversationBindings.externalChatId, externalChatId),
        eq(externalConversationBindings.externalThreadId, normalizedThreadId),
      ),
    );
}

/**
 * Get bindings for multiple conversation IDs at once.
 * Returns a map of conversationId -> binding for efficient lookup.
 */
export async function getBindingsForConversations(
  conversationIds: string[],
): Promise<Map<string, ExternalConversationBinding>> {
  if (conversationIds.length === 0) {
    return new Map();
  }

  const db = requireMainDb();
  const externalConversationBindings = db.schema.externalConversationBindings;
  const result = new Map<string, ExternalConversationBinding>();

  const all = await db.orm
    .select()
    .from(externalConversationBindings)
    .where(
      inArray(externalConversationBindings.conversationId, conversationIds),
    );

  for (const row of all) {
    result.set(row.conversationId, row);
  }

  return result;
}
