import { and, desc, eq, inArray } from "drizzle-orm";

import { requireMainDb } from "../../../persistence/db-facade.js";
import { MEMORY_RETROSPECTIVE_SOURCES } from "./memory-retrospective-constants.js";

const MAX_FORK_CHAIN_DEPTH = 16;

/**
 * Find the most recent memory-retrospective background conversation rooted
 * at `parentConversationId`. Used by the memory-retrospective job handler
 * to load the prior retrospective's `remember` calls into the new run's
 * `<already_remembered>` block — bounded source-of-truth for "what the
 * prior pass already saved" that scales as the source conversation grows.
 *
 * Walks up `forkParentConversationId` when no retrospective exists at the
 * current level. This lets a forked conversation inherit dedup context from
 * its source's most recent retro on the fork's *first* retrospective —
 * otherwise the fork would re-save every fact the source already retro'd.
 * Once the fork accumulates its own retros, those are found at the first
 * iteration and we never walk up.
 *
 * The returned `forkParentConversationId` is the conversation the
 * retrospective row is rooted at — `parentConversationId` itself when it has
 * its own retros, or an ancestor when the chain walk found the row higher
 * up. Callers that mutate the prior (e.g. GC of superseded runs) must check
 * it against the source conversation: an ancestor's row is that ancestor's
 * dedup baseline, not the caller's to delete.
 *
 * Returns `null` when no prior retrospective exists anywhere in the fork
 * chain (true first-run case).
 *
 * Hits `idx_conversations_fork_parent_conversation_id` for the
 * `forkParentConversationId` lookup.
 */
export async function findMostRecentRetrospectiveFor(
  parentConversationId: string,
): Promise<{ id: string; forkParentConversationId: string } | null> {
  const db = requireMainDb();
  const conversations = db.schema.conversations;
  let currentId: string | null = parentConversationId;
  for (let depth = 0; depth < MAX_FORK_CHAIN_DEPTH && currentId; depth++) {
    const rows = await db.orm
      .select({ id: conversations.id })
      .from(conversations)
      .where(
        and(
          inArray(conversations.source, MEMORY_RETROSPECTIVE_SOURCES),
          eq(conversations.forkParentConversationId, currentId),
        ),
      )
      .orderBy(desc(conversations.createdAt))
      .limit(1);
    const row = rows[0];
    if (row) {
      return { id: row.id, forkParentConversationId: currentId };
    }

    const parentRows = await db.orm
      .select({
        forkParentConversationId: conversations.forkParentConversationId,
      })
      .from(conversations)
      .where(eq(conversations.id, currentId));
    currentId = parentRows[0]?.forkParentConversationId ?? null;
  }
  return null;
}
