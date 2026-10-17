/**
 * Named read accessors for the `messages` table.
 *
 * Every row in `messages` is conversation content in some state of
 * completeness: `finalized = 1` rows are immutable history, `finalized = 0`
 * rows are still being written and their `content` may be a `{ ref }` into an
 * in-flight delta file that disappears when the turn completes. Ad-hoc queries
 * tend to encode a visibility decision without stating it; each accessor here
 * states its decision in its name and contract, so a caller (and a reviewer)
 * chooses between "completed history" and "any row" deliberately.
 *
 * Conversation-history reads (transcripts, lineage, pagination) stay with
 * `getMessages` / `getMessagesAfter` / `getMessagesPaginated` in
 * `conversation-crud.ts`, which also own fork-lineage resolution. This module
 * is for the narrower point lookups and aggregates that other persistence
 * modules need.
 *
 * Correlated subqueries embedded inside larger SQL (usage accounting's
 * turn-index arithmetic, search candidate joins, `message_count` projections)
 * are out of scope: extracting them would restructure their host queries. They
 * carry their visibility decision as a comment at the site instead.
 */

import { and, desc, eq, inArray, lt, sql } from "drizzle-orm";

import type { AsyncDb } from "./db-facade.js";
import { requireMainDb } from "./db-facade.js";

/** `(id, createdAt)` of a message, the shape cursor and watermark logic needs. */
export interface MessageRef {
  id: string;
  createdAt: number;
}

/**
 * Structural read handle: any facade connection, which includes the shared
 * connection and an open transaction. Every accessor takes `opts.db` with this
 * type and defaults to the shared connection, so a caller holding its own
 * handle (a transaction, an injected or in-memory database) reads the same
 * database it writes.
 */
export type MessageReadHandle = AsyncDb;

/**
 * The newest completed assistant message in a conversation, or null when it
 * has none.
 *
 * Finalized-only: an assistant row that is still streaming is not a reply yet,
 * so consumers tracking "the latest reply" (read/unread watermarks, previews)
 * must not anchor on it. The row qualifies on its own once the turn completes.
 *
 * `db` lets a caller inside a transaction read through its own handle.
 */
export async function latestAssistantMessage(
  conversationId: string,
  opts?: { db?: MessageReadHandle },
): Promise<MessageRef | null> {
  return await newestFinalizedAssistantRow(
    conversationId,
    opts?.db ?? requireMainDb(),
  );
}

/**
 * The newest completed assistant message strictly before `createdAt`, or null.
 * Strict comparison: rewind logic that landed on a same-timestamp sibling
 * would classify the latest reply as already seen.
 */
export async function latestAssistantMessageBefore(
  conversationId: string,
  createdAt: number,
  opts?: { db?: MessageReadHandle },
): Promise<MessageRef | null> {
  return await newestFinalizedAssistantRow(
    conversationId,
    opts?.db ?? requireMainDb(),
    createdAt,
  );
}

async function newestFinalizedAssistantRow(
  conversationId: string,
  db: MessageReadHandle,
  strictlyBefore?: number,
): Promise<MessageRef | null> {
  const messages = db.schema.messages;
  const [row] = await db.orm
    .select({ id: messages.id, createdAt: messages.createdAt })
    .from(messages)
    .where(
      and(
        eq(messages.conversationId, conversationId),
        eq(messages.role, "assistant"),
        eq(messages.finalized, 1),
        ...(strictlyBefore === undefined
          ? []
          : [lt(messages.createdAt, strictlyBefore)]),
      ),
    )
    .orderBy(desc(messages.createdAt), desc(messages.id))
    .limit(1);
  return row ?? null;
}

/**
 * Raw `content` of the last user-role row in a conversation, in `(createdAt,
 * id)` order, or null when there is none.
 *
 * Ordering is load-bearing for the undo path this serves: rows written in the
 * same millisecond must resolve deterministically. User rows are always
 * written finalized, so no completeness predicate applies; only assistant
 * turns stream.
 */
export async function latestUserMessageRawContent(
  conversationId: string,
  opts?: { db?: MessageReadHandle },
): Promise<string | null> {
  const db = opts?.db ?? requireMainDb();
  const messages = db.schema.messages;
  const [row] = await db.orm
    .select({ content: messages.content })
    .from(messages)
    .where(
      and(
        eq(messages.conversationId, conversationId),
        eq(messages.role, "user"),
      ),
    )
    .orderBy(desc(messages.createdAt), desc(messages.id))
    .limit(1);
  return row?.content ?? null;
}

/**
 * Per-conversation count and latest timestamp of rows with `role`, for the
 * given conversations.
 *
 * Any-state deliberately: these aggregates feed list ordering and previews,
 * where a streaming reply still counts as activity. A caller needing
 * completed-only aggregates should say so here rather than post-filtering.
 */
export async function countMessagesByRoleForConversations(
  conversationIds: string[],
  role: string,
  opts?: { db?: MessageReadHandle },
): Promise<Map<string, { count: number; lastAt: number }>> {
  if (conversationIds.length === 0) {
    return new Map();
  }
  const db = opts?.db ?? requireMainDb();
  const messages = db.schema.messages;
  const rows = await db.orm
    .select({
      conversationId: messages.conversationId,
      count: sql<number>`COUNT(*)`.as("count"),
      lastAt: sql<number>`MAX(${messages.createdAt})`.as("last_at"),
    })
    .from(messages)
    .where(
      and(
        inArray(messages.conversationId, conversationIds),
        eq(messages.role, role),
      ),
    )
    .groupBy(messages.conversationId);
  return new Map(
    rows.map((r) => [
      r.conversationId,
      { count: Number(r.count), lastAt: Number(r.lastAt) },
    ]),
  );
}

/**
 * Which of `messageIds` exist as rows, in any state.
 *
 * Any-state deliberately: existence is the question (orphan detection for
 * rows referencing messages), and a streaming row exists. An empty input
 * returns an empty set without querying.
 */
export async function existingMessageIds(
  messageIds: string[],
  opts?: { db?: MessageReadHandle },
): Promise<Set<string>> {
  if (messageIds.length === 0) {
    return new Set();
  }
  const db = opts?.db ?? requireMainDb();
  const messages = db.schema.messages;
  const rows = await db.orm
    .select({ id: messages.id })
    .from(messages)
    .where(inArray(messages.id, messageIds));
  return new Set(rows.map((r) => r.id));
}

/**
 * `createdAt` of each of `messageIds` that exists as a row, keyed by id, in
 * any state.
 *
 * Any-state deliberately: a row's `createdAt` is fixed at insert, so its
 * completeness does not change the answer, and the callers (retrospective
 * cursor bookkeeping) hold ids taken from rows they have already reviewed.
 * An empty input returns an empty map without querying.
 */
export async function messageCreatedAtByIds(
  messageIds: readonly string[],
  opts?: { db?: MessageReadHandle },
): Promise<Map<string, number>> {
  const db = opts?.db ?? requireMainDb();
  const messages = db.schema.messages;
  const result = new Map<string, number>();
  // Chunked so a whole-conversation id list keeps each statement's bind
  // parameter count bounded.
  for (let offset = 0; offset < messageIds.length; offset += 500) {
    const rows = await db.orm
      .select({ id: messages.id, createdAt: messages.createdAt })
      .from(messages)
      .where(inArray(messages.id, messageIds.slice(offset, offset + 500)));
    for (const row of rows) {
      result.set(row.id, row.createdAt);
    }
  }
  return result;
}

/**
 * The conversation that owns `messageId`, in any state, or null when the
 * message does not exist.
 *
 * Any-state deliberately: callers hold an id the user acted on (a bookmark on
 * a rendered row, an attachment link), and a rendered row may still be
 * streaming.
 */
export async function messageConversationId(
  messageId: string,
  opts?: { db?: MessageReadHandle },
): Promise<string | null> {
  const db = opts?.db ?? requireMainDb();
  const messages = db.schema.messages;
  const [row] = await db.orm
    .select({ conversationId: messages.conversationId })
    .from(messages)
    .where(eq(messages.id, messageId));
  return row?.conversationId ?? null;
}
