import { and, desc, eq, type SQL } from "drizzle-orm";
import { v4 as uuid } from "uuid";

import type { AsyncDb } from "./db-facade.js";
import { requireMainDb } from "./db-facade.js";
import { stringifyMessageContent } from "./message-content.js";
import { projectPersistedRowText } from "./user-facing-content.js";

/**
 * Wire-shape representation of a bookmark, joined with the bookmarked
 * message and its parent conversation. Dates are emitted as
 * unix-millisecond integers, and the message preview is capped to keep
 * the list payload bounded.
 */
export interface BookmarkSummary {
  id: string;
  messageId: string;
  conversationId: string;
  conversationTitle: string | null;
  messagePreview: string;
  /** "user" | "assistant", kept as a free-form string so it round-trips raw. */
  messageRole: string;
  /** Unix milliseconds. */
  messageCreatedAt: number;
  /** Unix milliseconds. */
  createdAt: number;
}

const PREVIEW_MAX_CHARS = 240;

/**
 * Decode the on-disk message content (legacy plain string OR JSON-serialized
 * `ContentBlock[]`) into a single text string and cap it at
 * `PREVIEW_MAX_CHARS`. Without the decode step, modern rows would render as
 * raw JSON in the bookmark list.
 *
 * The row's own metadata decides what the preview may quote: a
 * `send_user_message` turn's plain text is private working notes, so the
 * preview shows the message the user actually read instead.
 */
function buildPreview(content: string, metadata: string | null): string {
  const text = stringifyMessageContent(
    projectPersistedRowText(content, metadata),
  );
  return text.length > PREVIEW_MAX_CHARS
    ? text.slice(0, PREVIEW_MAX_CHARS)
    : text;
}

/**
 * Shared SELECT shape used by the JOIN-based readers. Pulling this out
 * avoids duplicating the column list and the row-mapping below.
 */
function bookmarkJoinColumns(db: AsyncDb) {
  const { conversations, messageBookmarks, messages } = db.schema;
  return {
    id: messageBookmarks.id,
    messageId: messageBookmarks.messageId,
    conversationId: messageBookmarks.conversationId,
    createdAt: messageBookmarks.createdAt,
    conversationTitle: conversations.title,
    messageContent: messages.content,
    messageMetadata: messages.metadata,
    messageRole: messages.role,
    messageCreatedAt: messages.createdAt,
  } as const;
}

type BookmarkJoinRow = {
  id: string;
  messageId: string;
  conversationId: string;
  createdAt: number;
  conversationTitle: string | null;
  messageContent: string;
  messageMetadata: string | null;
  messageRole: string;
  messageCreatedAt: number;
};

function rowToSummary(row: BookmarkJoinRow): BookmarkSummary {
  return {
    id: row.id,
    messageId: row.messageId,
    conversationId: row.conversationId,
    conversationTitle: row.conversationTitle,
    messagePreview: buildPreview(row.messageContent, row.messageMetadata),
    messageRole: row.messageRole,
    messageCreatedAt: row.messageCreatedAt,
    createdAt: row.createdAt,
  };
}

/**
 * Join bookmarks against `messages` and `conversations` with the match
 * predicates in WHERE. Callers pass extra conditions through `filter`
 * because chaining `.where()` would replace the predicates.
 */
function selectBookmarkJoin(db: AsyncDb, filter?: SQL) {
  const { conversations, messageBookmarks, messages } = db.schema;
  const joinMatch = and(
    eq(messages.id, messageBookmarks.messageId),
    eq(conversations.id, messageBookmarks.conversationId),
  );
  return db.orm
    .select(bookmarkJoinColumns(db))
    .from(messageBookmarks)
    .crossJoin(messages)
    .crossJoin(conversations)
    .where(filter ? and(joinMatch, filter) : joinMatch);
}

/**
 * List all bookmarks newest-first, joined against `messages` and
 * `conversations`. Bookmarks whose parent message or conversation has
 * been deleted are naturally excluded by the join predicates; the
 * `ON DELETE CASCADE` on the FKs means rows should never end up in this
 * orphan state, but the join provides a defense-in-depth guarantee.
 */
export async function listBookmarks(): Promise<BookmarkSummary[]> {
  const db = requireMainDb();
  const rows = await selectBookmarkJoin(db).orderBy(
    desc(db.schema.messageBookmarks.createdAt),
  );
  return rows.map(rowToSummary);
}

/**
 * Discriminated result returned by {@link createBookmark}. `inserted`
 * distinguishes a brand-new row from an idempotent return of an existing
 * one, so callers can suppress side effects (e.g. `bookmark.created` SSE
 * publishes) on duplicate POSTs.
 */
export type CreateBookmarkResult =
  | { inserted: true; bookmark: BookmarkSummary }
  | { inserted: false; bookmark: BookmarkSummary };

/**
 * Create a bookmark for the given message and return a discriminated
 * result indicating whether a new row was actually inserted. Idempotent
 * on the unique `message_id` index: if a bookmark already exists for
 * `messageId`, the existing summary is returned with `inserted: false`.
 *
 * `conversationId` is derived from the message row rather than trusted from
 * the caller, so a buggy or malicious caller cannot persist a bookmark
 * whose `conversationId` disagrees with the message's actual conversation.
 */
export async function createBookmark(params: {
  messageId: string;
}): Promise<CreateBookmarkResult> {
  const db = requireMainDb();
  const { messageBookmarks, messages } = db.schema;
  const { messageId } = params;
  const [messageRow] = await db.orm
    .select({ conversationId: messages.conversationId })
    .from(messages)
    .where(eq(messages.id, messageId));
  const conversationId = messageRow?.conversationId ?? null;
  if (conversationId === null) {
    throw new Error(`Message ${messageId} not found`);
  }

  const [existing] = await db.orm
    .select({ id: messageBookmarks.id })
    .from(messageBookmarks)
    .where(eq(messageBookmarks.messageId, messageId));
  if (existing) {
    return {
      inserted: false,
      bookmark: await readBookmarkSummaryOrThrow(db, existing.id),
    };
  }

  const id = uuid();
  try {
    await db.orm
      .insert(messageBookmarks)
      .values({ id, messageId, conversationId, createdAt: Date.now() });
  } catch (err) {
    // Lost a race against a concurrent create. Fall back to fetch by
    // messageId so we still return the winning row.
    const [winner] = await db.orm
      .select({ id: messageBookmarks.id })
      .from(messageBookmarks)
      .where(eq(messageBookmarks.messageId, messageId));
    if (!winner) {
      throw err;
    }
    return {
      inserted: false,
      bookmark: await readBookmarkSummaryOrThrow(db, winner.id),
    };
  }
  return {
    inserted: true,
    bookmark: await readBookmarkSummaryOrThrow(db, id),
  };
}

async function readBookmarkSummaryOrThrow(
  db: AsyncDb,
  id: string,
): Promise<BookmarkSummary> {
  const [row] = await selectBookmarkJoin(
    db,
    eq(db.schema.messageBookmarks.id, id),
  );
  if (!row) {
    // Unreachable: caller just observed (or inserted) this id.
    throw new Error(`Bookmark ${id} disappeared between insert and read`);
  }
  return rowToSummary(row);
}

/**
 * Delete the bookmark (if any) attached to the given `messageId`.
 * Returns true iff a row was removed.
 *
 * Drizzle's delete statement does not expose a portable row count here, so
 * the existence check drives the result and the delete runs only when a
 * matching row is present.
 */
export async function deleteBookmarkByMessageId(
  messageId: string,
): Promise<boolean> {
  const db = requireMainDb();
  const { messageBookmarks } = db.schema;
  const [existed] = await db.orm
    .select({ id: messageBookmarks.id })
    .from(messageBookmarks)
    .where(eq(messageBookmarks.messageId, messageId));
  if (!existed) {
    return false;
  }
  await db.orm
    .delete(messageBookmarks)
    .where(eq(messageBookmarks.messageId, messageId));
  return true;
}
