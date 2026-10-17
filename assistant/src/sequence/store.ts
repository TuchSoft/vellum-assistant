/**
 * Postgres-backed sequence store.
 *
 * Follows the same patterns as schedule-store.ts:
 * - Flat exported functions (no class)
 * - requireMainDb() called inside each function
 * - Optimistic locking for claimDueEnrollments
 */

import { and, asc, eq, lte, sql } from "drizzle-orm";
import { v4 as uuid } from "uuid";

import type { SchemaTables } from "../persistence/db-facade.js";
import { requireMainDb } from "../persistence/db-facade.js";
import { isLifecycleQuiesced } from "../persistence/lifecycle-quiesce.js";
import { AssistantError, ErrorCode } from "../util/errors.js";
import {
  cast,
  createRowMapper,
  parseJson,
  parseJsonNullable,
} from "../util/row-mapper.js";
import type {
  CreateSequenceInput,
  EnrollContactInput,
  EnrollmentExitReason,
  ListEnrollmentsFilter,
  ListSequencesFilter,
  Sequence,
  SequenceEnrollment,
  SequenceStep,
  UpdateSequenceInput,
} from "./types.js";

type SequenceRow = SchemaTables["sequences"]["$inferSelect"];
type SequenceEnrollmentRow =
  SchemaTables["sequenceEnrollments"]["$inferSelect"];

const parseSequenceRow = createRowMapper<SequenceRow, Sequence>({
  id: "id",
  name: "name",
  description: "description",
  channel: "channel",
  steps: { from: "steps", transform: parseJson<SequenceStep[]>([]) },
  exitOnReply: "exitOnReply",
  status: { from: "status", transform: cast<Sequence["status"]>() },
  createdAt: "createdAt",
  updatedAt: "updatedAt",
});

const parseEnrollmentRow = createRowMapper<
  SequenceEnrollmentRow,
  SequenceEnrollment
>({
  id: "id",
  sequenceId: "sequenceId",
  contactEmail: "contactEmail",
  contactName: "contactName",
  currentStep: "currentStep",
  status: { from: "status", transform: cast<SequenceEnrollment["status"]>() },
  conversationId: "conversationId",
  nextStepAt: "nextStepAt",
  context: {
    from: "context",
    transform: parseJsonNullable<Record<string, unknown>>(),
  },
  createdAt: "createdAt",
  updatedAt: "updatedAt",
});

export async function createSequence(
  input: CreateSequenceInput,
): Promise<Sequence> {
  const db = requireMainDb();
  const sequences = db.schema.sequences;
  const now = Date.now();
  const row = {
    id: uuid(),
    name: input.name,
    description: input.description ?? null,
    channel: input.channel,
    steps: JSON.stringify(input.steps),
    exitOnReply: input.exitOnReply ?? true,
    status: "active" as const,
    createdAt: now,
    updatedAt: now,
  };
  await db.orm.insert(sequences).values(row);
  return parseSequenceRow(row);
}

export async function getSequence(id: string): Promise<Sequence | undefined> {
  const db = requireMainDb();
  const sequences = db.schema.sequences;
  const rows = await db.orm
    .select()
    .from(sequences)
    .where(eq(sequences.id, id));
  return rows[0] ? parseSequenceRow(rows[0]) : undefined;
}

export async function listSequences(
  filter?: ListSequencesFilter,
): Promise<Sequence[]> {
  const db = requireMainDb();
  const sequences = db.schema.sequences;
  const conditions = [];
  if (filter?.status) {
    conditions.push(eq(sequences.status, filter.status));
  }

  const rows =
    conditions.length > 0
      ? await db.orm
          .select()
          .from(sequences)
          .where(and(...conditions))
      : await db.orm.select().from(sequences);
  return rows.map(parseSequenceRow);
}

export async function updateSequence(
  id: string,
  patch: UpdateSequenceInput,
): Promise<Sequence | undefined> {
  const db = requireMainDb();
  const sequences = db.schema.sequences;
  const now = Date.now();
  const set: Partial<typeof sequences.$inferInsert> = { updatedAt: now };
  if (patch.name !== undefined) {
    set.name = patch.name;
  }
  if (patch.description !== undefined) {
    set.description = patch.description;
  }
  if (patch.steps !== undefined) {
    set.steps = JSON.stringify(patch.steps);
  }
  if (patch.exitOnReply !== undefined) {
    set.exitOnReply = patch.exitOnReply;
  }
  if (patch.status !== undefined) {
    set.status = patch.status;
  }

  await db.orm.update(sequences).set(set).where(eq(sequences.id, id));
  return await getSequence(id);
}

export async function deleteSequence(id: string): Promise<void> {
  const db = requireMainDb();
  const sequenceEnrollments = db.schema.sequenceEnrollments;
  const sequences = db.schema.sequences;
  // Cancel all active enrollments first (cascade handles FK, but we want explicit status update)
  await db.orm
    .update(sequenceEnrollments)
    .set({ status: "cancelled", updatedAt: Date.now() })
    .where(
      and(
        eq(sequenceEnrollments.sequenceId, id),
        eq(sequenceEnrollments.status, "active"),
      ),
    );
  await db.orm.delete(sequences).where(eq(sequences.id, id));
}

export async function enrollContact(
  input: EnrollContactInput,
): Promise<SequenceEnrollment> {
  const db = requireMainDb();
  const sequenceEnrollments = db.schema.sequenceEnrollments;
  const now = Date.now();

  // Look up the sequence to compute initial nextStepAt
  const seq = await getSequence(input.sequenceId);
  if (!seq) {
    throw new AssistantError(
      `Sequence not found: ${input.sequenceId}`,
      ErrorCode.INTERNAL_ERROR,
    );
  }
  if (seq.steps.length === 0) {
    throw new AssistantError("Sequence has no steps", ErrorCode.INTERNAL_ERROR);
  }

  const firstStep = seq.steps[0];
  const nextStepAt = now + firstStep.delaySeconds * 1000;

  const row = {
    id: uuid(),
    sequenceId: input.sequenceId,
    contactEmail: input.contactEmail.toLowerCase(),
    contactName: input.contactName ?? null,
    currentStep: 0,
    status: "active" as const,
    conversationId: null,
    nextStepAt,
    context: input.context ? JSON.stringify(input.context) : null,
    createdAt: now,
    updatedAt: now,
  };
  await db.orm.insert(sequenceEnrollments).values(row);
  return parseEnrollmentRow(row);
}

export async function getEnrollment(
  id: string,
): Promise<SequenceEnrollment | undefined> {
  const db = requireMainDb();
  const sequenceEnrollments = db.schema.sequenceEnrollments;
  const rows = await db.orm
    .select()
    .from(sequenceEnrollments)
    .where(eq(sequenceEnrollments.id, id));
  return rows[0] ? parseEnrollmentRow(rows[0]) : undefined;
}

export async function listEnrollments(
  filter?: ListEnrollmentsFilter,
): Promise<SequenceEnrollment[]> {
  const db = requireMainDb();
  const sequenceEnrollments = db.schema.sequenceEnrollments;
  const conditions = [];
  if (filter?.sequenceId) {
    conditions.push(eq(sequenceEnrollments.sequenceId, filter.sequenceId));
  }
  if (filter?.status) {
    conditions.push(eq(sequenceEnrollments.status, filter.status));
  }
  if (filter?.contactEmail) {
    conditions.push(eq(sequenceEnrollments.contactEmail, filter.contactEmail));
  }

  const rows =
    conditions.length > 0
      ? await db.orm
          .select()
          .from(sequenceEnrollments)
          .where(and(...conditions))
      : await db.orm.select().from(sequenceEnrollments);
  return rows.map(parseEnrollmentRow);
}

/**
 * Atomically claim enrollments that are due for processing.
 *
 * Uses the same optimistic locking pattern as claimDueSchedules:
 * 1. Query candidates (status=active, nextStepAt <= now)
 * 2. For each, UPDATE with WHERE status='active'  (only succeeds if not already claimed)
 * 3. Check the returning rows to confirm the lock was acquired
 */
export async function claimDueEnrollments(
  now: number,
  limit = 10,
): Promise<SequenceEnrollment[]> {
  // Drain gate: while a quiesce lease is active, claim nothing; a sequence
  // step's outreach starts before any row the drain snapshot can see.
  // Fail-open via the lease read.
  if (await isLifecycleQuiesced()) {
    return [];
  }

  const db = requireMainDb();
  const sequenceEnrollments = db.schema.sequenceEnrollments;
  const candidates = await db.orm
    .select()
    .from(sequenceEnrollments)
    .where(
      and(
        eq(sequenceEnrollments.status, "active"),
        lte(sequenceEnrollments.nextStepAt, now),
      ),
    )
    .orderBy(asc(sequenceEnrollments.nextStepAt))
    .limit(limit);

  const claimed: SequenceEnrollment[] = [];
  for (const row of candidates) {
    // Optimistic lock: null out nextStepAt to prevent the row from being
    // picked up by a concurrent claim. The WHERE on the old nextStepAt value
    // ensures only one claimer wins (same pattern as reminders changing
    // status from 'pending' to 'firing').
    const locked = await db.orm
      .update(sequenceEnrollments)
      .set({ nextStepAt: null, updatedAt: now })
      .where(
        and(
          eq(sequenceEnrollments.id, row.id),
          eq(sequenceEnrollments.status, "active"),
          sql`${sequenceEnrollments.nextStepAt} = ${row.nextStepAt}`,
        ),
      )
      .returning({ id: sequenceEnrollments.id });

    if (locked.length === 0) {
      continue;
    }

    claimed.push(
      parseEnrollmentRow({ ...row, nextStepAt: null, updatedAt: now }),
    );
  }
  return claimed;
}

export async function advanceEnrollment(
  id: string,
  conversationId?: string,
  nextStepAt?: number | null,
): Promise<SequenceEnrollment | undefined> {
  const db = requireMainDb();
  const sequenceEnrollments = db.schema.sequenceEnrollments;
  const now = Date.now();

  // Load current to increment step
  const current = await getEnrollment(id);
  if (!current) {
    return undefined;
  }

  const set: Partial<typeof sequenceEnrollments.$inferInsert> = {
    updatedAt: now,
    currentStep: current.currentStep + 1,
  };
  if (conversationId !== undefined) {
    set.conversationId = conversationId;
  }
  if (nextStepAt !== undefined) {
    set.nextStepAt = nextStepAt;
  }

  await db.orm
    .update(sequenceEnrollments)
    .set(set)
    .where(eq(sequenceEnrollments.id, id));

  return await getEnrollment(id);
}

export async function exitEnrollment(
  id: string,
  reason: EnrollmentExitReason,
): Promise<void> {
  const db = requireMainDb();
  const sequenceEnrollments = db.schema.sequenceEnrollments;
  await db.orm
    .update(sequenceEnrollments)
    .set({ status: reason, nextStepAt: null, updatedAt: Date.now() })
    .where(eq(sequenceEnrollments.id, id));
}

/** Pause an active enrollment; preserves current step so it can be resumed later. */
export async function pauseEnrollment(id: string): Promise<void> {
  const db = requireMainDb();
  const sequenceEnrollments = db.schema.sequenceEnrollments;
  await db.orm
    .update(sequenceEnrollments)
    .set({ status: "paused", nextStepAt: null, updatedAt: Date.now() })
    .where(eq(sequenceEnrollments.id, id));
}

/** Resume a paused enrollment; re-activates it so the scheduler picks it up. */
export async function resumeEnrollment(id: string): Promise<void> {
  const db = requireMainDb();
  const sequenceEnrollments = db.schema.sequenceEnrollments;
  const now = Date.now();
  await db.orm
    .update(sequenceEnrollments)
    .set({ status: "active", nextStepAt: now, updatedAt: now })
    .where(eq(sequenceEnrollments.id, id));
}

export async function findActiveEnrollmentsByEmail(
  email: string,
): Promise<SequenceEnrollment[]> {
  const db = requireMainDb();
  const sequenceEnrollments = db.schema.sequenceEnrollments;
  const rows = await db.orm
    .select()
    .from(sequenceEnrollments)
    .where(
      and(
        eq(sequenceEnrollments.contactEmail, email),
        eq(sequenceEnrollments.status, "active"),
      ),
    );
  return rows.map(parseEnrollmentRow);
}

export async function countActiveEnrollments(
  sequenceId: string,
): Promise<number> {
  const db = requireMainDb();
  const sequenceEnrollments = db.schema.sequenceEnrollments;
  const rows = await db.orm
    .select()
    .from(sequenceEnrollments)
    .where(
      and(
        eq(sequenceEnrollments.sequenceId, sequenceId),
        eq(sequenceEnrollments.status, "active"),
      ),
    );
  return rows.length;
}

/** Re-set nextStepAt without advancing the step counter (e.g., when re-scheduling after a pause). */
export async function rescheduleEnrollment(
  id: string,
  nextStepAt: number,
): Promise<void> {
  const db = requireMainDb();
  const sequenceEnrollments = db.schema.sequenceEnrollments;
  await db.orm
    .update(sequenceEnrollments)
    .set({ nextStepAt, updatedAt: Date.now() })
    .where(eq(sequenceEnrollments.id, id));
}

/** Persist a conversation ID on an enrollment without advancing the step counter. */
export async function updateEnrollmentConversationId(
  id: string,
  conversationId: string,
): Promise<void> {
  const db = requireMainDb();
  const sequenceEnrollments = db.schema.sequenceEnrollments;
  await db.orm
    .update(sequenceEnrollments)
    .set({ conversationId, updatedAt: Date.now() })
    .where(eq(sequenceEnrollments.id, id));
}
