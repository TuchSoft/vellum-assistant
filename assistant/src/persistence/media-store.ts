/**
 * Media asset storage and processing stage tracking.
 *
 * Provides CRUD operations for the media_assets and processing_stages tables.
 * Uses content-hash deduplication (same pattern as attachments-store.ts).
 */

import { eq } from "drizzle-orm";
import { v4 as uuid } from "uuid";

import type { SchemaTables } from "./db-facade.js";
import { requireMainDb } from "./db-facade.js";

type MediaAssetRow = SchemaTables["mediaAssets"]["$inferSelect"];
type ProcessingStageRow = SchemaTables["processingStages"]["$inferSelect"];
type MediaKeyframeRow = SchemaTables["mediaKeyframes"]["$inferSelect"];

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type MediaAssetStatus =
  | "registered"
  | "processing"
  | "indexed"
  | "failed"
  | "cancelled";
export type MediaType = "video" | "audio" | "image";
export type StageStatus = "pending" | "running" | "completed" | "failed";

export interface MediaAsset {
  id: string;
  title: string;
  filePath: string;
  mimeType: string;
  durationSeconds: number | null;
  fileHash: string;
  status: MediaAssetStatus;
  mediaType: MediaType;
  metadata: Record<string, unknown> | null;
  createdAt: number;
  updatedAt: number;
}

export interface ProcessingStage {
  id: string;
  assetId: string;
  stage: string;
  status: StageStatus;
  progress: number;
  lastError: string | null;
  startedAt: number | null;
  completedAt: number | null;
}

// ---------------------------------------------------------------------------
// Content hashing
// ---------------------------------------------------------------------------

/**
 * Streaming content hashing that avoids loading the entire file into memory.
 * Uses SHA-256 via Bun.CryptoHasher so multi-GB files won't OOM.
 */
export async function computeFileHashStreaming(
  filePath: string,
): Promise<string> {
  const hasher = new Bun.CryptoHasher("sha256");
  const stream = Bun.file(filePath).stream();
  for await (const chunk of stream) {
    hasher.update(chunk);
  }
  return hasher.digest("hex");
}

// ---------------------------------------------------------------------------
// Media asset CRUD
// ---------------------------------------------------------------------------

export async function registerMediaAsset(params: {
  title: string;
  filePath: string;
  mimeType: string;
  durationSeconds: number | null;
  fileHash: string;
  mediaType: MediaType;
  metadata?: Record<string, unknown>;
}): Promise<MediaAsset> {
  const db = requireMainDb();
  const mediaAssets = db.schema.mediaAssets;

  // Dedup: if an asset with the same content hash already exists, return it
  const existingRows = await db.orm
    .select()
    .from(mediaAssets)
    .where(eq(mediaAssets.fileHash, params.fileHash));
  const existing = existingRows[0];

  if (existing) {
    return parseAssetRow(existing);
  }

  const now = Date.now();
  const record = {
    id: uuid(),
    title: params.title,
    filePath: params.filePath,
    mimeType: params.mimeType,
    durationSeconds: params.durationSeconds,
    fileHash: params.fileHash,
    status: "registered" as const,
    mediaType: params.mediaType,
    metadata: params.metadata ? JSON.stringify(params.metadata) : null,
    createdAt: now,
    updatedAt: now,
  };

  await db.orm.insert(mediaAssets).values(record);

  return {
    ...record,
    metadata: params.metadata ?? null,
  };
}

export async function getMediaAssetById(
  id: string,
): Promise<MediaAsset | null> {
  const db = requireMainDb();
  const mediaAssets = db.schema.mediaAssets;
  const rows = await db.orm
    .select()
    .from(mediaAssets)
    .where(eq(mediaAssets.id, id));
  const row = rows[0];
  return row ? parseAssetRow(row) : null;
}

export async function getMediaAssetByFilePath(
  filePath: string,
): Promise<MediaAsset | null> {
  const db = requireMainDb();
  const mediaAssets = db.schema.mediaAssets;
  const rows = await db.orm
    .select()
    .from(mediaAssets)
    .where(eq(mediaAssets.filePath, filePath));
  const row = rows[0];
  return row ? parseAssetRow(row) : null;
}

export async function getMediaAssetByHash(
  fileHash: string,
): Promise<MediaAsset | null> {
  const db = requireMainDb();
  const mediaAssets = db.schema.mediaAssets;
  const rows = await db.orm
    .select()
    .from(mediaAssets)
    .where(eq(mediaAssets.fileHash, fileHash));
  const row = rows[0];
  return row ? parseAssetRow(row) : null;
}

export async function getMediaAssetsByStatus(
  status: MediaAssetStatus,
): Promise<MediaAsset[]> {
  const db = requireMainDb();
  const mediaAssets = db.schema.mediaAssets;
  const rows = await db.orm
    .select()
    .from(mediaAssets)
    .where(eq(mediaAssets.status, status));
  return rows.map(parseAssetRow);
}

export async function updateMediaAssetStatus(
  id: string,
  status: MediaAssetStatus,
): Promise<void> {
  const db = requireMainDb();
  const mediaAssets = db.schema.mediaAssets;
  await db.orm
    .update(mediaAssets)
    .set({ status, updatedAt: Date.now() })
    .where(eq(mediaAssets.id, id));
}

// ---------------------------------------------------------------------------
// Processing stage CRUD
// ---------------------------------------------------------------------------

export async function createProcessingStage(params: {
  assetId: string;
  stage: string;
}): Promise<ProcessingStage> {
  const db = requireMainDb();
  const processingStages = db.schema.processingStages;
  const record = {
    id: uuid(),
    assetId: params.assetId,
    stage: params.stage,
    status: "pending" as const,
    progress: 0,
    lastError: null,
    startedAt: null,
    completedAt: null,
  };

  await db.orm.insert(processingStages).values(record);
  return record;
}

export async function getProcessingStagesForAsset(
  assetId: string,
): Promise<ProcessingStage[]> {
  const db = requireMainDb();
  const processingStages = db.schema.processingStages;
  const rows = await db.orm
    .select()
    .from(processingStages)
    .where(eq(processingStages.assetId, assetId));
  return rows.map(parseStageRow);
}

export async function updateProcessingStage(
  id: string,
  updates: Partial<
    Pick<
      ProcessingStage,
      "status" | "progress" | "lastError" | "startedAt" | "completedAt"
    >
  >,
): Promise<void> {
  const db = requireMainDb();
  const processingStages = db.schema.processingStages;
  await db.orm
    .update(processingStages)
    .set(updates)
    .where(eq(processingStages.id, id));
}

// ---------------------------------------------------------------------------
// Row parsing
// ---------------------------------------------------------------------------

function parseAssetRow(row: MediaAssetRow): MediaAsset {
  let metadata: Record<string, unknown> | null = null;
  if (row.metadata) {
    try {
      metadata = JSON.parse(row.metadata) as Record<string, unknown>;
    } catch {
      metadata = null;
    }
  }
  return {
    id: row.id,
    title: row.title,
    filePath: row.filePath,
    mimeType: row.mimeType,
    durationSeconds: row.durationSeconds,
    fileHash: row.fileHash,
    status: row.status as MediaAssetStatus,
    mediaType: row.mediaType as MediaType,
    metadata,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}

function parseStageRow(row: ProcessingStageRow): ProcessingStage {
  return {
    id: row.id,
    assetId: row.assetId,
    stage: row.stage,
    status: row.status as StageStatus,
    progress: row.progress,
    lastError: row.lastError,
    startedAt: row.startedAt,
    completedAt: row.completedAt,
  };
}

// ---------------------------------------------------------------------------
// Keyframe types & CRUD
// ---------------------------------------------------------------------------

export interface MediaKeyframe {
  id: string;
  assetId: string;
  timestamp: number;
  filePath: string;
  metadata: Record<string, unknown> | null;
  createdAt: number;
}

export async function insertKeyframesBatch(
  rows: Array<{
    assetId: string;
    timestamp: number;
    filePath: string;
    metadata?: Record<string, unknown>;
  }>,
): Promise<MediaKeyframe[]> {
  const db = requireMainDb();
  const mediaKeyframes = db.schema.mediaKeyframes;
  const now = Date.now();
  const records = rows.map((r) => ({
    id: uuid(),
    assetId: r.assetId,
    timestamp: r.timestamp,
    filePath: r.filePath,
    metadata: r.metadata ? JSON.stringify(r.metadata) : null,
    createdAt: now,
  }));
  if (records.length > 0) {
    await db.orm.insert(mediaKeyframes).values(records);
  }
  return records.map((rec, i) => ({
    ...rec,
    metadata: rows[i].metadata ?? null,
  }));
}

export async function getKeyframesForAsset(
  assetId: string,
): Promise<MediaKeyframe[]> {
  const db = requireMainDb();
  const mediaKeyframes = db.schema.mediaKeyframes;
  const rows = await db.orm
    .select()
    .from(mediaKeyframes)
    .where(eq(mediaKeyframes.assetId, assetId));
  return rows.map(parseKeyframeRow);
}

export async function deleteKeyframesForAsset(assetId: string): Promise<void> {
  const db = requireMainDb();
  const mediaKeyframes = db.schema.mediaKeyframes;
  await db.orm
    .delete(mediaKeyframes)
    .where(eq(mediaKeyframes.assetId, assetId));
}

function parseKeyframeRow(row: MediaKeyframeRow): MediaKeyframe {
  let metadata: Record<string, unknown> | null = null;
  if (row.metadata) {
    try {
      metadata = JSON.parse(row.metadata) as Record<string, unknown>;
    } catch {
      metadata = null;
    }
  }
  return {
    id: row.id,
    assetId: row.assetId,
    timestamp: row.timestamp,
    filePath: row.filePath,
    metadata,
    createdAt: row.createdAt,
  };
}
