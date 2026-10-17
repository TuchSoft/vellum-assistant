/**
 * Store for daemon-local A2A invites.
 *
 * A2A invites bind a placeholder assistant contact to a shareable token used
 * for link-based peer-assistant connection. Each invite carries a SHA-256
 * hashed token. The raw token is returned exactly once at creation time and
 * never stored.
 */

import { randomUUID } from "node:crypto";

import { generateInviteToken, hashInviteToken } from "@vellumai/gateway-client";
import { and, eq } from "drizzle-orm";

import type { SchemaTables } from "./db-facade.js";
import { requireMainDb } from "./db-facade.js";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type A2aInviteStatus = "active" | "redeemed" | "revoked" | "expired";

export interface A2aInvite {
  id: string;
  tokenHash: string;
  contactId: string;
  maxUses: number;
  useCount: number;
  expiresAt: number;
  status: A2aInviteStatus;
  redeemedByExternalUserId: string | null;
  redeemedAt: number | null;
  createdAt: number;
  updatedAt: number;
}

type A2aInviteRow = SchemaTables["a2aInvites"]["$inferSelect"];

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const DEFAULT_EXPIRY_MS = 7 * 24 * 60 * 60 * 1000; // 7 days

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function rowToInvite(row: A2aInviteRow): A2aInvite {
  return { ...row, status: row.status as A2aInviteStatus };
}

async function findByTokenHash(tokenHash: string): Promise<A2aInvite | null> {
  const db = requireMainDb();
  const a2aInvites = db.schema.a2aInvites;
  const rows = await db.orm
    .select()
    .from(a2aInvites)
    .where(eq(a2aInvites.tokenHash, tokenHash));
  return rows[0] ? rowToInvite(rows[0]) : null;
}

/**
 * Transition an invite's status to 'expired' in storage. Safe to call even if
 * the invite is already expired. The WHERE clause scopes the update to
 * 'active' rows so it becomes a no-op in that case.
 */
async function markExpired(inviteId: string): Promise<void> {
  const db = requireMainDb();
  const a2aInvites = db.schema.a2aInvites;
  await db.orm
    .update(a2aInvites)
    .set({ status: "expired", updatedAt: Date.now() })
    .where(and(eq(a2aInvites.id, inviteId), eq(a2aInvites.status, "active")));
}

/**
 * Increment an invite's use count and record redemption metadata. Returns
 * `true` if the use was recorded, or `false` if the invite was concurrently
 * revoked/expired (the WHERE clause constrains to `status = 'active'` so a
 * stale write is impossible).
 */
async function recordUse(params: {
  inviteId: string;
  redeemedByExternalUserId: string;
}): Promise<boolean> {
  const db = requireMainDb();
  const a2aInvites = db.schema.a2aInvites;
  const now = Date.now();

  const rows = await db.orm
    .select()
    .from(a2aInvites)
    .where(eq(a2aInvites.id, params.inviteId));

  const invite = rows[0];
  if (!invite) {
    return false;
  }

  const newUseCount = invite.useCount + 1;
  const newStatus = newUseCount >= invite.maxUses ? "redeemed" : "active";

  // The WHERE clause constrains to status = 'active', so a concurrent
  // revoke/expire prevents the update and the returning rows stay empty.
  const updated = await db.orm
    .update(a2aInvites)
    .set({
      useCount: newUseCount,
      status: newStatus,
      redeemedByExternalUserId: params.redeemedByExternalUserId,
      redeemedAt: now,
      updatedAt: now,
    })
    .where(and(eq(a2aInvites.id, invite.id), eq(a2aInvites.status, "active")))
    .returning({ id: a2aInvites.id });

  return updated.length > 0;
}

// ---------------------------------------------------------------------------
// createA2aInvite
// ---------------------------------------------------------------------------

export async function createA2aInvite(params: {
  contactId: string;
  maxUses?: number;
  expiresInMs?: number;
}): Promise<{ invite: A2aInvite; rawToken: string }> {
  const db = requireMainDb();
  const a2aInvites = db.schema.a2aInvites;
  const now = Date.now();
  const rawToken = generateInviteToken();

  const row = {
    id: randomUUID(),
    tokenHash: hashInviteToken(rawToken),
    contactId: params.contactId,
    maxUses: params.maxUses ?? 1,
    useCount: 0,
    expiresAt: now + (params.expiresInMs ?? DEFAULT_EXPIRY_MS),
    status: "active" as const,
    redeemedByExternalUserId: null,
    redeemedAt: null,
    createdAt: now,
    updatedAt: now,
  };

  await db.orm.insert(a2aInvites).values(row);

  return { invite: rowToInvite(row), rawToken };
}

// ---------------------------------------------------------------------------
// claimA2aInvite — validate + consume an A2A invite token
// ---------------------------------------------------------------------------

export async function claimA2aInvite(params: {
  token: string;
  redeemedByExternalUserId: string;
}): Promise<{ claimed: boolean; invite: A2aInvite | null; error?: string }> {
  const tokenHash = hashInviteToken(params.token);
  const invite = await findByTokenHash(tokenHash);

  if (!invite) {
    return { claimed: false, invite: null, error: "not_found" };
  }

  // Idempotency: if already redeemed by the same acceptor, return success
  if (invite.status === "redeemed") {
    if (invite.redeemedByExternalUserId === params.redeemedByExternalUserId) {
      return { claimed: true, invite };
    }
    return { claimed: false, invite, error: "already_redeemed_by_other" };
  }

  if (invite.status !== "active") {
    return { claimed: false, invite, error: "not_found" };
  }

  if (Date.now() >= invite.expiresAt) {
    await markExpired(invite.id);
    return { claimed: false, invite, error: "expired" };
  }

  if (invite.useCount >= invite.maxUses) {
    return { claimed: false, invite, error: "already_redeemed" };
  }

  const recorded = await recordUse({
    inviteId: invite.id,
    redeemedByExternalUserId: params.redeemedByExternalUserId,
  });

  if (!recorded) {
    return { claimed: false, invite, error: "not_found" };
  }

  // Re-read to get updated state
  return { claimed: true, invite: await findByTokenHash(tokenHash) };
}
