import { and, asc, desc, eq, sql } from "drizzle-orm";
import { v4 as uuid } from "uuid";

import type { ChannelId } from "../channels/types.js";
import {
  type AsyncDb,
  requireMainDb,
  type SchemaTables,
} from "../persistence/db-facade.js";
import { canonicalizeInboundIdentity } from "../util/canonicalize-identity.js";
import { recordContactTombstone } from "./mirror-tombstones.js";
import { notifyContactsChanged } from "./notify-contacts-changed.js";
import type {
  AssistantContactMetadata,
  Contact,
  ContactChannel,
  ContactType,
  ContactWithChannels,
} from "./types.js";

// ── Helpers ──────────────────────────────────────────────────────────

type ContactRow = SchemaTables["contacts"]["$inferSelect"];
type ContactChannelRow = SchemaTables["contactChannels"]["$inferSelect"];
type AssistantMetadataRow =
  SchemaTables["assistantContactMetadata"]["$inferSelect"];

/** Strip LIKE metacharacters so user input is matched literally. */
function escapeLike(value: string): string {
  return value.replace(/%/g, "").replace(/_/g, "");
}

/**
 * Find the first contact_channels row whose (type, address) matches.
 * `lower(...)` makes the comparison case-insensitive without depending on a
 * column collation, and matches the legacy lowercased rows (pre-migration
 * 290).
 */
async function findConflictingChannel(
  db: AsyncDb,
  type: string,
  address: string,
): Promise<ContactChannelRow | undefined> {
  const contactChannels = db.schema.contactChannels;
  const [row] = await db.orm
    .select()
    .from(contactChannels)
    .where(
      and(
        eq(contactChannels.type, type),
        sql`lower(${contactChannels.address}) = lower(${address})`,
      ),
    );
  return row;
}

/** Merge notes concat: survivor notes first, donor appended with \n,
 * empty result stored as null. */
function concatMergedNotes(
  keepNotes: string | null | undefined,
  donorNotes: string | null,
): string | null {
  return [keepNotes ?? null, donorNotes].filter(Boolean).join("\n") || null;
}

/**
 * Move donor channels onto the survivor, skipping any the survivor already
 * holds by logical (type, address) key. `lower(...)` catches legacy lowercased
 * rows. `touchUpdatedAt` stamps updated_at on moved rows.
 */
async function reparentDonorChannels(
  tx: AsyncDb,
  keepId: string,
  mergeId: string,
  touchUpdatedAt: number,
): Promise<void> {
  const contactChannels = tx.schema.contactChannels;
  const donorChannels = await tx.orm
    .select()
    .from(contactChannels)
    .where(eq(contactChannels.contactId, mergeId));

  for (const ch of donorChannels) {
    const [exists] = await tx.orm
      .select()
      .from(contactChannels)
      .where(
        and(
          eq(contactChannels.contactId, keepId),
          eq(contactChannels.type, ch.type),
          sql`lower(${contactChannels.address}) = lower(${ch.address})`,
        ),
      );

    if (!exists) {
      await tx.orm
        .update(contactChannels)
        .set({ contactId: keepId, updatedAt: touchUpdatedAt })
        .where(eq(contactChannels.id, ch.id));
    }
  }
}

/**
 * Pure slug transform applied to a display name. No DB lookup, no collision
 * handling — callers that need a collision-free filename should use
 * `generateUserFileSlug` instead. Exported so the migration classifier can
 * recompute the expected base slug for a given display name.
 */
export function computeUserFileBaseSlug(displayName: string): string {
  return (
    displayName
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-+|-+$/g, "")
      .slice(0, 100) || "user"
  );
}

/**
 * Generate a collision-free slugified filename for a contact's per-user persona file.
 * Produces filenames like "alice.md", "alice-2.md", "alice-3.md", etc.
 */
export async function generateUserFileSlug(
  displayName: string,
  conn?: AsyncDb,
): Promise<string> {
  const slug = computeUserFileBaseSlug(displayName);

  const db = conn ?? requireMainDb();
  const contacts = db.schema.contacts;
  const rows = await db.orm
    .select({ userFile: contacts.userFile })
    .from(contacts)
    .where(
      sql`lower(${contacts.userFile}) LIKE lower(${`${escapeLike(slug)}%`})`,
    );

  const taken = new Set(rows.map((r) => r.userFile?.toLowerCase()));

  const base = `${slug}.md`;
  if (!taken.has(base)) {
    return base;
  }

  for (let i = 2; ; i++) {
    const candidate = `${slug}-${i}.md`;
    if (!taken.has(candidate)) {
      return candidate;
    }
  }
}

function parseContact(row: ContactRow): Contact {
  return {
    id: row.id,
    displayName: row.displayName,
    notes: row.notes,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
    contactType: row.contactType,
    userFile: row.userFile ?? null,
  };
}

function parseChannel(row: ContactChannelRow): ContactChannel {
  return {
    id: row.id,
    contactId: row.contactId,
    type: row.type,
    address: row.address,
    isPrimary: row.isPrimary,
    externalChatId: row.externalChatId,
    updatedAt: row.updatedAt,
    createdAt: row.createdAt,
  };
}

async function getChannelsForContact(
  contactId: string,
  conn?: AsyncDb,
): Promise<ContactChannel[]> {
  const db = conn ?? requireMainDb();
  const contactChannels = db.schema.contactChannels;
  const rows = await db.orm
    .select()
    .from(contactChannels)
    .where(eq(contactChannels.contactId, contactId))
    .orderBy(desc(contactChannels.isPrimary), asc(contactChannels.createdAt));
  return rows.map(parseChannel);
}

async function withChannels(
  contact: Contact,
  conn?: AsyncDb,
): Promise<ContactWithChannels> {
  const channels = await getChannelsForContact(contact.id, conn);
  return { ...contact, channels };
}

// ── Channel data type for syncChannels ───────────────────────────────

interface SyncChannelData {
  /** Explicit gateway-minted channel id. Lets the identity mirror key the
   *  channel identically in both stores; omit to mint one. When a row with this
   *  id already exists it is updated in place (address/owner rebind), so a
   *  gateway re-auth is mirrored rather than colliding on the id. */
  id?: string;
  type: string;
  address: string;
  isPrimary?: boolean;
  externalChatId?: string | null;
}

// ── CRUD ─────────────────────────────────────────────────────────────

/** Retrieve a contact by ID. */
export async function getContact(
  id: string,
  conn?: AsyncDb,
): Promise<ContactWithChannels | null> {
  const db = conn ?? requireMainDb();
  const contacts = db.schema.contacts;
  const [row] = await db.orm.select().from(contacts).where(eq(contacts.id, id));
  if (!row) {
    return null;
  }
  return withChannels(parseContact(row), conn);
}

/** INFO-only contact fields, joined locally by contact ID. */
export interface ContactInfo {
  notes: string | null;
}

/**
 * Look up a contact's INFO `notes` field by ID.
 *
 * Carries no ACL state (status/policy/verification) or interaction telemetry —
 * those are owned by the gateway (ACL via the stamped trust verdict, telemetry
 * via the verdict/rich reads). Returns null when the contact does not exist.
 */
export async function findContactInfoById(
  contactId: string,
): Promise<ContactInfo | null> {
  const contact = await getContact(contactId);
  if (!contact) {
    return null;
  }
  return {
    notes: contact.notes,
  };
}

/**
 * Look up a single contact channel by its primary key.
 * Returns the parsed channel row, or null if it does not exist.
 */
export async function getChannelById(
  channelId: string,
): Promise<ContactChannel | null> {
  const db = requireMainDb();
  const contactChannels = db.schema.contactChannels;
  const [row] = await db.orm
    .select()
    .from(contactChannels)
    .where(eq(contactChannels.id, channelId));
  return row ? parseChannel(row) : null;
}

export async function upsertContact(
  params: {
    id?: string;
    displayName: string;
    notes?: string | null;
    contactType?: ContactType;
    userFile?: string | null;
    /** userFile to seed ONLY when inserting a new contact; ignored on update so
     *  an existing persona-file pointer is never clobbered. Used by the identity
     *  mirror to create faithful null-user_file stubs. `userFile` takes
     *  precedence when both are supplied. */
    userFileOnCreate?: string | null;
    /** contactType to seed ONLY when inserting a new contact; ignored on update
     *  (and on channel-identity adoption) so a guardian-curated classification
     *  is never clobbered by an inbound seed. `contactType` takes precedence
     *  when both are supplied. */
    contactTypeOnCreate?: ContactType;
    /** notes to seed ONLY when inserting a new contact; ignored on update (and
     *  on channel-identity adoption) so guardian-authored notes are never
     *  clobbered by an inbound seed. `notes` takes precedence when both are
     *  supplied. */
    notesOnCreate?: string | null;
    channels?: SyncChannelData[];
    /** When true, conflicting channels on other contacts are reassigned to this
     *  contact instead of being skipped. Used by invite redemption to bind a
     *  redeemer's existing channel identity to the invite's target contact. */
    reassignConflictingChannels?: boolean;
  },
  conn?: AsyncDb,
): Promise<ContactWithChannels & { created: boolean }> {
  const db = conn ?? requireMainDb();
  const contacts = db.schema.contacts;
  const now = Date.now();

  // Canonicalize all channel addresses up front so every downstream path
  // (lookups, inserts, conflict checks) uses the canonical form.
  const canonicalChannels = params.channels?.map((ch) => ({
    ...ch,
    address:
      canonicalizeInboundIdentity(ch.type as ChannelId, ch.address) ??
      ch.address,
  }));

  let contactId = params.id;

  // If an ID is provided, check if the contact exists for update
  if (contactId) {
    const [existing] = await db.orm
      .select()
      .from(contacts)
      .where(eq(contacts.id, contactId));
    if (existing) {
      const updateSet: Record<string, unknown> = {
        displayName: params.displayName,
        updatedAt: now,
      };
      if (params.notes !== undefined) {
        updateSet.notes = params.notes;
      }
      if (params.contactType !== undefined) {
        updateSet.contactType = params.contactType;
      }
      if (params.userFile !== undefined) {
        updateSet.userFile = params.userFile;
      }

      await db.orm
        .update(contacts)
        .set(updateSet)
        .where(eq(contacts.id, contactId));

      if (canonicalChannels) {
        await syncChannels(
          contactId,
          canonicalChannels,
          now,
          params.reassignConflictingChannels,
          db,
        );
      }

      notifyContactsChanged();
      return { ...(await getContact(contactId, db))!, created: false };
    }
  }

  // Try to find by channel canonical identity to avoid duplicates. This also
  // covers an explicit-id CREATE (the id was not found above) when the caller
  // did not opt into reassignment: syncChannels would skip a channel owned by
  // another contact, so inserting the supplied id would mint a channel-less
  // duplicate of that contact. Adopting the existing owner instead keeps one
  // contact per channel identity; the supplied id is dropped, and the
  // *OnCreate record fields never apply here. Reassigning callers (invite
  // binding, the guardian bootstrap mirror) skip this and keep their
  // bind-to-target semantics.
  if (
    canonicalChannels &&
    canonicalChannels.length > 0 &&
    (!contactId || !params.reassignConflictingChannels)
  ) {
    for (const ch of canonicalChannels) {
      const existingChannel = await findConflictingChannel(
        db,
        ch.type,
        ch.address,
      );

      if (existingChannel) {
        contactId = existingChannel.contactId;
        const updateSet: Record<string, unknown> = {
          displayName: params.displayName,
          updatedAt: now,
        };
        if (params.notes !== undefined) {
          updateSet.notes = params.notes;
        }
        if (params.contactType !== undefined) {
          updateSet.contactType = params.contactType;
        }
        if (params.userFile !== undefined) {
          updateSet.userFile = params.userFile;
        }

        await db.orm
          .update(contacts)
          .set(updateSet)
          .where(eq(contacts.id, contactId));

        await syncChannels(contactId, canonicalChannels, now, undefined, db);
        notifyContactsChanged();
        return { ...(await getContact(contactId, db))!, created: false };
      }
    }
  }

  // Create new contact
  contactId = contactId ?? uuid();
  const resolvedUserFile =
    params.userFile !== undefined
      ? params.userFile
      : params.userFileOnCreate !== undefined
        ? params.userFileOnCreate
        : await generateUserFileSlug(params.displayName, db);
  await db.orm.insert(contacts).values({
    id: contactId,
    displayName: params.displayName,
    notes: params.notes ?? params.notesOnCreate ?? null,
    contactType: params.contactType ?? params.contactTypeOnCreate ?? "human",
    userFile: resolvedUserFile,
    createdAt: now,
    updatedAt: now,
  });

  if (canonicalChannels) {
    await syncChannels(
      contactId,
      canonicalChannels,
      now,
      params.reassignConflictingChannels,
      db,
    );
  }

  notifyContactsChanged();
  return { ...(await getContact(contactId, db))!, created: true };
}

/**
 * Delete a contact row (channels cascade via FK). Info-only: the gateway DB is
 * the ACL source of truth, so this only removes the local identity mirror. A
 * missing row is a harmless no-op.
 */
export async function deleteContact(id: string, conn?: AsyncDb): Promise<void> {
  const db = conn ?? requireMainDb();
  const contacts = db.schema.contacts;
  await db.orm.delete(contacts).where(eq(contacts.id, id));
  // The mirror reconciler must not resurrect this id from a gateway snapshot
  // pulled before the delete.
  recordContactTombstone(id);
  notifyContactsChanged();
}

/**
 * Add new channels to a contact without removing existing ones.
 * When a channel already exists (same type+address), refreshes its identity
 * fields (address casing, isPrimary, externalChatId) if provided. Skips
 * channels owned by a different contact unless reassignment is requested.
 */
async function syncChannels(
  contactId: string,
  channels: SyncChannelData[],
  now: number,
  reassignConflicting?: boolean,
  conn?: AsyncDb,
): Promise<void> {
  const db = conn ?? requireMainDb();
  const contactChannels = db.schema.contactChannels;

  for (const ch of channels) {
    // Identity-mirror update-by-id: when the caller supplies the gateway's
    // authoritative channel id and that row already exists, update it in place.
    // The gateway can rebind the row's address (guardian re-auth) or owner
    // (claimed channel) under a stable id, so a match by (contactId,type,address)
    // would miss it and a fresh insert would collide on the primary key.
    if (ch.id) {
      const [byId] = await db.orm
        .select()
        .from(contactChannels)
        .where(eq(contactChannels.id, ch.id));
      if (byId) {
        const crossContact = byId.contactId !== contactId;
        // Never steal a channel the gateway left under another contact unless
        // the caller opts into reassignment (mirrors the address-conflict path).
        if (crossContact && !reassignConflicting) {
          continue;
        }

        const updateSet: Record<string, unknown> = { updatedAt: now };
        if (byId.address !== ch.address) {
          // Rebinding to a new address: a DIFFERENT row may already hold
          // (type, new-address), and idx_contact_channels_type_address would
          // reject the move. Resolve it the same way the (contactId,type,address)
          // path does — findConflictingChannel + the reassign gate. When
          // reassigning, adopt the (type,address) identity onto this
          // gateway-keyed row by removing the stale duplicate; otherwise leave
          // the address so the existing mapping stands (onConflictDoNothing).
          const conflicting = await findConflictingChannel(
            db,
            ch.type,
            ch.address,
          );
          if (conflicting && conflicting.id !== ch.id) {
            if (reassignConflicting) {
              await db.orm
                .delete(contactChannels)
                .where(eq(contactChannels.id, conflicting.id));
              updateSet.address = ch.address;
            }
          } else {
            updateSet.address = ch.address;
          }
        }
        if (crossContact) {
          updateSet.contactId = contactId;
        }
        if (ch.isPrimary !== undefined) {
          updateSet.isPrimary = ch.isPrimary;
        }
        if (ch.externalChatId !== undefined) {
          updateSet.externalChatId = ch.externalChatId;
        }

        await db.orm
          .update(contactChannels)
          .set(updateSet)
          .where(eq(contactChannels.id, ch.id));
        continue;
      }
    }

    // Match by (type, address) — the canonical identity for all channel types.
    // `lower(...)` catches legacy rows that were lowercased by old write paths.
    const [existing] = await db.orm
      .select()
      .from(contactChannels)
      .where(
        and(
          eq(contactChannels.contactId, contactId),
          eq(contactChannels.type, ch.type),
          sql`lower(${contactChannels.address}) = lower(${ch.address})`,
        ),
      );

    if (existing) {
      const updateSet: Record<string, unknown> = {};
      // Adopt a caller-supplied (gateway-minted) id onto a row still keyed
      // by a divergent legacy id: the byId lookup above missed, so the id is
      // free, and aligning it converges the two stores' keys (id-keyed
      // gateway read-backs and client PATCHes then resolve directly).
      // Nothing daemon-side persists a mirror channel id elsewhere, and
      // readers holding the old id already fall back to the (type, address)
      // logical key, so the swap only removes divergence.
      if (ch.id && ch.id !== existing.id) {
        updateSet.id = ch.id;
      }
      // Self-heal legacy lowercased addresses to canonical form.
      if (existing.address !== ch.address) {
        updateSet.address = ch.address;
      }
      if (ch.isPrimary !== undefined) {
        updateSet.isPrimary = ch.isPrimary;
      }
      if (ch.externalChatId !== undefined) {
        updateSet.externalChatId = ch.externalChatId;
      }

      if (Object.keys(updateSet).length > 0) {
        updateSet.updatedAt = now;
        await db.orm
          .update(contactChannels)
          .set(updateSet)
          .where(eq(contactChannels.id, existing.id));
      }
      continue;
    }

    // Check if this channel's canonical identity conflicts with another contact.
    const conflicting = await findConflictingChannel(db, ch.type, ch.address);

    if (conflicting) {
      if (reassignConflicting) {
        // Reassign the channel to the target contact. Used by invite redemption
        // to bind a redeemer's existing channel identity to the invite's target.
        const reassignSet: Record<string, unknown> = {
          contactId,
          updatedAt: now,
        };
        // Adopt the caller-supplied (gateway-minted) id in the same write:
        // the byId lookup above missed, so the id is free (same rationale as
        // the same-contact adopt branch).
        if (ch.id && ch.id !== conflicting.id) {
          reassignSet.id = ch.id;
        }
        if (ch.externalChatId !== undefined) {
          reassignSet.externalChatId = ch.externalChatId;
        }
        if (ch.isPrimary !== undefined) {
          reassignSet.isPrimary = ch.isPrimary;
        }

        await db.orm
          .update(contactChannels)
          .set(reassignSet)
          .where(eq(contactChannels.id, conflicting.id));
      }
      // When not reassigning, skip to avoid unique constraint violation.
      // The caller should use contact_merge to combine the two contacts.
      continue;
    }

    await db.orm.insert(contactChannels).values({
      id: ch.id ?? uuid(),
      contactId,
      type: ch.type,
      address: ch.address,
      isPrimary: ch.isPrimary ?? false,
      externalChatId: ch.externalChatId ?? null,
      createdAt: now,
      updatedAt: now,
    });
  }
}

export async function searchContacts(params: {
  query?: string;
  channelAddress?: string;
  channelType?: string;
  contactType?: ContactType;
  limit?: number;
}): Promise<ContactWithChannels[]> {
  const db = requireMainDb();
  const contacts = db.schema.contacts;
  const contactChannels = db.schema.contactChannels;
  const limit = Math.max(1, Math.min(params.limit ?? 20, 100));

  // Search by channel address first (exact or partial match)
  if (params.channelAddress) {
    const escapedAddress = escapeLike(params.channelAddress);
    if (!escapedAddress) {
      return [];
    }
    const channelRows = await db.orm
      .select({ contactId: contactChannels.contactId })
      .from(contactChannels)
      .innerJoin(contacts, eq(contactChannels.contactId, contacts.id))
      .where(
        params.channelType
          ? and(
              eq(contactChannels.type, params.channelType),
              sql`lower(${contactChannels.address}) LIKE lower(${`%${escapedAddress}%`})`,
            )
          : and(
              sql`lower(${contactChannels.address}) LIKE lower(${`%${escapedAddress}%`})`,
            ),
      );

    const contactIds = [...new Set(channelRows.map((r) => r.contactId))];
    if (contactIds.length === 0) {
      return [];
    }

    // Pre-compute the sanitized query for display-name filtering so the
    // loop body stays cheap.
    const sanitizedQuery = params.query
      ? escapeLike(params.query).toLowerCase()
      : undefined;

    const results: ContactWithChannels[] = [];
    for (const id of contactIds) {
      if (results.length >= limit) {
        break;
      }
      const contact = await getContact(id);
      if (
        contact &&
        (!params.contactType || contact.contactType === params.contactType) &&
        (!sanitizedQuery ||
          (contact.displayName &&
            contact.displayName.toLowerCase().includes(sanitizedQuery)))
      ) {
        results.push(contact);
      }
    }
    return results;
  }

  // Search by channel type alone (no address)
  if (params.channelType && !params.query) {
    const channelRows = await db.orm
      .select({ contactId: contactChannels.contactId })
      .from(contactChannels)
      .innerJoin(contacts, eq(contactChannels.contactId, contacts.id))
      .where(eq(contactChannels.type, params.channelType));

    const contactIds = [...new Set(channelRows.map((r) => r.contactId))];
    if (contactIds.length === 0) {
      return [];
    }

    const results: ContactWithChannels[] = [];
    for (const id of contactIds) {
      if (results.length >= limit) {
        break;
      }
      const contact = await getContact(id);
      if (
        contact &&
        (!params.contactType || contact.contactType === params.contactType)
      ) {
        results.push(contact);
      }
    }
    return results;
  }

  // Search by display name, optionally filtered by channelType
  const conditions = [];
  if (params.query) {
    const sanitized = escapeLike(params.query);
    if (!sanitized && !params.contactType) {
      return [];
    }
    if (sanitized) {
      conditions.push(
        sql`lower(${contacts.displayName}) LIKE lower(${`%${sanitized}%`})`,
      );
    }
  }
  if (params.contactType) {
    conditions.push(eq(contacts.contactType, params.contactType));
  }
  if (params.channelType) {
    conditions.push(eq(contactChannels.type, params.channelType));
  }

  const whereClause =
    conditions.length > 1 ? and(...conditions) : conditions[0];

  // Join with contactChannels when channelType is specified so the filter
  // can reference the channel table; otherwise query contacts alone.
  if (params.channelType) {
    const rows = await db.orm
      .select({ contactId: contacts.id })
      .from(contacts)
      .innerJoin(contactChannels, eq(contacts.id, contactChannels.contactId))
      .where(whereClause)
      .orderBy(desc(contacts.updatedAt));

    const contactIds = [...new Set(rows.map((r) => r.contactId))];
    if (contactIds.length === 0) {
      return [];
    }

    const results: ContactWithChannels[] = [];
    for (const id of contactIds) {
      if (results.length >= limit) {
        break;
      }
      const contact = await getContact(id);
      if (contact) {
        results.push(contact);
      }
    }
    return results;
  }

  const rows = await db.orm
    .select()
    .from(contacts)
    .where(whereClause)
    .orderBy(desc(contacts.updatedAt))
    .limit(limit);

  return Promise.all(rows.map(async (r) => withChannels(parseContact(r))));
}

export async function listContacts(
  limit = 50,
  contactType?: ContactType,
  opts?: { uncapped?: boolean },
): Promise<ContactWithChannels[]> {
  const db = requireMainDb();
  const contacts = db.schema.contacts;
  const effectiveLimit = opts?.uncapped ? limit : Math.min(limit, 200);
  const rows = await db.orm
    .select()
    .from(contacts)
    .where(contactType ? eq(contacts.contactType, contactType) : undefined)
    .orderBy(desc(contacts.updatedAt))
    .limit(effectiveLimit);
  return Promise.all(rows.map(async (r) => withChannels(parseContact(r))));
}

/**
 * Identity-mirror merge for the gateway's `contacts_mirror_merge_contact` op:
 * concat donor notes onto the survivor (notes-only — never clobbers the
 * survivor's display name), reparent donor channels by (type, address
 * case-insensitive), delete the donor. One transaction. A donor already gone
 * is a no-op (idempotent gateway retry); a survivor missing from the mirror
 * (mirror drift) is inserted with the combined notes so donor notes survive
 * the delete.
 */
export async function mergeContactMirror(params: {
  keepContactId: string;
  mergeContactId: string;
  keepDisplayName: string;
  resolvedUserFile?: string;
}): Promise<void> {
  const db = requireMainDb();

  const applied = await db.transaction(async (tx) => {
    const contacts = tx.schema.contacts;
    const [donor] = await tx.orm
      .select()
      .from(contacts)
      .where(eq(contacts.id, params.mergeContactId));
    if (!donor) {
      return false;
    }

    const now = Date.now();
    const [survivor] = await tx.orm
      .select()
      .from(contacts)
      .where(eq(contacts.id, params.keepContactId));
    const combined = concatMergedNotes(survivor?.notes, donor.notes);

    if (survivor) {
      await tx.orm
        .update(contacts)
        .set({ notes: combined, updatedAt: now })
        .where(eq(contacts.id, params.keepContactId));
    } else {
      await tx.orm.insert(contacts).values({
        id: params.keepContactId,
        displayName: params.keepDisplayName,
        notes: combined,
        contactType: "human",
        userFile: params.resolvedUserFile ?? null,
        createdAt: now,
        updatedAt: now,
      });
    }

    // Move donor channels to the survivor, skipping duplicates by logical key.
    await reparentDonorChannels(
      tx,
      params.keepContactId,
      params.mergeContactId,
      now,
    );

    // Delete the donor (cascade removes remaining duplicate channels).
    await tx.orm.delete(contacts).where(eq(contacts.id, params.mergeContactId));
    recordContactTombstone(params.mergeContactId);
    return true;
  });

  if (applied) {
    notifyContactsChanged();
  }
}

/**
 * Full identity-mirror upsert for the gateway's `contacts_mirror_upsert_full`
 * op. One transaction:
 *
 * - Existing contact: sparse omit-to-preserve UPDATE — only provided fields
 *   change (a partial upsert can't clobber notes/contact_type or revert a
 *   curated display name).
 * - Missing contact: INSERT with a generated collision-free user_file slug
 *   (display name falls back to the first channel address, then "Unknown").
 * - `assistant_contact_metadata` is upserted only for assistant-type contacts.
 * - Channels: an existing (type, address case-insensitive) row on this contact
 *   gets an omit-to-preserve external_chat_id refresh; an address owned by
 *   ANOTHER contact is skipped (never stolen); a new row adopts the
 *   gateway-minted channel id so both stores share one canonical id.
 */
export async function upsertContactMirrorFull(params: {
  contactId: string;
  displayName?: string;
  notes?: string | null;
  contactType?: ContactType;
  assistantMetadata?: {
    species: string;
    metadata?: Record<string, unknown> | null;
  };
  channels?: {
    id?: string;
    type: string;
    address: string;
    isPrimary?: boolean;
    externalChatId?: string | null;
  }[];
}): Promise<void> {
  const db = requireMainDb();

  await db.transaction(async (tx) => {
    const contacts = tx.schema.contacts;
    const contactChannels = tx.schema.contactChannels;
    const assistantContactMetadata = tx.schema.assistantContactMetadata;
    const now = Date.now();
    const [existing] = await tx.orm
      .select()
      .from(contacts)
      .where(eq(contacts.id, params.contactId));

    if (existing) {
      const updateSet: Record<string, unknown> = { updatedAt: now };
      if (params.displayName !== undefined) {
        updateSet.displayName = params.displayName;
      }
      if (params.notes !== undefined) {
        updateSet.notes = params.notes;
      }
      if (params.contactType !== undefined) {
        updateSet.contactType = params.contactType;
      }
      await tx.orm
        .update(contacts)
        .set(updateSet)
        .where(eq(contacts.id, params.contactId));
    } else {
      const displayName =
        params.displayName ?? params.channels?.[0]?.address ?? "Unknown";
      await tx.orm.insert(contacts).values({
        id: params.contactId,
        displayName,
        notes: params.notes ?? null,
        contactType: params.contactType ?? "human",
        userFile: await generateUserFileSlug(displayName),
        createdAt: now,
        updatedAt: now,
      });
    }

    if (params.contactType === "assistant" && params.assistantMetadata) {
      const metadataJson =
        params.assistantMetadata.metadata != null
          ? JSON.stringify(params.assistantMetadata.metadata)
          : null;
      await tx.orm
        .insert(assistantContactMetadata)
        .values({
          contactId: params.contactId,
          species: params.assistantMetadata.species,
          metadata: metadataJson,
        })
        .onConflictDoUpdate({
          target: assistantContactMetadata.contactId,
          set: {
            species: params.assistantMetadata.species,
            metadata: metadataJson,
          },
        });
    }

    for (const ch of params.channels ?? []) {
      const [existingCh] = await tx.orm
        .select()
        .from(contactChannels)
        .where(
          and(
            eq(contactChannels.contactId, params.contactId),
            eq(contactChannels.type, ch.type),
            sql`lower(${contactChannels.address}) = lower(${ch.address})`,
          ),
        );

      if (existingCh) {
        // Omit-to-preserve external_chat_id; is_primary is never rewritten
        // on an existing channel.
        const updateSet: Record<string, unknown> = { updatedAt: now };
        if (ch.externalChatId !== undefined) {
          updateSet.externalChatId = ch.externalChatId;
        }
        await tx.orm
          .update(contactChannels)
          .set(updateSet)
          .where(eq(contactChannels.id, existingCh.id));
        continue;
      }

      // Address owned by ANOTHER contact is never stolen.
      if (await findConflictingChannel(tx, ch.type, ch.address)) {
        continue;
      }

      await tx.orm.insert(contactChannels).values({
        id: ch.id ?? uuid(),
        contactId: params.contactId,
        type: ch.type,
        address: ch.address,
        isPrimary: ch.isPrimary ?? false,
        externalChatId: ch.externalChatId ?? null,
        createdAt: now,
        updatedAt: now,
      });
    }
  });

  notifyContactsChanged();
}

/**
 * Find a contact by a specific channel address. Returns null if not found.
 * Canonicalizes the address before querying. `lower(...)` matches legacy
 * lowercased rows that migration 290 couldn't restore.
 */
export async function findContactByAddress(
  type: string,
  address: string,
  conn?: AsyncDb,
): Promise<ContactWithChannels | null> {
  const canonical =
    canonicalizeInboundIdentity(type as ChannelId, address) ?? address;
  const db = conn ?? requireMainDb();
  const contactChannels = db.schema.contactChannels;
  const [channel] = await db.orm
    .select()
    .from(contactChannels)
    .where(
      and(
        eq(contactChannels.type, type),
        sql`lower(${contactChannels.address}) = lower(${canonical})`,
      ),
    );

  if (!channel) {
    return null;
  }
  return getContact(channel.contactId, conn);
}

/**
 * Find a contact by channel external chat ID. Fallback for callers that only
 * have a chat ID (no user-level address) — matches by (type, externalChatId).
 * No unique constraint exists on externalChatId, so ORDER BY is needed for a
 * deterministic pick; channel ranking (status) is owned by the gateway now.
 */
async function findContactByChannelExternalChatId(
  channelType: string,
  externalChatId: string,
  conn?: AsyncDb,
): Promise<ContactWithChannels | null> {
  const db = conn ?? requireMainDb();
  const contactChannels = db.schema.contactChannels;
  const [channel] = await db.orm
    .select()
    .from(contactChannels)
    .where(
      and(
        eq(contactChannels.type, channelType),
        eq(contactChannels.externalChatId, externalChatId),
      ),
    )
    .orderBy(desc(contactChannels.updatedAt), desc(contactChannels.createdAt));
  if (!channel) {
    return null;
  }
  return getContact(channel.contactId, conn);
}

/**
 * Find a contact and matching channel by trying address first, then
 * falling back to externalChatId. Mirrors the findMember lookup strategy.
 */
export async function findContactChannel(
  params: {
    channelType: string;
    address?: string;
    externalChatId?: string;
  },
  conn?: AsyncDb,
): Promise<{
  contact: ContactWithChannels;
  channel: ContactChannel;
} | null> {
  if (params.address) {
    const canonical =
      canonicalizeInboundIdentity(
        params.channelType as ChannelId,
        params.address,
      ) ?? params.address;
    const contact = await findContactByAddress(
      params.channelType,
      canonical,
      conn,
    );
    if (contact) {
      const ch = contact.channels.find(
        (c) =>
          c.type === params.channelType &&
          c.address.toLowerCase() === canonical.toLowerCase(),
      );
      if (ch) {
        return { contact, channel: ch };
      }
    }
  }
  if (params.externalChatId) {
    const contact = await findContactByChannelExternalChatId(
      params.channelType,
      params.externalChatId,
      conn,
    );
    if (contact) {
      const ch = contact.channels.find(
        (c) =>
          c.type === params.channelType &&
          c.externalChatId === params.externalChatId,
      );
      if (ch) {
        return { contact, channel: ch };
      }
    }
  }
  return null;
}

/**
 * Repair a channel's identity address, e.g. when a guardian JWT principal no
 * longer matches the stored channel address after a DB reset. Identity-only:
 * the principalId ACL column is gateway-owned.
 *
 * Returns false if the update would violate the unique (type, address)
 * constraint on contact_channels — e.g. when the incoming address already
 * exists on another channel record (a revoked former guardian entry).
 * In that case the repair is skipped and trust stays `unknown`.
 */
export async function repairChannelAddress(
  channelId: string,
  newAddress: string,
): Promise<boolean> {
  const db = requireMainDb();
  const contactChannels = db.schema.contactChannels;
  const now = Date.now();
  // Look up the channel we're about to update so we know its type.
  const [channel] = await db.orm
    .select()
    .from(contactChannels)
    .where(eq(contactChannels.id, channelId));
  if (!channel) {
    return false;
  }

  // Guard: check if another channel row holds this canonical identity.
  const conflicting = await findConflictingChannel(
    db,
    channel.type,
    newAddress,
  );

  if (conflicting && conflicting.id !== channelId) {
    return false;
  }

  await db.orm
    .update(contactChannels)
    .set({
      address: newAddress,
      updatedAt: now,
    })
    .where(eq(contactChannels.id, channelId));

  notifyContactsChanged();
  return true;
}

// ── Assistant Contact Metadata ──────────────────────────────────────

function parseAssistantMetadata(
  row: AssistantMetadataRow,
): AssistantContactMetadata {
  // Species–metadata pairing is enforced at write time; the cast bridges the
  // runtime DB row into the compile-time discriminated union.
  return {
    contactId: row.contactId,
    species: row.species,
    metadata: row.metadata ? JSON.parse(row.metadata) : null,
  } as AssistantContactMetadata;
}

export async function getAssistantContactMetadata(
  contactId: string,
): Promise<AssistantContactMetadata | null> {
  const db = requireMainDb();
  const assistantContactMetadata = db.schema.assistantContactMetadata;
  const [row] = await db.orm
    .select()
    .from(assistantContactMetadata)
    .where(eq(assistantContactMetadata.contactId, contactId));

  if (!row) {
    return null;
  }
  return parseAssistantMetadata(row);
}
