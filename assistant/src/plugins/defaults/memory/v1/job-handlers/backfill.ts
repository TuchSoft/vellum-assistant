import { parseMessageMetadata } from "@vellumai/plugin-api";
import { and, asc, eq, gt, or } from "drizzle-orm";

import type { AssistantConfig } from "../../../../../config/types.js";
import {
  readMessageCursorCheckpoint,
  resetMessageCursorCheckpoint,
  writeMessageCursorCheckpoint,
} from "../../../../../persistence/checkpoints.js";
import { requireMainDb } from "../../../../../persistence/db-facade.js";
import {
  enqueueMemoryJob,
  type MemoryJob,
} from "../../../../../persistence/jobs-store.js";
import { indexMessageNow } from "../../indexer.js";

const BACKFILL_CHECKPOINT_KEY = "memory:backfill:last_created_at";
const BACKFILL_CHECKPOINT_ID_KEY = "memory:backfill:last_message_id";

export async function backfillJob(
  job: MemoryJob,
  config: AssistantConfig,
): Promise<void> {
  const db = requireMainDb();
  const messages = db.schema.messages;
  const force = job.payload.force === true;
  if (force) {
    await resetMessageCursorCheckpoint(
      BACKFILL_CHECKPOINT_KEY,
      BACKFILL_CHECKPOINT_ID_KEY,
    );
  }

  const cursor = await readMessageCursorCheckpoint(
    BACKFILL_CHECKPOINT_KEY,
    BACKFILL_CHECKPOINT_ID_KEY,
  );
  const batch = await db.orm
    .select()
    .from(messages)
    .where(
      and(
        eq(messages.finalized, 1),
        or(
          gt(messages.createdAt, cursor.createdAt),
          and(
            eq(messages.createdAt, cursor.createdAt),
            gt(messages.id, cursor.messageId),
          ),
        ),
      ),
    )
    .orderBy(asc(messages.createdAt), asc(messages.id))
    .limit(200);

  if (batch.length > 0) {
    for (const message of batch) {
      const meta = await parseMessageMetadata(message.metadata ?? null);
      await indexMessageNow(
        {
          messageId: message.id,
          conversationId: message.conversationId,
          role: message.role,
          content: message.content,
          createdAt: message.createdAt,
          provenanceTrustClass: meta?.provenanceTrustClass,
          automated: meta?.automated,
        },
        config.memory,
      );
    }
    const lastMessage = batch[batch.length - 1];
    await writeMessageCursorCheckpoint(
      BACKFILL_CHECKPOINT_KEY,
      BACKFILL_CHECKPOINT_ID_KEY,
      {
        createdAt: lastMessage.createdAt,
        messageId: lastMessage.id,
      },
    );
  }

  if (batch.length === 200) {
    enqueueMemoryJob("backfill", {});
  }
}
