/**
 * Store for published page records.
 *
 * Tracks HTML pages deployed to Vercel, keyed by deployment ID and content hash
 * for deduplication.
 */

import { and, eq } from "drizzle-orm";

import { requireMainDb } from "../persistence/db-facade.js";

export interface PublishedPageRecord {
  id: string;
  deploymentId: string;
  publicUrl: string;
  pageTitle: string | null;
  htmlHash: string;
  publishedAt: number;
  status: string;
  appId: string | null;
  projectSlug: string | null;
}

export async function getActivePublishedPageByAppId(
  appId: string,
): Promise<PublishedPageRecord | null> {
  const db = requireMainDb();
  const publishedPages = db.schema.publishedPages;
  const [row] = await db.orm
    .select()
    .from(publishedPages)
    .where(
      and(eq(publishedPages.appId, appId), eq(publishedPages.status, "active")),
    );
  return row ?? null;
}

export async function insertPublishedPage(record: {
  id: string;
  deploymentId: string;
  publicUrl: string;
  pageTitle: string | null;
  htmlHash: string;
  publishedAt: number;
  status: string;
  appId: string | null;
  projectSlug: string | null;
}): Promise<void> {
  const db = requireMainDb();
  await db.orm.insert(db.schema.publishedPages).values(record);
}

export async function updatePublishedPage(
  id: string,
  updates: {
    deploymentId?: string;
    publicUrl?: string;
    htmlHash?: string;
    publishedAt?: number;
    appId?: string;
    status?: string;
  },
): Promise<void> {
  const db = requireMainDb();
  const publishedPages = db.schema.publishedPages;
  await db.orm
    .update(publishedPages)
    .set(updates)
    .where(eq(publishedPages.id, id));
}
