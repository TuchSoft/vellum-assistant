import { and, desc, eq, lte } from "drizzle-orm";
import { v4 as uuid } from "uuid";

import type { AsyncDb } from "./db-facade.js";
import { requireMainDb } from "./db-facade.js";

export interface CompactionEvent {
  /** Wall-clock time the compaction ran (= `conversations.context_compacted_at`). */
  compactedAt: number;
  summary: string;
  /** Count of leading persisted messages behind this compaction's summary. */
  compactedMessageCount: number;
}

/**
 * Append a compaction event to the ledger. Called alongside the
 * `conversations` cache update on every compaction.
 */
export async function appendCompactionEvent(
  conversationId: string,
  event: CompactionEvent,
): Promise<void> {
  const db = requireMainDb();
  const conversationCompactionEvents = db.schema.conversationCompactionEvents;
  await db.orm.insert(conversationCompactionEvents).values({
    id: uuid(),
    conversationId,
    compactedAt: event.compactedAt,
    summary: event.summary,
    compactedMessageCount: event.compactedMessageCount,
    createdAt: Date.now(),
  });
}

/**
 * The most recent compaction event whose `compactedAt` is at-or-before
 * `atOrBefore`, or null if none (or `atOrBefore` is null). This is the fork
 * inheritance rule: a compaction applies to a fork only if it happened before
 * the message being forked from.
 */
export async function getLatestCompactionEventAtOrBefore(
  conversationId: string,
  atOrBefore: number | null,
): Promise<CompactionEvent | null> {
  if (atOrBefore == null) {
    return null;
  }
  const db = requireMainDb();
  const conversationCompactionEvents = db.schema.conversationCompactionEvents;
  const [row] = await db.orm
    .select({
      compactedAt: conversationCompactionEvents.compactedAt,
      summary: conversationCompactionEvents.summary,
      compactedMessageCount: conversationCompactionEvents.compactedMessageCount,
    })
    .from(conversationCompactionEvents)
    .where(
      and(
        eq(conversationCompactionEvents.conversationId, conversationId),
        lte(conversationCompactionEvents.compactedAt, atOrBefore),
      ),
    )
    .orderBy(desc(conversationCompactionEvents.compactedAt))
    .limit(1);
  return row ?? null;
}

/**
 * Copy the source conversation's ledger events with `compactedAt <=
 * boundaryCreatedAt` into the fork, so the fork owns a correct ledger for its
 * own future forks/compactions. Takes the active `db` so the copy joins the
 * caller's transaction. No-op when the boundary is null.
 */
export async function forkCompactionLedger(
  db: AsyncDb,
  sourceConversationId: string,
  forkConversationId: string,
  boundaryCreatedAt: number | null,
): Promise<void> {
  if (boundaryCreatedAt == null) {
    return;
  }
  const conversationCompactionEvents = db.schema.conversationCompactionEvents;
  const events = await db.orm
    .select({
      compactedAt: conversationCompactionEvents.compactedAt,
      summary: conversationCompactionEvents.summary,
      compactedMessageCount: conversationCompactionEvents.compactedMessageCount,
    })
    .from(conversationCompactionEvents)
    .where(
      and(
        eq(conversationCompactionEvents.conversationId, sourceConversationId),
        lte(conversationCompactionEvents.compactedAt, boundaryCreatedAt),
      ),
    );
  if (events.length === 0) {
    return;
  }
  const now = Date.now();
  await db.orm.insert(conversationCompactionEvents).values(
    events.map((event) => ({
      id: uuid(),
      conversationId: forkConversationId,
      compactedAt: event.compactedAt,
      summary: event.summary,
      compactedMessageCount: event.compactedMessageCount,
      createdAt: now,
    })),
  );
}
