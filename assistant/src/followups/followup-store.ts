import { and, eq, lte, or } from "drizzle-orm";
import { v4 as uuid } from "uuid";

import type { SchemaTables } from "../persistence/db-facade.js";
import { requireMainDb } from "../persistence/db-facade.js";
import type { FollowUp, FollowUpCreateInput, FollowUpStatus } from "./types.js";

/** Row shape of the `followups` table, from the SQLite barrel. */
type FollowUpRow = SchemaTables["followups"]["$inferSelect"];

function parseFollowUp(row: FollowUpRow): FollowUp {
  const scheduleId = row.reminderCronId;
  return {
    id: row.id,
    channel: row.channel,
    conversationId: row.conversationId,
    contactId: row.contactId,
    sentAt: row.sentAt,
    expectedResponseBy: row.expectedResponseBy,
    status: row.status as FollowUpStatus,
    reminderScheduleId: scheduleId,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}

export async function createFollowUp(
  input: FollowUpCreateInput,
): Promise<FollowUp> {
  const db = requireMainDb();
  const followups = db.schema.followups;
  const now = Date.now();
  const id = uuid();

  await db.orm.insert(followups).values({
    id,
    channel: input.channel,
    conversationId: input.conversationId,
    contactId: input.contactId ?? null,
    sentAt: input.sentAt ?? now,
    expectedResponseBy: input.expectedResponseBy ?? null,
    status: "pending",
    reminderCronId: input.reminderScheduleId ?? null,
    createdAt: now,
    updatedAt: now,
  });

  return (await getFollowUp(id))!;
}

async function getFollowUp(id: string): Promise<FollowUp | null> {
  const db = requireMainDb();
  const followups = db.schema.followups;
  const [row] = await db.orm
    .select()
    .from(followups)
    .where(eq(followups.id, id));
  if (!row) {
    return null;
  }
  return parseFollowUp(row);
}

export async function listFollowUps(filter?: {
  status?: FollowUpStatus;
  channel?: string;
  contactId?: string;
}): Promise<FollowUp[]> {
  const db = requireMainDb();
  const followups = db.schema.followups;
  const conditions = [];

  if (filter?.status) {
    conditions.push(eq(followups.status, filter.status));
  }
  if (filter?.channel) {
    conditions.push(eq(followups.channel, filter.channel));
  }
  if (filter?.contactId) {
    conditions.push(eq(followups.contactId, filter.contactId));
  }

  const whereClause =
    conditions.length > 0
      ? conditions.length === 1
        ? conditions[0]
        : and(...conditions)
      : undefined;

  const rows = await db.orm.select().from(followups).where(whereClause);

  return rows.map(parseFollowUp);
}

export async function resolveFollowUp(id: string): Promise<FollowUp> {
  const db = requireMainDb();
  const followups = db.schema.followups;
  const now = Date.now();

  const [existing] = await db.orm
    .select()
    .from(followups)
    .where(eq(followups.id, id));
  if (!existing) {
    throw new Error(`Follow-up "${id}" not found`);
  }

  await db.orm
    .update(followups)
    .set({ status: "resolved", updatedAt: now })
    .where(eq(followups.id, id));

  return (await getFollowUp(id))!;
}

export async function resolveByConversation(
  channel: string,
  conversationId: string,
): Promise<FollowUp[]> {
  const db = requireMainDb();
  const followups = db.schema.followups;
  const now = Date.now();

  // Find ALL pending/overdue/nudged follow-ups matching this conversation
  const rows = await db.orm
    .select()
    .from(followups)
    .where(
      and(
        eq(followups.channel, channel),
        eq(followups.conversationId, conversationId),
        or(
          eq(followups.status, "pending"),
          eq(followups.status, "overdue"),
          eq(followups.status, "nudged"),
        ),
      ),
    );

  if (rows.length === 0) {
    return [];
  }

  for (const row of rows) {
    await db.orm
      .update(followups)
      .set({ status: "resolved", updatedAt: now })
      .where(eq(followups.id, row.id));
  }

  return Promise.all(rows.map(async (row) => (await getFollowUp(row.id))!));
}

export async function getOverdueFollowUps(): Promise<FollowUp[]> {
  const db = requireMainDb();
  const followups = db.schema.followups;
  const now = Date.now();

  const rows = await db.orm
    .select()
    .from(followups)
    .where(
      and(
        eq(followups.status, "pending"),
        lte(followups.expectedResponseBy, now),
      ),
    );

  return rows.map(parseFollowUp);
}
