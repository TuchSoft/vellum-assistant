/**
 * CRUD operations for notification preferences.
 *
 * Each row stores a natural-language notification preference expressed by
 * the user (e.g. "Use Telegram for urgent alerts"), along with structured
 * conditions for when the preference applies and a priority for conflict
 * resolution.
 */

import { desc } from "drizzle-orm";
import { v4 as uuid } from "uuid";

import type { SchemaTables } from "../persistence/db-facade.js";
import { requireMainDb } from "../persistence/db-facade.js";

// ── Row type ────────────────────────────────────────────────────────────

export interface NotificationPreferenceRow {
  id: string;
  preferenceText: string;
  appliesWhenJson: string; // serialised JSON
  priority: number;
  createdAt: number;
  updatedAt: number;
}

type NotificationPreferenceTableRow =
  SchemaTables["notificationPreferences"]["$inferSelect"];

function rowToPreference(
  row: NotificationPreferenceTableRow,
): NotificationPreferenceRow {
  return {
    id: row.id,
    preferenceText: row.preferenceText,
    appliesWhenJson: row.appliesWhenJson,
    priority: row.priority,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}

// ── Structured conditions type ──────────────────────────────────────────

export interface AppliesWhenConditions {
  timeRange?: { after?: string; before?: string }; // e.g. "22:00", "06:00"
  channels?: string[]; // e.g. ["telegram", "vellum"]
  urgencyLevels?: string[]; // e.g. ["high", "critical"]
  contexts?: string[]; // e.g. ["work_calls", "meetings"]
  [key: string]: unknown;
}

// ── Create ──────────────────────────────────────────────────────────────

export interface CreatePreferenceParams {
  preferenceText: string;
  appliesWhen?: AppliesWhenConditions;
  priority?: number;
}

export async function createPreference(
  params: CreatePreferenceParams,
): Promise<NotificationPreferenceRow> {
  const db = requireMainDb();
  const now = Date.now();

  const row = {
    id: uuid(),
    preferenceText: params.preferenceText,
    appliesWhenJson: JSON.stringify(params.appliesWhen ?? {}),
    priority: params.priority ?? 0,
    createdAt: now,
    updatedAt: now,
  };

  await db.orm.insert(db.schema.notificationPreferences).values(row);

  return row;
}

// ── List ────────────────────────────────────────────────────────────────

export async function listPreferences(): Promise<NotificationPreferenceRow[]> {
  const db = requireMainDb();
  const preferences = db.schema.notificationPreferences;

  const rows = await db.orm
    .select()
    .from(preferences)
    .orderBy(desc(preferences.priority));

  return rows.map(rowToPreference);
}
