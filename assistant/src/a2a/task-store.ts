import { eq } from "drizzle-orm";

import type { AsyncDb, SchemaTables } from "../persistence/db-facade.js";
import { requireMainDb } from "../persistence/db-facade.js";
import { TERMINAL_TASK_STATES } from "./protocol-constants.js";
import type {
  A2AMessage,
  A2ATask,
  Artifact,
  TaskState,
} from "./protocol-types.js";

// ── Internal types ──────────────────────────────────────────────────

/** Raw database row shape for a2a_tasks. */
type A2ATaskRow = SchemaTables["a2aTasks"]["$inferSelect"];

// ── Helpers ─────────────────────────────────────────────────────────

/** Throw if the task doesn't exist or is in a terminal state. */
async function assertNonTerminal(
  db: AsyncDb,
  taskId: string,
  targetState: TaskState,
): Promise<void> {
  const a2aTasks = db.schema.a2aTasks;
  const rows = await db.orm
    .select({ state: a2aTasks.state })
    .from(a2aTasks)
    .where(eq(a2aTasks.id, taskId));

  const current = rows[0];
  if (!current) {
    throw new Error(`A2A task not found: ${taskId}`);
  }

  if (TERMINAL_TASK_STATES.has(current.state as TaskState)) {
    throw new Error(
      `Cannot transition task ${taskId} from terminal state "${current.state}" to "${targetState}"`,
    );
  }
}

function rowToTask(row: A2ATaskRow): A2ATask {
  return {
    id: row.id,
    context_id: row.contextId ?? undefined,
    status: {
      state: row.state as TaskState,
      message: row.statusMessage
        ? {
            message_id: crypto.randomUUID(),
            role: "agent",
            parts: [{ kind: "text", text: row.statusMessage }],
          }
        : undefined,
      timestamp: new Date(row.updatedAt).toISOString(),
    },
    artifacts: row.artifactsJson
      ? (JSON.parse(row.artifactsJson) as Artifact[])
      : undefined,
  };
}

// ── Store functions ─────────────────────────────────────────────────

export async function createTask(params: {
  contextId?: string;
  senderAssistantId: string;
  requestMessage: A2AMessage;
  pushUrl?: string;
}): Promise<A2ATask> {
  const db = requireMainDb();
  const a2aTasks = db.schema.a2aTasks;
  const now = Date.now();

  const row: A2ATaskRow = {
    id: crypto.randomUUID(),
    contextId: params.contextId ?? null,
    conversationId: null,
    state: "submitted",
    statusMessage: null,
    requestMessageJson: JSON.stringify(params.requestMessage),
    artifactsJson: null,
    pushUrl: params.pushUrl ?? null,
    senderAssistantId: params.senderAssistantId,
    createdAt: now,
    updatedAt: now,
  };

  await db.orm.insert(a2aTasks).values(row);

  return rowToTask(row);
}

export async function getTask(taskId: string): Promise<A2ATask | null> {
  const db = requireMainDb();
  const a2aTasks = db.schema.a2aTasks;
  const rows = await db.orm
    .select()
    .from(a2aTasks)
    .where(eq(a2aTasks.id, taskId));
  return rows[0] ? rowToTask(rows[0]) : null;
}

export async function updateState(
  taskId: string,
  state: TaskState,
  statusMessage?: string,
): Promise<A2ATask> {
  const db = requireMainDb();
  const a2aTasks = db.schema.a2aTasks;
  await assertNonTerminal(db, taskId, state);

  await db.orm
    .update(a2aTasks)
    .set({
      state,
      statusMessage: statusMessage ?? null,
      updatedAt: Date.now(),
    })
    .where(eq(a2aTasks.id, taskId));

  const rows = await db.orm
    .select()
    .from(a2aTasks)
    .where(eq(a2aTasks.id, taskId));
  return rowToTask(rows[0]!);
}

export async function completeWithArtifacts(
  taskId: string,
  artifacts: Artifact[],
): Promise<A2ATask> {
  const db = requireMainDb();
  const a2aTasks = db.schema.a2aTasks;
  await assertNonTerminal(db, taskId, "completed");

  await db.orm
    .update(a2aTasks)
    .set({
      state: "completed",
      statusMessage: null,
      artifactsJson: JSON.stringify(artifacts),
      updatedAt: Date.now(),
    })
    .where(eq(a2aTasks.id, taskId));

  const rows = await db.orm
    .select()
    .from(a2aTasks)
    .where(eq(a2aTasks.id, taskId));
  return rowToTask(rows[0]!);
}

export async function linkConversation(
  taskId: string,
  conversationId: string,
): Promise<void> {
  const db = requireMainDb();
  const a2aTasks = db.schema.a2aTasks;
  const now = Date.now();

  const updated = await db.orm
    .update(a2aTasks)
    .set({ conversationId, updatedAt: now })
    .where(eq(a2aTasks.id, taskId))
    .returning({ id: a2aTasks.id });

  if (updated.length === 0) {
    throw new Error(`A2A task not found: ${taskId}`);
  }
}

export async function getPushUrl(taskId: string): Promise<string | null> {
  const db = requireMainDb();
  const a2aTasks = db.schema.a2aTasks;
  const rows = await db.orm
    .select({ pushUrl: a2aTasks.pushUrl })
    .from(a2aTasks)
    .where(eq(a2aTasks.id, taskId));
  return rows[0]?.pushUrl ?? null;
}
