import { eq } from "drizzle-orm";

import { requireMainDb } from "../../../../persistence/db-facade.js";
import { extractMediaBlocks } from "../message-media.js";
import type { ImageRef } from "./types.js";

/**
 * Load image data from the messages table for an ImageRef.
 * Returns null if the message or image block no longer exists
 * (e.g., conversation was deleted).
 */
export async function loadImageRefData(
  ref: ImageRef,
): Promise<{ data: Buffer; mimeType: string } | null> {
  const db = requireMainDb();
  const messages = db.schema.messages;
  const rows = await db.orm
    .select({ content: messages.content })
    .from(messages)
    // No completeness predicate: refs come from the extracted memory graph,
    // and extraction reads finalized rows only, so an unfinalized id cannot
    // reach here. Do not copy this shape for ids with other provenance.
    .where(eq(messages.id, ref.messageId));
  const msg = rows[0];
  if (!msg) {
    return null;
  }

  const mediaBlocks = await extractMediaBlocks(msg.content);
  const block = mediaBlocks.find((b) => b.index === ref.blockIndex);
  if (!block) {
    return null;
  }

  return { data: block.data, mimeType: block.mimeType };
}
