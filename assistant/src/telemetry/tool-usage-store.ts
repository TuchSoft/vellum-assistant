import { count, desc, lt } from "drizzle-orm";
import { v4 as uuid } from "uuid";

import { requireMainDb } from "../persistence/db-facade.js";
import { getLogger } from "../util/logger.js";

export interface ToolInvocationRecord {
  conversationId: string;
  toolName: string;
  input: string;
  result: string;
  decision: string;
  riskLevel: string;
  matchedTrustRuleId?: string;
  durationMs: number;
  /** Serialized input size in bytes, computed before any redaction. */
  argBytes?: number | null;
  /** Full serialized result size in bytes, computed before truncation/redaction. */
  resultBytes?: number | null;
  provider?: string | null;
  model?: string | null;
  modelSource?: string | null;
}

export async function recordToolInvocation(
  record: ToolInvocationRecord,
): Promise<void> {
  const db = requireMainDb();
  await db.orm.insert(db.schema.toolInvocations).values({
    id: uuid(),
    conversationId: record.conversationId,
    toolName: record.toolName,
    input: record.input,
    result: record.result,
    decision: record.decision,
    riskLevel: record.riskLevel,
    matchedTrustRuleId: record.matchedTrustRuleId,
    durationMs: record.durationMs,
    createdAt: Date.now(),
    argBytes: record.argBytes,
    resultBytes: record.resultBytes,
    provider: record.provider,
    model: record.model,
    modelSource: record.modelSource,
  });
}

export async function getRecentInvocations(limit: number) {
  const db = requireMainDb();
  return db.orm
    .select()
    .from(db.schema.toolInvocations)
    .orderBy(desc(db.schema.toolInvocations.createdAt))
    .limit(limit);
}

const log = getLogger("audit-log");

/**
 * Delete tool invocation records older than the specified number of
 * days. Returns the number of deleted records. Does nothing if
 * `retentionDays` is zero, negative, or non-finite.
 */
export async function rotateToolInvocations(
  retentionDays: number,
): Promise<number> {
  if (!Number.isFinite(retentionDays) || retentionDays <= 0) {
    return 0;
  }

  const cutoffMs = Math.floor(Date.now() - retentionDays * 24 * 60 * 60 * 1000);
  const db = requireMainDb();
  const toolInvocations = db.schema.toolInvocations;

  const [countRow] = await db.orm
    .select({ value: count() })
    .from(toolInvocations)
    .where(lt(toolInvocations.createdAt, cutoffMs));
  const toDelete = Number(countRow?.value ?? 0);
  if (toDelete === 0) {
    return 0;
  }

  const deleted = await db.run(
    "DELETE FROM tool_invocations WHERE created_at < ?",
    [cutoffMs],
  );
  if (deleted === 0) {
    return 0;
  }

  log.info(
    `Rotated ${deleted} audit log entries older than ${retentionDays} day(s)`,
  );
  return deleted;
}
