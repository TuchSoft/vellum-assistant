/**
 * Contact reads for the prompt path.
 *
 * `buildSystemPrompt` and the persona resolver resolve the actor's contact
 * identity to choose the per-user persona file. Both read the identity mirror
 * from the main database through the async facade.
 */

import { and, eq, sql } from "drizzle-orm";

import type { ChannelId } from "../channels/types.js";
import { requireMainDb } from "../persistence/db-facade.js";
import { canonicalizeInboundIdentity } from "../util/canonicalize-identity.js";

/**
 * Resolve the `user_file` for a channel address, case-insensitively (`lower()`
 * matches the historical `COLLATE NOCASE` lookup). Returns null when no
 * channel or contact matches.
 */
export async function findContactByAddress(
  type: string,
  address: string,
): Promise<{ userFile: string | null } | null> {
  const canonical =
    canonicalizeInboundIdentity(type as ChannelId, address) ?? address;
  const db = requireMainDb();
  const contactChannels = db.schema.contactChannels;
  const contacts = db.schema.contacts;
  const [row] = await db.orm
    .select({ userFile: contacts.userFile })
    .from(contactChannels)
    .innerJoin(contacts, eq(contactChannels.contactId, contacts.id))
    .where(
      and(
        eq(contactChannels.type, type),
        sql`lower(${contactChannels.address}) = lower(${canonical})`,
      ),
    );
  if (!row) {
    return null;
  }
  return { userFile: row.userFile ?? null };
}
