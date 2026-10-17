/**
 * Synchronous contact reads for the prompt path.
 *
 * `buildSystemPrompt` and the persona resolver are synchronous by design (the
 * plugin API exports `resolveUserName` synchronously), so they cannot await the
 * async contact store. This bridge reads the identity mirror from the SQLite
 * main database for that path only.
 *
 * Declared cross-slice edge: while the main slot flips to Postgres, this read
 * keeps using SQLite. It disappears when the prompt path is made async as part
 * of the conversations port.
 */

import { and, eq, sql } from "drizzle-orm";

import type { ChannelId } from "../channels/types.js";
import { getDb } from "../persistence/db-connection.js";
import { contactChannels, contacts } from "../persistence/schema/index.js";
import { canonicalizeInboundIdentity } from "../util/canonicalize-identity.js";

/**
 * Resolve the `user_file` for a channel address, case-insensitively (matching
 * the historical `COLLATE NOCASE` lookup). Returns null when no channel or
 * contact matches.
 */
export function findContactByAddressSync(
  type: string,
  address: string,
): { userFile: string | null } | null {
  const canonical =
    canonicalizeInboundIdentity(type as ChannelId, address) ?? address;
  const db = getDb();
  const row = db
    .select({ userFile: contacts.userFile })
    .from(contactChannels)
    .innerJoin(contacts, eq(contactChannels.contactId, contacts.id))
    .where(
      and(
        eq(contactChannels.type, type),
        sql`${contactChannels.address} = ${canonical} COLLATE NOCASE`,
      ),
    )
    .get();
  if (!row) {
    return null;
  }
  return { userFile: row.userFile ?? null };
}
