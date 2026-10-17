/**
 * CRUD operations for conversation groups.
 *
 * All functions ensure the group schema before accessing the database, on the
 * active main backend. The schema ensure is idempotent and shared.
 */

import { v4 as uuid } from "uuid";

import { ensureGroupMigrationAsync } from "./conversation-group-migration.js";
import { requireMainDb } from "./db-facade.js";

export interface ConversationGroupRow {
  id: string;
  name: string;
  /** Client-chosen icon name; null when the group has no explicit icon. */
  icon: string | null;
  sortPosition: number;
  isSystemGroup: boolean;
  createdAt?: number;
  updatedAt?: number;
}

interface GroupDbRow {
  id: string;
  name: string;
  icon: string | null;
  sort_position: number;
  is_system_group: boolean | number;
  created_at: number;
  updated_at: number;
}

/**
 * `is_system_group` is boolean on Postgres (the mirror declares it boolean)
 * and 0/1 on SQLite, so normalize both shapes to a JS boolean.
 */
function toGroupRow(row: GroupDbRow): ConversationGroupRow {
  return {
    id: row.id,
    name: row.name,
    icon: row.icon,
    sortPosition: Number(row.sort_position),
    isSystemGroup: Boolean(row.is_system_group),
    createdAt: Number(row.created_at),
    updatedAt: Number(row.updated_at),
  };
}

// ---------------------------------------------------------------------------
// List
// ---------------------------------------------------------------------------

export async function listGroups(): Promise<ConversationGroupRow[]> {
  await ensureGroupMigrationAsync();
  // Migration markers are stored as rows in conversation_groups with a leading
  // underscore (e.g. `_backfill_complete`). System groups use the `system:`
  // prefix and custom groups use UUIDs, so no legitimate group id starts with
  // `_`. `substr(...)` gives the same first-character test on SQLite and
  // Postgres (SQLite `GLOB` has no Postgres equivalent).
  const db = requireMainDb();
  const rows = await db.all<GroupDbRow>(
    "SELECT id, name, icon, sort_position, is_system_group, created_at, updated_at FROM conversation_groups WHERE substr(id, 1, 1) <> '_' ORDER BY sort_position ASC",
  );
  return rows.map(toGroupRow);
}

// ---------------------------------------------------------------------------
// Get
// ---------------------------------------------------------------------------

export async function getGroup(
  groupId: string,
): Promise<ConversationGroupRow | null> {
  await ensureGroupMigrationAsync();
  const db = requireMainDb();
  const row = await db.get<GroupDbRow>(
    "SELECT id, name, icon, sort_position, is_system_group, created_at, updated_at FROM conversation_groups WHERE id = ?",
    [groupId],
  );
  if (!row) {
    return null;
  }
  return toGroupRow(row);
}

// ---------------------------------------------------------------------------
// Create
// ---------------------------------------------------------------------------

/**
 * Create a custom group. Server assigns sort_position as max(custom) + 1.
 * System groups occupy positions 0-3 (pinned, scheduled, background, all).
 * First custom group gets position 4. Fallback ?? 3 ensures 3 + 1 = 4 when
 * no custom groups exist.
 */
export async function createGroup(
  name: string,
  icon?: string | null,
): Promise<ConversationGroupRow> {
  await ensureGroupMigrationAsync();
  const db = requireMainDb();
  const maxRow = await db.get<{ max: number | null }>(
    "SELECT MAX(sort_position) as max FROM conversation_groups WHERE is_system_group = FALSE",
  );
  const sortPosition = Number(maxRow?.max ?? 3) + 1;
  const id = uuid();
  const now = Math.floor(Date.now() / 1000);
  await db.run(
    "INSERT INTO conversation_groups (id, name, icon, sort_position, is_system_group, created_at, updated_at) VALUES (?, ?, ?, ?, FALSE, ?, ?)",
    [id, name, icon ?? null, sortPosition, now, now],
  );
  return {
    id,
    name,
    icon: icon ?? null,
    sortPosition,
    isSystemGroup: false,
    createdAt: now,
    updatedAt: now,
  };
}

// ---------------------------------------------------------------------------
// Update
// ---------------------------------------------------------------------------

export async function updateGroup(
  groupId: string,
  updates: { name?: string; icon?: string | null; sortPosition?: number },
): Promise<ConversationGroupRow | null> {
  await ensureGroupMigrationAsync();
  const existing = await getGroup(groupId);
  if (!existing) {
    return null;
  }

  const fields: string[] = [];
  const values: (string | number | null)[] = [];

  if (updates.name !== undefined) {
    fields.push("name = ?");
    values.push(updates.name);
  }
  if (updates.icon !== undefined) {
    fields.push("icon = ?");
    values.push(updates.icon);
  }
  if (updates.sortPosition !== undefined) {
    fields.push("sort_position = ?");
    values.push(updates.sortPosition);
  }

  if (fields.length === 0) {
    return existing;
  }

  fields.push("updated_at = ?");
  const now = Math.floor(Date.now() / 1000);
  values.push(now);
  values.push(groupId);

  const db = requireMainDb();
  await db.run(
    `UPDATE conversation_groups SET ${fields.join(", ")} WHERE id = ?`,
    values,
  );

  return getGroup(groupId);
}

// ---------------------------------------------------------------------------
// Delete
// ---------------------------------------------------------------------------

// Reassign conversations to system:all before deleting the group so they
// don't end up with NULL group_id (which would violate the system:all
// invariant). The FK ON DELETE SET NULL would otherwise leave NULLs that
// the one-time backfill won't re-fix.
export async function deleteGroup(groupId: string): Promise<boolean> {
  await ensureGroupMigrationAsync();
  const db = requireMainDb();
  await db.run(
    "UPDATE conversations SET group_id = 'system:all' WHERE group_id = ?",
    [groupId],
  );
  await db.run("DELETE FROM conversation_groups WHERE id = ?", [groupId]);
  return true;
}

// ---------------------------------------------------------------------------
// Reorder
// ---------------------------------------------------------------------------

export async function reorderGroups(
  updates: Array<{ groupId: string; sortPosition: number }>,
): Promise<void> {
  await ensureGroupMigrationAsync();
  const db = requireMainDb();
  const now = Math.floor(Date.now() / 1000);
  await db.transaction(async (tx) => {
    for (const update of updates) {
      // Look up the group first — skip unknown/stale IDs and system groups.
      const group = await tx.get<{
        id: string;
        is_system_group: boolean | number;
      }>("SELECT id, is_system_group FROM conversation_groups WHERE id = ?", [
        update.groupId,
      ]);
      if (!group) {
        continue;
      }
      if (Boolean(group.is_system_group)) {
        continue;
      }

      if (update.sortPosition < 4) {
        throw new Error(
          `Custom group sort_position must be >= 4 (got ${update.sortPosition} for ${update.groupId})`,
        );
      }
      await tx.run(
        "UPDATE conversation_groups SET sort_position = ?, updated_at = ? WHERE id = ?",
        [update.sortPosition, now, update.groupId],
      );
    }
  });
}
