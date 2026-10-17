/**
 * In-flight conversation turns, read from the assistant's database.
 *
 * The daemon persists `conversations.processing_started_at` at every turn
 * boundary (see `Conversation.setProcessing`) precisely so out-of-process
 * callers can detect mid-turn state by reading the row directly. The monitor
 * folds that into each sample, so a memory spike in the ring buffer names the
 * conversation that was running — the live flag is nulled when the turn ends,
 * so only a sampling-time capture preserves the correlation for post-mortems.
 *
 * Best-effort: any failure — database unavailable, table not created yet —
 * yields null.
 */

import { asc, isNotNull } from "drizzle-orm";

import { requireMainDb } from "../persistence/db-facade.js";

/** Cap on entries recorded per sample so a pathological burst stays bounded. */
const MAX_ENTRIES = 20;
/** Cap on recorded title length; titles can carry long user content. */
const MAX_TITLE_CHARS = 80;

export interface ActiveConversation {
  conversationId: string;
  /** Truncated conversation title — names background jobs at a glance. */
  title: string | null;
  originChannel: string | null;
  originInterface: string | null;
  processingStartedAt: number;
}

/**
 * Conversations currently mid-turn, longest-running first. Null when the
 * database is unavailable or nothing is processing.
 */
export async function readActiveConversations(): Promise<
  ActiveConversation[] | null
> {
  try {
    const db = requireMainDb();
    const conversations = db.schema.conversations;
    const rows = await db.orm
      .select({
        id: conversations.id,
        title: conversations.title,
        originChannel: conversations.originChannel,
        originInterface: conversations.originInterface,
        processingStartedAt: conversations.processingStartedAt,
      })
      .from(conversations)
      .where(isNotNull(conversations.processingStartedAt))
      .orderBy(asc(conversations.processingStartedAt))
      .limit(MAX_ENTRIES);
    if (rows.length === 0) {
      return null;
    }
    return rows.flatMap((row) => {
      if (row.processingStartedAt == null) {
        return [];
      }
      return [
        {
          conversationId: row.id,
          title: row.title != null ? row.title.slice(0, MAX_TITLE_CHARS) : null,
          originChannel: row.originChannel,
          originInterface: row.originInterface,
          processingStartedAt: row.processingStartedAt,
        },
      ];
    });
  } catch {
    // Database unavailable or the schema is not migrated yet.
    return null;
  }
}
