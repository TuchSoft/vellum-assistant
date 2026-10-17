/**
 * Store for cloud-shared app link records.
 *
 * Each record holds a .vellum zip bundle keyed by a short, shareable token.
 */

import { randomBytes, randomUUID } from "node:crypto";

import { and, eq, isNull, lte, or } from "drizzle-orm";

import type { AppManifest } from "../bundler/manifest.js";
import { requireMainDb } from "../persistence/db-facade.js";

export interface SharedAppLinkRecord {
  id: string;
  shareToken: string;
  bundleData: Buffer;
  bundleSizeBytes: number;
  manifestJson: string;
  downloadCount: number;
  createdAt: number;
  expiresAt: number | null;
}

const SHARE_LINK_TTL_MS = 30 * 24 * 60 * 60 * 1000; // 30 days

function generateShareToken(): string {
  // 16 bytes = 128 bits of entropy (matches UUID standard), base64url-encoded
  // to a 22-character URL-safe string.
  return randomBytes(16).toString("base64url");
}

/** Delete all rows whose effective expiry has passed (including legacy NULL rows). */
async function sweepExpiredLinks(): Promise<void> {
  const db = requireMainDb();
  const sharedAppLinks = db.schema.sharedAppLinks;
  const now = Date.now();
  await db.orm.delete(sharedAppLinks).where(
    or(
      lte(sharedAppLinks.expiresAt, now),
      // Legacy rows created before TTL was added have expiresAt = NULL;
      // treat them as expired once createdAt + TTL has passed.
      and(
        isNull(sharedAppLinks.expiresAt),
        lte(sharedAppLinks.createdAt, now - SHARE_LINK_TTL_MS),
      ),
    ),
  );
}

export async function createSharedAppLink(
  bundleData: Buffer,
  manifest: AppManifest,
): Promise<{ id: string; shareToken: string }> {
  await sweepExpiredLinks();

  const db = requireMainDb();
  const id = randomUUID();
  const shareToken = generateShareToken();
  const now = Date.now();

  await db.orm.insert(db.schema.sharedAppLinks).values({
    id,
    shareToken,
    bundleData,
    bundleSizeBytes: bundleData.length,
    manifestJson: JSON.stringify(manifest),
    downloadCount: 0,
    createdAt: now,
    expiresAt: now + SHARE_LINK_TTL_MS,
  });

  return { id, shareToken };
}

export async function getSharedAppLink(
  shareToken: string,
): Promise<SharedAppLinkRecord | null> {
  const db = requireMainDb();
  const sharedAppLinks = db.schema.sharedAppLinks;
  const [row] = await db.orm
    .select()
    .from(sharedAppLinks)
    .where(eq(sharedAppLinks.shareToken, shareToken));

  if (!row) {
    return null;
  }

  const effectiveExpiry = row.expiresAt ?? row.createdAt + SHARE_LINK_TTL_MS;
  if (effectiveExpiry < Date.now()) {
    return null;
  }

  return {
    id: row.id,
    shareToken: row.shareToken,
    bundleData: row.bundleData as Buffer,
    bundleSizeBytes: row.bundleSizeBytes,
    manifestJson: row.manifestJson,
    downloadCount: row.downloadCount,
    createdAt: row.createdAt,
    expiresAt: row.expiresAt,
  };
}

export async function deleteSharedAppLinkByToken(
  shareToken: string,
): Promise<boolean> {
  const db = requireMainDb();
  const sharedAppLinks = db.schema.sharedAppLinks;
  const [existing] = await db.orm
    .select({ id: sharedAppLinks.id })
    .from(sharedAppLinks)
    .where(eq(sharedAppLinks.shareToken, shareToken));

  if (!existing) {
    return false;
  }

  await db.orm
    .delete(sharedAppLinks)
    .where(eq(sharedAppLinks.shareToken, shareToken));

  return true;
}

export async function incrementDownloadCount(
  shareToken: string,
): Promise<void> {
  await requireMainDb().run(
    "UPDATE shared_app_links SET download_count = download_count + 1 WHERE share_token = ?",
    [shareToken],
  );
}
