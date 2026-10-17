import { readFile } from "node:fs/promises";

import { embedAndUpsert } from "@vellumai/plugin-api";
import { and, eq } from "drizzle-orm";

import {
  getMemoryAsyncDb,
  requireMainDb,
} from "../../../../../persistence/db-facade.js";
import type { EmbeddingInput } from "../../../../../persistence/embeddings/embedding-types.js";
import { asString } from "../../../../../persistence/job-utils.js";
import type { MemoryJob } from "../../../../../persistence/jobs-store.js";
import { extractMediaBlocks } from "../../message-media.js";

export async function embedSegmentJob(job: MemoryJob): Promise<void> {
  const segmentId = asString(job.payload.segmentId);
  if (!segmentId) {
    return;
  }
  const mem = getMemoryAsyncDb();
  if (!mem) {
    return;
  }
  const memorySegments = mem.schema.memorySegments;
  const segmentRows = await mem.orm
    .select()
    .from(memorySegments)
    .where(eq(memorySegments.id, segmentId));
  const segment = segmentRows[0];
  if (!segment) {
    return;
  }
  await embedAndUpsert("segment", segment.id, segment.text, {
    conversation_id: segment.conversationId,
    message_id: segment.messageId,
    created_at: segment.createdAt,
  });
}

export async function embedSummaryJob(job: MemoryJob): Promise<void> {
  const summaryId = asString(job.payload.summaryId);
  if (!summaryId) {
    return;
  }
  const db = getMemoryAsyncDb();
  if (!db) {
    return;
  }
  const memorySummaries = db.schema.memorySummaries;
  const summaryRows = await db.orm
    .select()
    .from(memorySummaries)
    .where(eq(memorySummaries.id, summaryId));
  const summary = summaryRows[0];
  if (!summary) {
    return;
  }
  await embedAndUpsert(
    "summary",
    summary.id,
    `[${summary.scope}] ${summary.summary}`,
    {
      kind: summary.scope,
      created_at: summary.startAt,
      last_seen_at: summary.endAt,
    },
  );
}

export async function embedMediaJob(job: MemoryJob): Promise<void> {
  const assetId = asString(job.payload.assetId);
  if (!assetId) {
    return;
  }

  const db = requireMainDb();
  const mediaAssets = db.schema.mediaAssets;
  const assetRows = await db.orm
    .select()
    .from(mediaAssets)
    .where(eq(mediaAssets.id, assetId));
  const asset = assetRows[0];
  if (!asset || asset.status !== "indexed") {
    return;
  }

  // Read the media file from disk
  const fileData = await readFile(asset.filePath);

  // Determine modality from mediaType
  const input: EmbeddingInput = {
    type: asset.mediaType as "image" | "audio" | "video",
    data: fileData,
    mimeType: asset.mimeType,
  };

  await embedAndUpsert("media", asset.id, input, {
    created_at: asset.createdAt,
    kind: asset.mediaType,
    subject: asset.title,
  });
}

export async function embedAttachmentJob(job: MemoryJob): Promise<void> {
  const messageId = asString(job.payload.messageId);
  const blockIndex = job.payload.blockIndex as number;
  if (!messageId || typeof blockIndex !== "number") {
    return;
  }

  const db = requireMainDb();
  const messages = db.schema.messages;
  const messageRows = await db.orm
    .select()
    .from(messages)
    .where(and(eq(messages.id, messageId), eq(messages.finalized, 1)));
  const message = messageRows[0];
  if (!message) {
    return;
  }

  const mediaBlocks = await extractMediaBlocks(message.content);
  const block = mediaBlocks.find((b) => b.index === blockIndex);
  if (!block) {
    return;
  }

  const input: EmbeddingInput = {
    type: block.type,
    data: block.data,
    mimeType: block.mimeType,
  };

  // Use messageId + blockIndex as targetId for uniqueness
  const targetId = `${messageId}:${blockIndex}`;
  await embedAndUpsert("media", targetId, input, {
    created_at: message.createdAt,
    message_id: messageId,
    conversation_id: message.conversationId,
  });
}
