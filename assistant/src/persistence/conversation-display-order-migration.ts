/**
 * Runtime migration for display_order and is_pinned columns on the
 * conversations table. Extracted into its own module to avoid circular
 * dependencies between conversation-crud.ts and conversation-queries.ts
 * (which needs the migration to run before ORDER BY display_order).
 */

import { getLogger } from "../util/logger.js";
import { requireMainDb } from "./db-facade.js";
import { rawRun } from "./raw-query.js";

const log = getLogger("conversation-store");

/** The two runtime columns, as portable DDL both dialects accept. */
const DISPLAY_ORDER_COLUMNS: ReadonlyArray<{ label: string; sql: string }> = [
  {
    label: "display_order",
    sql: "ALTER TABLE conversations ADD COLUMN display_order INTEGER",
  },
  {
    label: "is_pinned",
    sql: "ALTER TABLE conversations ADD COLUMN is_pinned INTEGER DEFAULT 0",
  },
];

function isDuplicateColumnError(err: unknown): boolean {
  return (
    err instanceof Error &&
    (/duplicate column name:/i.test(err.message) ||
      /column .+ already exists/i.test(err.message))
  );
}

let sqliteEnsured = false;
let asyncEnsured = false;

/** Ensure the columns on the SQLite main database (the unported modules). */
export function ensureDisplayOrderMigration(): void {
  if (sqliteEnsured) {
    return;
  }
  for (const column of DISPLAY_ORDER_COLUMNS) {
    try {
      rawRun(`conversation:migrate:${column.label}`, column.sql);
    } catch (err) {
      if (!isDuplicateColumnError(err)) {
        log.error({ err, column: column.label }, "Failed to add column");
        throw err;
      }
    }
  }
  sqliteEnsured = true;
}

/**
 * Ensure the columns through the async facade. These runtime columns are not
 * part of the generated baseline, which only replays the formal migrations.
 */
export async function ensureDisplayOrderMigrationAsync(): Promise<void> {
  const db = requireMainDb();
  if (asyncEnsured) {
    return;
  }
  for (const column of DISPLAY_ORDER_COLUMNS) {
    try {
      await db.run(column.sql);
    } catch (err) {
      if (!isDuplicateColumnError(err)) {
        log.error({ err, column: column.label }, "Failed to add column");
        throw err;
      }
    }
  }
  asyncEnsured = true;
}

/**
 * Reset the in-memory guards so the next ensure re-runs. Intended ONLY for
 * tests that recreate the database mid-process.
 */
export function _resetDisplayOrderMigrationForTests(): void {
  sqliteEnsured = false;
  asyncEnsured = false;
}
