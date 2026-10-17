// ---------------------------------------------------------------------------
// Memory Graph — Data access layer
// ---------------------------------------------------------------------------

import { and, desc, eq, inArray, or, sql } from "drizzle-orm";
import { v4 as uuid } from "uuid";

import type {
  AsyncDb,
  SchemaTables,
} from "../../../../persistence/db-facade.js";
import { requireMainDb } from "../../../../persistence/db-facade.js";
import { enqueueMemoryJob } from "../../../../persistence/jobs-store.js";
import type {
  ApplyDiffResult,
  EmotionalCharge,
  Fidelity,
  ImageRef,
  MemoryDiff,
  MemoryEdge,
  MemoryNode,
  MemoryTrigger,
  MemoryType,
  NewEdge,
  NewNode,
  NewTrigger,
  SourceType,
} from "./types.js";

/**
 * The memory graph cluster lives in the shared Postgres database. This store is
 * the hub for all graph reads and writes, including non-nullable-return writes
 * and the `applyDiff` transaction, so it resolves a guaranteed connection and
 * throws when the database is unavailable rather than fabricating rows for an
 * absent connection.
 */
function memoryDb(): AsyncDb {
  return requireMainDb();
}

// ---------------------------------------------------------------------------
// Row ↔ Domain conversion helpers
// ---------------------------------------------------------------------------

/** Project a `memory_graph_nodes` row onto its domain node. */
function rowToNode(
  row: SchemaTables["memoryGraphNodes"]["$inferSelect"],
): MemoryNode {
  return {
    id: row.id,
    content: row.content,
    type: row.type as MemoryType,
    created: row.created,
    lastAccessed: row.lastAccessed,
    lastConsolidated: row.lastConsolidated,
    eventDate: row.eventDate ?? null,
    emotionalCharge: JSON.parse(row.emotionalCharge) as EmotionalCharge,
    fidelity: row.fidelity as Fidelity,
    confidence: row.confidence,
    significance: row.significance,
    stability: row.stability,
    reinforcementCount: row.reinforcementCount,
    lastReinforced: row.lastReinforced,
    sourceConversations: JSON.parse(row.sourceConversations) as string[],
    sourceType: row.sourceType as SourceType,
    narrativeRole: row.narrativeRole,
    partOfStory: row.partOfStory,
    imageRefs: row.imageRefs ? (JSON.parse(row.imageRefs) as ImageRef[]) : null,
  };
}

function nodeToInsertValues(node: NewNode, id: string) {
  return {
    id,
    content: node.content,
    type: node.type,
    created: node.created,
    lastAccessed: node.lastAccessed,
    lastConsolidated: node.lastConsolidated,
    eventDate: node.eventDate ?? null,
    emotionalCharge: JSON.stringify(node.emotionalCharge),
    fidelity: node.fidelity,
    confidence: node.confidence,
    significance: node.significance,
    stability: node.stability,
    reinforcementCount: node.reinforcementCount,
    lastReinforced: node.lastReinforced,
    sourceConversations: JSON.stringify(node.sourceConversations),
    sourceType: node.sourceType,
    narrativeRole: node.narrativeRole,
    partOfStory: node.partOfStory,
    imageRefs: node.imageRefs ? JSON.stringify(node.imageRefs) : null,
  };
}

function rowToEdge(
  row: SchemaTables["memoryGraphEdges"]["$inferSelect"],
): MemoryEdge {
  return {
    id: row.id,
    sourceNodeId: row.sourceNodeId,
    targetNodeId: row.targetNodeId,
    relationship: row.relationship as MemoryEdge["relationship"],
    weight: row.weight,
    created: row.created,
  };
}

function rowToTrigger(
  row: SchemaTables["memoryGraphTriggers"]["$inferSelect"],
): MemoryTrigger {
  return {
    id: row.id,
    nodeId: row.nodeId,
    type: row.type as MemoryTrigger["type"],
    schedule: row.schedule,
    condition: row.condition,
    conditionEmbedding: row.conditionEmbedding
      ? new Float32Array(
          row.conditionEmbedding.buffer,
          row.conditionEmbedding.byteOffset,
          row.conditionEmbedding.byteLength / 4,
        )
      : null,
    threshold: row.threshold,
    eventDate: row.eventDate,
    rampDays: row.rampDays,
    followUpDays: row.followUpDays,
    recurring: row.recurring,
    consumed: row.consumed,
    cooldownMs: row.cooldownMs,
    lastFired: row.lastFired,
  };
}

// ---------------------------------------------------------------------------
// Paragraph deduplication
// ---------------------------------------------------------------------------

/**
 * Remove repeated paragraphs and bullet items from memory node content.
 * Paragraphs are separated by `\n\n`. Within each paragraph, lines starting
 * with `- ` are treated as bullet items and individually deduplicated.
 */
export function deduplicateParagraphs(content: string): string {
  if (!content) {
    return content;
  }

  const paragraphs = content.split("\n\n");
  const seen = new Set<string>();
  const unique: string[] = [];

  for (const paragraph of paragraphs) {
    // Deduplicate bullet items within the paragraph
    const lines = paragraph.split("\n");
    const isBulletList = lines.some((l) => l.trimStart().startsWith("- "));

    let processed: string;
    if (isBulletList) {
      const seenBullets = new Set<string>();
      const uniqueLines: string[] = [];
      for (const line of lines) {
        if (line.trimStart().startsWith("- ")) {
          const normalized = line.trim().replace(/\s+/g, " ");
          if (!seenBullets.has(normalized)) {
            seenBullets.add(normalized);
            uniqueLines.push(line);
          }
        } else {
          uniqueLines.push(line);
        }
      }
      processed = uniqueLines.join("\n");
    } else {
      processed = paragraph;
    }

    const normalized = processed.trim().replace(/\s+/g, " ");
    if (normalized === "") {
      // Preserve empty paragraphs (whitespace-only) as separators
      unique.push(processed);
    } else if (!seen.has(normalized)) {
      seen.add(normalized);
      unique.push(processed);
    }
  }

  return unique.join("\n\n");
}

// ---------------------------------------------------------------------------
// Node CRUD
// ---------------------------------------------------------------------------

export async function createNode(node: NewNode): Promise<MemoryNode> {
  const db = memoryDb();
  const memoryGraphNodes = db.schema.memoryGraphNodes;
  const id = uuid();
  const cleanContent = deduplicateParagraphs(node.content);
  await db.orm
    .insert(memoryGraphNodes)
    .values(nodeToInsertValues({ ...node, content: cleanContent }, id));
  return { ...node, content: cleanContent, id };
}

export async function getNode(id: string): Promise<MemoryNode | null> {
  const db = memoryDb();
  const memoryGraphNodes = db.schema.memoryGraphNodes;
  const rows = await db.orm
    .select()
    .from(memoryGraphNodes)
    .where(eq(memoryGraphNodes.id, id));
  const row = rows[0];
  return row ? rowToNode(row) : null;
}

export async function getNodesByIds(ids: string[]): Promise<MemoryNode[]> {
  if (ids.length === 0) {
    return [];
  }
  const db = memoryDb();
  const memoryGraphNodes = db.schema.memoryGraphNodes;
  const rows = await db.orm
    .select()
    .from(memoryGraphNodes)
    .where(inArray(memoryGraphNodes.id, ids));
  return rows.map(rowToNode);
}

export async function updateNode(
  id: string,
  changes: Partial<Omit<MemoryNode, "id">>,
): Promise<void> {
  const db = memoryDb();
  const memoryGraphNodes = db.schema.memoryGraphNodes;
  const updates: Record<string, unknown> = {};

  if (changes.content !== undefined) {
    updates.content = deduplicateParagraphs(changes.content);
  }
  if (changes.type !== undefined) {
    updates.type = changes.type;
  }
  if (changes.created !== undefined) {
    updates.created = changes.created;
  }
  if (changes.lastAccessed !== undefined) {
    updates.lastAccessed = changes.lastAccessed;
  }
  if (changes.lastConsolidated !== undefined) {
    updates.lastConsolidated = changes.lastConsolidated;
  }
  if (changes.emotionalCharge !== undefined) {
    updates.emotionalCharge = JSON.stringify(changes.emotionalCharge);
  }
  if (changes.fidelity !== undefined) {
    updates.fidelity = changes.fidelity;
  }
  if (changes.confidence !== undefined) {
    updates.confidence = changes.confidence;
  }
  if (changes.significance !== undefined) {
    updates.significance = changes.significance;
  }
  if (changes.stability !== undefined) {
    updates.stability = changes.stability;
  }
  if (changes.reinforcementCount !== undefined) {
    updates.reinforcementCount = changes.reinforcementCount;
  }
  if (changes.lastReinforced !== undefined) {
    updates.lastReinforced = changes.lastReinforced;
  }
  if (changes.sourceConversations !== undefined) {
    updates.sourceConversations = JSON.stringify(changes.sourceConversations);
  }
  if (changes.sourceType !== undefined) {
    updates.sourceType = changes.sourceType;
  }
  if (changes.narrativeRole !== undefined) {
    updates.narrativeRole = changes.narrativeRole;
  }
  if (changes.partOfStory !== undefined) {
    updates.partOfStory = changes.partOfStory;
  }
  if (changes.imageRefs !== undefined) {
    updates.imageRefs = changes.imageRefs
      ? JSON.stringify(changes.imageRefs)
      : null;
  }
  if (changes.eventDate !== undefined) {
    updates.eventDate = changes.eventDate;
  }

  if (Object.keys(updates).length === 0) {
    return;
  }

  await db.orm
    .update(memoryGraphNodes)
    .set(updates)
    .where(eq(memoryGraphNodes.id, id));

  // Sync event triggers when eventDate changes
  if (changes.eventDate !== undefined) {
    const triggers = await getTriggersForNode(id);
    const eventTriggers = triggers.filter((t) => t.type === "event");
    for (const trigger of eventTriggers) {
      if (changes.eventDate === null) {
        // Clearing eventDate — delete orphaned event trigger
        await deleteTrigger(trigger.id);
      } else {
        // Updating eventDate — sync trigger's eventDate
        await updateTrigger(trigger.id, { eventDate: changes.eventDate });
      }
    }
  }
}

export async function deleteNode(id: string): Promise<void> {
  const db = memoryDb();
  const memoryGraphNodes = db.schema.memoryGraphNodes;
  await db.orm
    .update(memoryGraphNodes)
    .set({ fidelity: "gone", lastAccessed: Date.now() })
    .where(eq(memoryGraphNodes.id, id));
  enqueueMemoryJob("delete_qdrant_vectors", {
    targetType: "graph_node",
    targetId: id,
  });
}

// ---------------------------------------------------------------------------
// Node queries
// ---------------------------------------------------------------------------

export interface NodeQueryFilters {
  types?: MemoryType[];
  fidelityNot?: Fidelity[];
  minSignificance?: number;
  createdAfter?: number;
  createdBefore?: number;
  hasEventDate?: boolean;
  eventDateAfter?: number;
  eventDateBefore?: number;
  limit?: number;
}

export async function queryNodes(
  filters: NodeQueryFilters,
): Promise<MemoryNode[]> {
  const db = memoryDb();
  const memoryGraphNodes = db.schema.memoryGraphNodes;
  const conditions = [];

  if (filters.types && filters.types.length > 0) {
    conditions.push(inArray(memoryGraphNodes.type, filters.types));
  }
  if (filters.fidelityNot && filters.fidelityNot.length > 0) {
    conditions.push(
      sql`${memoryGraphNodes.fidelity} NOT IN (${sql.join(
        filters.fidelityNot.map((f) => sql`${f}`),
        sql`, `,
      )})`,
    );
  }
  if (filters.minSignificance !== undefined) {
    conditions.push(
      sql`${memoryGraphNodes.significance} >= ${filters.minSignificance}`,
    );
  }
  if (filters.createdAfter !== undefined) {
    conditions.push(
      sql`${memoryGraphNodes.created} >= ${filters.createdAfter}`,
    );
  }
  if (filters.createdBefore !== undefined) {
    conditions.push(
      sql`${memoryGraphNodes.created} <= ${filters.createdBefore}`,
    );
  }
  if (filters.hasEventDate) {
    conditions.push(sql`${memoryGraphNodes.eventDate} IS NOT NULL`);
  }
  if (filters.eventDateAfter !== undefined) {
    conditions.push(
      sql`${memoryGraphNodes.eventDate} >= ${filters.eventDateAfter}`,
    );
  }
  if (filters.eventDateBefore !== undefined) {
    conditions.push(
      sql`${memoryGraphNodes.eventDate} <= ${filters.eventDateBefore}`,
    );
  }

  let query = db.orm
    .select()
    .from(memoryGraphNodes)
    .where(conditions.length > 0 ? and(...conditions) : undefined)
    .orderBy(sql`${memoryGraphNodes.significance} DESC`);

  if (filters.limit != null) {
    query = query.limit(filters.limit) as typeof query;
  }

  return (await query).map(rowToNode);
}

/**
 * Pull capability (skill / CLI) nodes directly from SQLite, ordered by
 * significance DESC. Matches the content shapes produced by both the
 * legacy (`skill:{id}\n`, `cli:{name}\n`) and current
 * (`The "..." skill (id) is available.`, `The "assistant ..." CLI command`)
 * seeding systems — keeping the SQL filter in sync with `isCapabilityNode`.
 *
 * Used as a cold-start fallback for context-load capability injection when
 * no semantic-search candidates are capability nodes (e.g. fresh assistants
 * whose embedding jobs haven't completed yet). The content-pattern filter
 * prevents organic procedural memories from crowding out real capabilities.
 */
export async function queryCapabilityNodes(
  limit: number,
): Promise<MemoryNode[]> {
  const db = memoryDb();
  const memoryGraphNodes = db.schema.memoryGraphNodes;
  const rows = await db.orm
    .select()
    .from(memoryGraphNodes)
    .where(
      and(
        eq(memoryGraphNodes.type, "procedural"),
        sql`${memoryGraphNodes.fidelity} != 'gone'`,
        or(
          sql`${memoryGraphNodes.content} LIKE 'skill:%'`,
          sql`${memoryGraphNodes.content} LIKE 'cli:%'`,
          and(
            sql`${memoryGraphNodes.content} LIKE 'The "%'`,
            sql`${memoryGraphNodes.content} LIKE '% is available.%'`,
          ),
        ),
      ),
    )
    .orderBy(sql`${memoryGraphNodes.significance} DESC`)
    .limit(limit);
  return rows.map(rowToNode);
}

/** Count all non-gone nodes in the workspace memory pool. */
export async function countNodes(): Promise<number> {
  const db = memoryDb();
  const memoryGraphNodes = db.schema.memoryGraphNodes;
  const rows = await db.orm
    .select({ count: sql<number>`count(*)` })
    .from(memoryGraphNodes)
    .where(sql`${memoryGraphNodes.fidelity} != 'gone'`);
  return rows[0]?.count ?? 0;
}

// ---------------------------------------------------------------------------
// Edge CRUD
// ---------------------------------------------------------------------------

export async function createEdge(edge: NewEdge): Promise<MemoryEdge> {
  const db = memoryDb();
  const memoryGraphEdges = db.schema.memoryGraphEdges;
  const id = uuid();
  await db.orm.insert(memoryGraphEdges).values({
    id,
    sourceNodeId: edge.sourceNodeId,
    targetNodeId: edge.targetNodeId,
    relationship: edge.relationship,
    weight: edge.weight,
    created: edge.created,
  });
  return { ...edge, id };
}

export async function deleteEdge(id: string): Promise<void> {
  const db = memoryDb();
  const memoryGraphEdges = db.schema.memoryGraphEdges;
  await db.orm.delete(memoryGraphEdges).where(eq(memoryGraphEdges.id, id));
}

export async function getEdgesForNode(
  nodeId: string,
  direction?: "incoming" | "outgoing",
): Promise<MemoryEdge[]> {
  const db = memoryDb();
  const memoryGraphEdges = db.schema.memoryGraphEdges;
  const memoryGraphNodes = db.schema.memoryGraphNodes;
  const dirCondition =
    direction === "outgoing"
      ? eq(memoryGraphEdges.sourceNodeId, nodeId)
      : direction === "incoming"
        ? eq(memoryGraphEdges.targetNodeId, nodeId)
        : or(
            eq(memoryGraphEdges.sourceNodeId, nodeId),
            eq(memoryGraphEdges.targetNodeId, nodeId),
          );

  // Exclude edges where either endpoint has fidelity='gone' (soft-deleted)
  const condition = and(
    dirCondition,
    sql`NOT EXISTS (SELECT 1 FROM ${memoryGraphNodes} WHERE ${memoryGraphNodes.id} = ${memoryGraphEdges.sourceNodeId} AND ${memoryGraphNodes.fidelity} = 'gone')`,
    sql`NOT EXISTS (SELECT 1 FROM ${memoryGraphNodes} WHERE ${memoryGraphNodes.id} = ${memoryGraphEdges.targetNodeId} AND ${memoryGraphNodes.fidelity} = 'gone')`,
  );

  const rows = await db.orm.select().from(memoryGraphEdges).where(condition);
  return rows.map(rowToEdge);
}

// ---------------------------------------------------------------------------
// Trigger CRUD
// ---------------------------------------------------------------------------

export async function createTrigger(
  trigger: NewTrigger,
): Promise<MemoryTrigger> {
  const db = memoryDb();
  const memoryGraphTriggers = db.schema.memoryGraphTriggers;
  const id = uuid();
  await db.orm.insert(memoryGraphTriggers).values({
    id,
    nodeId: trigger.nodeId,
    type: trigger.type,
    schedule: trigger.schedule,
    condition: trigger.condition,
    conditionEmbedding: trigger.conditionEmbedding
      ? Buffer.from(trigger.conditionEmbedding.buffer)
      : null,
    threshold: trigger.threshold,
    eventDate: trigger.eventDate,
    rampDays: trigger.rampDays,
    followUpDays: trigger.followUpDays,
    recurring: trigger.recurring,
    consumed: trigger.consumed,
    cooldownMs: trigger.cooldownMs,
    lastFired: trigger.lastFired,
  });
  return { ...trigger, id };
}

export async function deleteTrigger(id: string): Promise<void> {
  const db = memoryDb();
  const memoryGraphTriggers = db.schema.memoryGraphTriggers;
  await db.orm
    .delete(memoryGraphTriggers)
    .where(eq(memoryGraphTriggers.id, id));
}

export async function updateTrigger(
  id: string,
  updates: Partial<MemoryTrigger>,
): Promise<void> {
  const db = memoryDb();
  const memoryGraphTriggers = db.schema.memoryGraphTriggers;
  const values: Record<string, unknown> = {};
  if (updates.consumed !== undefined) {
    values.consumed = updates.consumed;
  }
  if (updates.lastFired !== undefined) {
    values.lastFired = updates.lastFired;
  }
  if (updates.conditionEmbedding !== undefined) {
    values.conditionEmbedding = updates.conditionEmbedding
      ? Buffer.from(updates.conditionEmbedding.buffer)
      : null;
  }
  if (updates.eventDate !== undefined) {
    values.eventDate = updates.eventDate;
  }
  if (updates.rampDays !== undefined) {
    values.rampDays = updates.rampDays;
  }
  if (updates.followUpDays !== undefined) {
    values.followUpDays = updates.followUpDays;
  }

  if (Object.keys(values).length === 0) {
    return;
  }
  await db.orm
    .update(memoryGraphTriggers)
    .set(values)
    .where(eq(memoryGraphTriggers.id, id));
}

export async function getTriggersForNode(
  nodeId: string,
): Promise<MemoryTrigger[]> {
  const db = memoryDb();
  const memoryGraphTriggers = db.schema.memoryGraphTriggers;
  const rows = await db.orm
    .select()
    .from(memoryGraphTriggers)
    .where(eq(memoryGraphTriggers.nodeId, nodeId));
  return rows.map(rowToTrigger);
}

export async function getActiveTriggersByType(
  type: MemoryTrigger["type"],
): Promise<MemoryTrigger[]> {
  const db = memoryDb();
  const memoryGraphTriggers = db.schema.memoryGraphTriggers;
  const memoryGraphNodes = db.schema.memoryGraphNodes;
  const conditions = [
    eq(memoryGraphTriggers.type, type),
    eq(memoryGraphTriggers.consumed, false),
  ];

  // Join to nodes table to exclude triggers whose node is soft-deleted.
  const rows = await db.orm
    .select({
      trigger: memoryGraphTriggers,
    })
    .from(memoryGraphTriggers)
    .innerJoin(
      memoryGraphNodes,
      eq(memoryGraphTriggers.nodeId, memoryGraphNodes.id),
    )
    .where(and(...conditions, sql`${memoryGraphNodes.fidelity} != 'gone'`));
  return rows.map((r) => rowToTrigger(r.trigger));
}

// ---------------------------------------------------------------------------
// Reinforcement
// ---------------------------------------------------------------------------

const REINFORCEMENT_STABILITY_MULTIPLIER = 1.5;

/**
 * Reinforce a memory node — confirms it's still accurate/relevant.
 * Increments reinforcementCount, multiplies stability by 1.5,
 * and optionally boosts significance back toward peak.
 */
export async function reinforceNode(id: string): Promise<void> {
  const db = memoryDb();
  const memoryGraphNodes = db.schema.memoryGraphNodes;
  const now = Date.now();
  await db.orm
    .update(memoryGraphNodes)
    .set({
      reinforcementCount: sql`${memoryGraphNodes.reinforcementCount} + 1`,
      stability: sql`${memoryGraphNodes.stability} * ${REINFORCEMENT_STABILITY_MULTIPLIER}`,
      lastReinforced: now,
      significance: sql`LEAST(1.0, ${memoryGraphNodes.significance} * 1.1)`,
    })
    .where(eq(memoryGraphNodes.id, id));
}

/**
 * Supersede an old node with a new one. The new node inherits the old node's
 * earned durability (stability, reinforcementCount, significance).
 * A "supersedes" edge is created, and the old node is returned for content update.
 */
export async function supersedeNode(
  oldNodeId: string,
  newNode: NewNode,
): Promise<{ newNode: MemoryNode; oldNode: MemoryNode | null }> {
  const oldNode = await getNode(oldNodeId);
  if (!oldNode) {
    return { newNode: await createNode(newNode), oldNode: null };
  }

  // Inherit the old node's earned durability
  const inherited: NewNode = {
    ...newNode,
    stability: Math.max(newNode.stability, oldNode.stability),
    reinforcementCount: Math.max(
      newNode.reinforcementCount,
      oldNode.reinforcementCount,
    ),
    significance: Math.max(newNode.significance, oldNode.significance),
    eventDate: newNode.eventDate ?? oldNode.eventDate,
    imageRefs: newNode.imageRefs ?? oldNode.imageRefs,
  };

  const created = await createNode(inherited);

  // Create supersedes edge
  await createEdge({
    sourceNodeId: created.id,
    targetNodeId: oldNodeId,
    relationship: "supersedes",
    weight: 1.0,
    created: Date.now(),
  });

  return { newNode: created, oldNode };
}

// ---------------------------------------------------------------------------
// Diff application (transactional)
// ---------------------------------------------------------------------------

/**
 * Apply a MemoryDiff atomically. All operations run in a single transaction.
 */
export async function applyDiff(
  diff: MemoryDiff,
  opts?: {
    conversationId?: string;
    source?: "extraction" | "consolidation" | "manual";
  },
): Promise<ApplyDiffResult> {
  const db = memoryDb();
  const memoryGraphNodes = db.schema.memoryGraphNodes;
  const memoryGraphEdges = db.schema.memoryGraphEdges;
  const memoryGraphTriggers = db.schema.memoryGraphTriggers;
  const memoryGraphNodeEdits = db.schema.memoryGraphNodeEdits;
  const result: ApplyDiffResult = {
    nodesCreated: 0,
    nodesUpdated: 0,
    nodesDeleted: 0,
    edgesCreated: 0,
    edgesDeleted: 0,
    triggersCreated: 0,
    triggersDeleted: 0,
    nodesReinforced: 0,
    createdNodeIds: [],
  };

  // Qdrant-cleanup jobs target the dedicated memory connection (`memory_jobs`
  // lives in its own file), so they can't share this main-DB transaction —
  // collect the deleted node ids and enqueue them after the transaction commits.
  const deletedNodeIds: string[] = [];

  await db.transaction(async (tx) => {
    // Soft-delete nodes (set fidelity='gone'); the Qdrant cleanup is enqueued
    // after commit.
    for (const id of diff.deleteNodeIds) {
      await tx.orm
        .update(memoryGraphNodes)
        .set({ fidelity: "gone", lastAccessed: Date.now() })
        .where(eq(memoryGraphNodes.id, id));
      deletedNodeIds.push(id);
      result.nodesDeleted++;
    }

    // Create nodes
    for (const node of diff.createNodes) {
      const id = uuid();
      const cleanContent = deduplicateParagraphs(node.content);
      await tx.orm
        .insert(memoryGraphNodes)
        .values(nodeToInsertValues({ ...node, content: cleanContent }, id));
      result.nodesCreated++;
      result.createdNodeIds.push(id);
    }

    // Update nodes
    for (const update of diff.updateNodes) {
      const updates: Record<string, unknown> = {};
      const c = update.changes;
      if (c.content !== undefined) {
        updates.content = deduplicateParagraphs(c.content as string);
      }
      if (c.type !== undefined) {
        updates.type = c.type;
      }
      if (c.emotionalCharge !== undefined) {
        updates.emotionalCharge = JSON.stringify(c.emotionalCharge);
      }
      if (c.fidelity !== undefined) {
        updates.fidelity = c.fidelity;
      }
      if (c.confidence !== undefined) {
        updates.confidence = c.confidence;
      }
      if (c.significance !== undefined) {
        updates.significance = c.significance;
      }
      if (c.stability !== undefined) {
        updates.stability = c.stability;
      }
      if (c.reinforcementCount !== undefined) {
        updates.reinforcementCount = c.reinforcementCount;
      }
      if (c.narrativeRole !== undefined) {
        updates.narrativeRole = c.narrativeRole;
      }
      if (c.partOfStory !== undefined) {
        updates.partOfStory = c.partOfStory;
      }
      if (c.imageRefs !== undefined) {
        updates.imageRefs = c.imageRefs ? JSON.stringify(c.imageRefs) : null;
      }
      if (c.sourceConversations !== undefined) {
        updates.sourceConversations = JSON.stringify(c.sourceConversations);
      }
      if (c.eventDate !== undefined) {
        updates.eventDate = c.eventDate;
      }

      // Record edit history when content changes
      if (updates.content !== undefined) {
        const currentRows = await tx.orm
          .select({ content: memoryGraphNodes.content })
          .from(memoryGraphNodes)
          .where(eq(memoryGraphNodes.id, update.id));
        const current = currentRows[0];
        if (current && current.content !== updates.content) {
          await tx.orm.insert(memoryGraphNodeEdits).values({
            id: uuid(),
            nodeId: update.id,
            previousContent: current.content,
            newContent: updates.content as string,
            source: opts?.source ?? "extraction",
            conversationId: opts?.conversationId ?? null,
            created: Date.now(),
          });
        }
      }

      if (Object.keys(updates).length > 0) {
        await tx.orm
          .update(memoryGraphNodes)
          .set(updates)
          .where(eq(memoryGraphNodes.id, update.id));
        result.nodesUpdated++;
      }

      // Sync event triggers when eventDate changes
      if (c.eventDate !== undefined) {
        const triggers = await tx.orm
          .select()
          .from(memoryGraphTriggers)
          .where(
            and(
              eq(memoryGraphTriggers.nodeId, update.id),
              eq(memoryGraphTriggers.type, "event"),
            ),
          );

        for (const trigger of triggers) {
          if (c.eventDate == null) {
            // eventDate cleared — delete orphaned event trigger
            await tx.orm
              .delete(memoryGraphTriggers)
              .where(eq(memoryGraphTriggers.id, trigger.id));
            result.triggersDeleted++;
          } else {
            // eventDate changed — sync trigger
            await tx.orm
              .update(memoryGraphTriggers)
              .set({ eventDate: c.eventDate })
              .where(eq(memoryGraphTriggers.id, trigger.id));
          }
        }
      }
    }

    // Reinforce nodes
    const now = Date.now();
    for (const id of diff.reinforceNodeIds) {
      await tx.orm
        .update(memoryGraphNodes)
        .set({
          reinforcementCount: sql`${memoryGraphNodes.reinforcementCount} + 1`,
          stability: sql`${memoryGraphNodes.stability} * ${REINFORCEMENT_STABILITY_MULTIPLIER}`,
          lastReinforced: now,
          significance: sql`LEAST(1.0, ${memoryGraphNodes.significance} * 1.1)`,
        })
        .where(eq(memoryGraphNodes.id, id));
      result.nodesReinforced++;
    }

    // Delete edges
    for (const id of diff.deleteEdgeIds) {
      await tx.orm.delete(memoryGraphEdges).where(eq(memoryGraphEdges.id, id));
      result.edgesDeleted++;
    }

    // Create edges
    for (const edge of diff.createEdges) {
      const id = uuid();
      await tx.orm.insert(memoryGraphEdges).values({
        id,
        sourceNodeId: edge.sourceNodeId,
        targetNodeId: edge.targetNodeId,
        relationship: edge.relationship,
        weight: edge.weight,
        created: edge.created,
      });
      result.edgesCreated++;
    }

    // Delete triggers
    for (const id of diff.deleteTriggerIds) {
      await tx.orm
        .delete(memoryGraphTriggers)
        .where(eq(memoryGraphTriggers.id, id));
      result.triggersDeleted++;
    }

    // Create triggers
    for (const trigger of diff.createTriggers) {
      const id = uuid();
      await tx.orm.insert(memoryGraphTriggers).values({
        id,
        nodeId: trigger.nodeId,
        type: trigger.type,
        schedule: trigger.schedule,
        condition: trigger.condition,
        conditionEmbedding: trigger.conditionEmbedding
          ? Buffer.from(trigger.conditionEmbedding.buffer)
          : null,
        threshold: trigger.threshold,
        eventDate: trigger.eventDate,
        rampDays: trigger.rampDays,
        followUpDays: trigger.followUpDays,
        recurring: trigger.recurring,
        consumed: trigger.consumed,
        cooldownMs: trigger.cooldownMs,
        lastFired: trigger.lastFired,
      });
      result.triggersCreated++;
    }
  });

  // Flush Qdrant-cleanup jobs onto the memory connection now the node soft-
  // deletes have committed — enqueue only on success, mirroring the prior
  // in-transaction behavior without spanning the two connections.
  for (const id of deletedNodeIds) {
    enqueueMemoryJob("delete_qdrant_vectors", {
      targetType: "graph_node",
      targetId: id,
    });
  }

  return result;
}

// ---------------------------------------------------------------------------
// Node edit history
// ---------------------------------------------------------------------------

/** Record a content change to a memory node for edit chain tracking. */
export async function recordNodeEdit(opts: {
  nodeId: string;
  previousContent: string;
  newContent: string;
  source: "extraction" | "consolidation" | "manual";
  conversationId?: string;
}): Promise<void> {
  const db = memoryDb();
  const memoryGraphNodeEdits = db.schema.memoryGraphNodeEdits;
  await db.orm.insert(memoryGraphNodeEdits).values({
    id: uuid(),
    nodeId: opts.nodeId,
    previousContent: opts.previousContent,
    newContent: opts.newContent,
    source: opts.source,
    conversationId: opts.conversationId ?? null,
    created: Date.now(),
  });
}

/** Retrieve the edit history for a memory node, newest first. */
export async function getNodeEditHistory(
  nodeId: string,
  limit = 20,
): Promise<
  Array<{
    id: string;
    previousContent: string;
    newContent: string;
    source: string;
    conversationId: string | null;
    created: number;
  }>
> {
  const db = memoryDb();
  const memoryGraphNodeEdits = db.schema.memoryGraphNodeEdits;
  return await db.orm
    .select()
    .from(memoryGraphNodeEdits)
    .where(eq(memoryGraphNodeEdits.nodeId, nodeId))
    .orderBy(desc(memoryGraphNodeEdits.created))
    .limit(limit);
}

// ---------------------------------------------------------------------------
// Graph stats
// ---------------------------------------------------------------------------

/** Fidelity counts for active (non-gone) nodes. */
export interface FidelityBreakdown {
  vivid: number;
  clear: number;
  faded: number;
  gist: number;
}

/** Aggregate health snapshot of the memory v2 graph. */
export interface GraphStats {
  /** Total active (non-gone) node count. */
  total: number;
  /** Node count by MemoryType. */
  byType: Partial<Record<MemoryType, number>>;
  /** Node count by fidelity, excluding gone. */
  byFidelity: FidelityBreakdown;
  /** Nodes with significance < 0.15 (at risk of decaying away). */
  atRisk: number;
  /** Live edge count — both endpoints are non-gone. */
  edgeCount: number;
  /** Epoch ms of the oldest active node, or null if the graph is empty. */
  oldestCreated: number | null;
  /** Epoch ms of the newest active node, or null if the graph is empty. */
  newestCreated: number | null;
  /** Epoch ms of the most recent reinforcement event, or null if none. */
  lastReinforced: number | null;
  /** Mean significance across all active nodes (0–1). */
  avgSignificance: number;
  /** Up to 5 highest-significance nodes (content, significance, fidelity, type). */
  topNodes: Array<{
    content: string;
    significance: number;
    fidelity: string;
    type: string;
  }>;
}

/**
 * Compute a health snapshot of the memory v2 graph in two queries:
 *   1. A full scan of active nodes (significance DESC) to derive all
 *      per-node aggregates in one JS pass.
 *   2. A SQL COUNT of live edges (both endpoints non-gone).
 *
 * Callers that only need the summary number can use `countNodes()` instead.
 */
export async function computeGraphStats(): Promise<GraphStats> {
  // Full scan — significance DESC so topNodes is just the first slice.
  const nodes = await queryNodes({ fidelityNot: ["gone"] });

  const byType: Partial<Record<MemoryType, number>> = {};
  const byFidelity: FidelityBreakdown = {
    vivid: 0,
    clear: 0,
    faded: 0,
    gist: 0,
  };
  let atRisk = 0;
  let sigSum = 0;
  let oldestCreated: number | null = null;
  let newestCreated: number | null = null;
  let lastReinforced: number | null = null;

  for (const n of nodes) {
    byType[n.type] = (byType[n.type] ?? 0) + 1;
    if (n.fidelity !== "gone") {
      byFidelity[n.fidelity as keyof FidelityBreakdown] += 1;
    }
    if (n.significance < 0.15) {
      atRisk++;
    }
    sigSum += n.significance;
    if (oldestCreated === null || n.created < oldestCreated) {
      oldestCreated = n.created;
    }
    if (newestCreated === null || n.created > newestCreated) {
      newestCreated = n.created;
    }
    if (lastReinforced === null || n.lastReinforced > lastReinforced) {
      lastReinforced = n.lastReinforced;
    }
  }

  // Live edge count: both endpoints must be non-gone.
  const db = memoryDb();
  const memoryGraphEdges = db.schema.memoryGraphEdges;
  const memoryGraphNodes = db.schema.memoryGraphNodes;
  const edgeRows = await db.orm
    .select({ count: sql<number>`count(*)` })
    .from(memoryGraphEdges)
    .where(
      and(
        sql`NOT EXISTS (SELECT 1 FROM ${memoryGraphNodes} WHERE ${memoryGraphNodes.id} = ${memoryGraphEdges.sourceNodeId} AND ${memoryGraphNodes.fidelity} = 'gone')`,
        sql`NOT EXISTS (SELECT 1 FROM ${memoryGraphNodes} WHERE ${memoryGraphNodes.id} = ${memoryGraphEdges.targetNodeId} AND ${memoryGraphNodes.fidelity} = 'gone')`,
      ),
    );
  const edgeResult = edgeRows[0];

  return {
    total: nodes.length,
    byType,
    byFidelity,
    atRisk,
    edgeCount: edgeResult?.count ?? 0,
    oldestCreated,
    newestCreated,
    lastReinforced,
    avgSignificance: nodes.length > 0 ? sigSum / nodes.length : 0,
    // nodes is already sorted significance DESC — slice gives the top N.
    topNodes: nodes.slice(0, 5).map((n) => ({
      content: n.content,
      significance: n.significance,
      fidelity: n.fidelity,
      type: n.type,
    })),
  };
}
