/**
 * Runtime migration for the conversation_groups table and group_id column
 * on the conversations table. Follows the same lazy-initialization pattern
 * as conversation-display-order-migration.ts.
 *
 * group_id is display/organizational metadata, consistent with how
 * display_order and is_pinned are handled via runtime migration rather
 * than the formal migrations/ pipeline.
 *
 * The SQL is defined once and executed by two runners: the synchronous one
 * (raw helpers, SQLite main database) serves the unported conversation
 * modules, and the async one (the `AsyncDb` facade) serves the ported
 * group-crud and runs on whichever backend the main slot selects.
 */

import { getLogger } from "../util/logger.js";
import {
  ensureDisplayOrderMigration,
  ensureDisplayOrderMigrationAsync,
} from "./conversation-display-order-migration.js";
import type { AsyncDb, SqlParam } from "./db-facade.js";
import { requireMainDb } from "./db-facade.js";
import { rawExec, rawGet, rawRun } from "./raw-query.js";

const log = getLogger("conversation-store");

function isDuplicateColumnError(err: unknown): boolean {
  return (
    err instanceof Error &&
    (/duplicate column name:/i.test(err.message) ||
      /column .+ already exists/i.test(err.message))
  );
}

interface Statement {
  sql: string;
  params?: readonly SqlParam[];
  ignoreDuplicateColumn?: boolean;
}

interface MigrationStep {
  markerId: string;
  statements: Statement[];
}

/**
 * The full migration, as data. Portable across SQLite and Postgres:
 * - `DOUBLE PRECISION` / `BIGINT` / `BOOLEAN` are accepted by both.
 * - `ON CONFLICT DO NOTHING` replaces SQLite's `INSERT OR IGNORE`.
 * - `TRUE` / `FALSE` literals replace SQLite's `1` / `0` for booleans.
 */
function buildMigration(now: number): {
  ddl: Statement[];
  steps: MigrationStep[];
} {
  const markerInsert = (id: string): Statement => ({
    sql: `INSERT INTO conversation_groups (id, name, sort_position, is_system_group, created_at, updated_at)
          VALUES (?, ?, -1, TRUE, ?, ?)
          ON CONFLICT DO NOTHING`,
    params: [id, id, now, now],
  });

  return {
    ddl: [
      {
        sql: `CREATE TABLE IF NOT EXISTS conversation_groups (
          id TEXT PRIMARY KEY,
          name TEXT NOT NULL,
          icon TEXT,
          sort_position DOUBLE PRECISION NOT NULL DEFAULT 0,
          is_system_group BOOLEAN NOT NULL DEFAULT FALSE,
          created_at BIGINT NOT NULL DEFAULT 0,
          updated_at BIGINT NOT NULL DEFAULT 0
        )`,
      },
      {
        sql: "ALTER TABLE conversation_groups ADD COLUMN icon TEXT",
        ignoreDuplicateColumn: true,
      },
      {
        sql: "ALTER TABLE conversations ADD COLUMN group_id TEXT REFERENCES conversation_groups(id) ON DELETE SET NULL",
        ignoreDuplicateColumn: true,
      },
      {
        sql: `INSERT INTO conversation_groups (id, name, sort_position, is_system_group, created_at, updated_at)
              VALUES
                ('system:pinned', 'Pinned', 0, TRUE, ?, ?),
                ('system:scheduled', 'Scheduled', 1, TRUE, ?, ?),
                ('system:background', 'Background', 2, TRUE, ?, ?),
                ('system:all', 'Recents', 3, TRUE, ?, ?)
              ON CONFLICT DO NOTHING`,
        params: [now, now, now, now, now, now, now, now],
      },
    ],
    steps: [
      {
        markerId: "_sort_shift_complete",
        statements: [
          {
            sql: "UPDATE conversation_groups SET sort_position = sort_position + 1 WHERE is_system_group = FALSE AND sort_position >= 3",
          },
          {
            sql: "UPDATE conversation_groups SET sort_position = 3 WHERE id = 'system:all' AND sort_position != 3",
          },
          markerInsert("_sort_shift_complete"),
        ],
      },
      {
        markerId: "_backfill_complete",
        statements: [
          {
            sql: "UPDATE conversations SET group_id = 'system:pinned' WHERE is_pinned = 1 AND group_id IS NULL",
          },
          {
            sql: "UPDATE conversations SET group_id = 'system:scheduled' WHERE (source IN ('schedule', 'reminder') OR schedule_job_id IS NOT NULL OR conversation_type = 'scheduled') AND group_id IS NULL",
          },
          {
            sql: "UPDATE conversations SET group_id = 'system:background' WHERE ((conversation_type = 'background' AND COALESCE(source, '') != 'notification') OR source IN ('heartbeat', 'task')) AND COALESCE(source, '') NOT IN ('schedule', 'reminder') AND schedule_job_id IS NULL AND group_id IS NULL",
          },
          markerInsert("_backfill_complete"),
        ],
      },
      {
        markerId: "_backfill_all_complete",
        statements: [
          {
            sql: "UPDATE conversations SET group_id = 'system:all' WHERE group_id IS NULL",
          },
          markerInsert("_backfill_all_complete"),
        ],
      },
      {
        markerId: "_reflections_to_background_complete",
        statements: [
          {
            sql: "UPDATE conversations SET group_id = 'system:background' WHERE group_id = 'system:reflections'",
          },
          markerInsert("_reflections_to_background_complete"),
        ],
      },
      {
        markerId: "_reflections_group_deleted_complete",
        statements: [
          {
            sql: "UPDATE conversations SET group_id = 'system:background' WHERE group_id = 'system:reflections'",
          },
          {
            sql: "DELETE FROM conversation_groups WHERE id = 'system:reflections'",
          },
          markerInsert("_reflections_group_deleted_complete"),
        ],
      },
    ],
  };
}

/** Run one statement through the synchronous raw helpers. */
function runSyncStatement(statement: Statement): void {
  if (statement.params) {
    rawRun("group:migrate", statement.sql, ...(statement.params as never[]));
  } else {
    rawExec(statement.sql);
  }
}

/** Run the migration on the SQLite main database. */
function runSyncMigration(): void {
  const migration = buildMigration(Math.floor(Date.now() / 1000));

  for (const statement of migration.ddl) {
    try {
      runSyncStatement(statement);
    } catch (err) {
      if (statement.ignoreDuplicateColumn && isDuplicateColumnError(err)) {
        continue;
      }
      throw err;
    }
  }

  for (const step of migration.steps) {
    const marker = rawGet<{ id: string }>(
      "group:migrate:marker",
      "SELECT id FROM conversation_groups WHERE id = ?",
      step.markerId,
    );
    if (marker) {
      continue;
    }
    // The pinned backfill reads `is_pinned`, a runtime column.
    if (step.markerId === "_backfill_complete") {
      ensureDisplayOrderMigration();
    }
    rawExec("BEGIN");
    try {
      for (const statement of step.statements) {
        runSyncStatement(statement);
      }
      rawExec("COMMIT");
    } catch (err) {
      rawExec("ROLLBACK");
      log.error(
        { err, step: step.markerId },
        "Group migration step failed, rolled back",
      );
      throw err;
    }
  }
}

/** Run one statement through the async facade. */
async function runAsyncStatement(
  db: AsyncDb,
  statement: Statement,
): Promise<void> {
  if (statement.params) {
    await db.run(statement.sql, statement.params);
  } else {
    await db.exec(statement.sql);
  }
}

/** Run the migration on the active main backend (Postgres path). */
async function runAsyncMigration(db: AsyncDb): Promise<void> {
  const migration = buildMigration(Math.floor(Date.now() / 1000));

  for (const statement of migration.ddl) {
    try {
      await runAsyncStatement(db, statement);
    } catch (err) {
      if (statement.ignoreDuplicateColumn && isDuplicateColumnError(err)) {
        continue;
      }
      throw err;
    }
  }

  // Runtime columns the generated baseline does not carry.
  await ensureDisplayOrderMigrationAsync();

  for (const step of migration.steps) {
    const marker = await db.get<{ id: string }>(
      "SELECT id FROM conversation_groups WHERE id = ?",
      [step.markerId],
    );
    if (marker) {
      continue;
    }
    await db.transaction(async (tx) => {
      for (const statement of step.statements) {
        await runAsyncStatement(tx, statement);
      }
    });
  }
}

let sqliteMigrated = false;
let asyncMigrated = false;
let asyncMigration: Promise<void> | null = null;

/**
 * Reset the in-memory guards so the next ensure re-runs the full migration.
 * Intended ONLY for tests that recreate the database mid-process.
 */
export function _resetGroupMigrationForTests(): void {
  sqliteMigrated = false;
  asyncMigrated = false;
  asyncMigration = null;
}

/**
 * Ensure the schema on the SQLite main database. Serves the unported
 * conversation modules, which still read and write SQLite.
 */
export function ensureGroupMigration(): void {
  if (sqliteMigrated) {
    return;
  }
  runSyncMigration();
  sqliteMigrated = true;
}

/**
 * Ensure the schema through the async facade, sharing one in-flight promise
 * across concurrent callers.
 */
export async function ensureGroupMigrationAsync(): Promise<void> {
  const db = requireMainDb();
  if (asyncMigrated) {
    return;
  }
  if (asyncMigration) {
    return asyncMigration;
  }
  asyncMigration = runAsyncMigration(db);
  try {
    await asyncMigration;
    asyncMigrated = true;
  } finally {
    asyncMigration = null;
  }
}
