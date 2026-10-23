/**
 * The ordered Postgres migration step list.
 *
 * Step `0000_baseline` materialises the schema captured from the live SQLite
 * databases (see `baseline.generated.ts`). It applies only when the application
 * schema does not exist yet; on an already-migrated database the ordered steps
 * own every change, so the retired baseline DDL is never replayed.
 *
 * Data backfills: append ONE entry per upstream migration that carries data
 * (an UPDATE/INSERT of mass rows). Keep each as its own named step so the
 * ledger checkpoints it independently, and make it idempotent (a re-run after
 * an interrupted apply must not double-apply). Schema-only upstream changes do
 * not need a step here: they are captured by regenerating the baseline while
 * the port is in its baseline phase, and by `drizzle-kit generate` afterwards
 * (see `assistant/drizzle.config.ts`).
 */

import { applyBaselineIfNeeded } from "./apply-baseline.js";
import { BASELINE_STATEMENTS, BASELINE_TABLES } from "./baseline.generated.js";
import type { PgMigrationStep } from "./run-pg-migrations.js";

const IDENTIFIER = /^[A-Za-z_][A-Za-z0-9_]*$/;

export const PG_STEPS: readonly PgMigrationStep[] = [
  {
    name: "0000_baseline",
    up: async (db) => {
      // Only on an empty database: replaying the snapshot on an evolved schema
      // would re-create indexes over columns later steps have dropped.
      await applyBaselineIfNeeded(db, BASELINE_STATEMENTS);
    },
    down: async (db) => {
      const drops = [...BASELINE_TABLES].reverse().map((table) => {
        if (!IDENTIFIER.test(table)) {
          throw new Error(`refusing to drop unsafe identifier: ${table}`);
        }
        return `DROP TABLE IF EXISTS "${table}" CASCADE`;
      });
      for (const statement of drops) {
        await db.exec(statement);
      }
    },
  },
  {
    name: "0001_drop_memory_v2_tables",
    up: async (db) => {
      for (const table of [
        "memory_v2_activation_logs",
        "memory_v2_injection_events",
        "activation_state",
      ]) {
        await db.exec(`DROP TABLE IF EXISTS "${table}" CASCADE`);
      }
    },
    down: async (db) => {
      // Recreate the retired shapes (empty) so a rollback past this step leaves
      // the ledger and schema in agreement.
      await db.exec(
        `CREATE TABLE IF NOT EXISTS "activation_state" (
          "conversation_id" text PRIMARY KEY,
          "message_id" text NOT NULL,
          "state_json" text NOT NULL,
          "ever_injected_json" text NOT NULL DEFAULT '[]',
          "current_turn" bigint NOT NULL DEFAULT 0,
          "updated_at" bigint NOT NULL
        )`,
      );
      await db.exec(
        `CREATE TABLE IF NOT EXISTS "memory_v2_activation_logs" (
          "id" text PRIMARY KEY,
          "conversation_id" text NOT NULL,
          "message_id" text,
          "turn" bigint NOT NULL,
          "mode" text NOT NULL,
          "concepts_json" text NOT NULL,
          "skills_json" text NOT NULL,
          "config_json" text NOT NULL,
          "created_at" bigint NOT NULL
        )`,
      );
      await db.exec(
        `CREATE TABLE IF NOT EXISTS "memory_v2_injection_events" (
          "id" bigint PRIMARY KEY,
          "slug" text NOT NULL,
          "injected_at" bigint NOT NULL
        )`,
      );
      await db.exec(
        `CREATE INDEX IF NOT EXISTS "idx_memory_v2_activation_logs_created_at" ON "memory_v2_activation_logs" ("created_at")`,
      );
      await db.exec(
        `CREATE INDEX IF NOT EXISTS "idx_memory_v2_activation_logs_conversation_id" ON "memory_v2_activation_logs" ("conversation_id")`,
      );
      await db.exec(
        `CREATE INDEX IF NOT EXISTS "idx_memory_v2_activation_logs_message_id" ON "memory_v2_activation_logs" ("message_id")`,
      );
      await db.exec(
        `CREATE INDEX IF NOT EXISTS "idx_memory_v2_injection_events_time" ON "memory_v2_injection_events" ("injected_at")`,
      );
      await db.exec(
        `CREATE INDEX IF NOT EXISTS "idx_memory_v2_injection_events_slug_time" ON "memory_v2_injection_events" ("slug", "injected_at")`,
      );
    },
  },
  // --- Data backfills appended below, one named step each. ---
  {
    name: "0002_alias_model_columns",
    up: async (db) => {
      // Additive first, so an interrupted run can always be re-entered.
      await db.exec(
        `ALTER TABLE "conversations" ADD COLUMN IF NOT EXISTS "model" text`,
      );
      await db.exec(
        `ALTER TABLE "conversations" ADD COLUMN IF NOT EXISTS "reasoning_effort" text`,
      );
      await db.exec(
        `ALTER TABLE "conversations" ADD COLUMN IF NOT EXISTS "last_notified_model" text`,
      );
      await db.exec(
        `ALTER TABLE "cron_jobs" ADD COLUMN IF NOT EXISTS "model" text`,
      );
      await db.exec(
        `ALTER TABLE "tool_invocations" ADD COLUMN IF NOT EXISTS "model_source" text`,
      );
      await db.exec(
        `ALTER TABLE "llm_usage_events" ADD COLUMN IF NOT EXISTS "model_source" text`,
      );

      // Legacy profile keys map onto the shipped aliases. Custom names and
      // dangling references ("kimi", "browseruse", "computer-use") become
      // NULL, which means "use defaultModel".
      const mapped = `CASE "inference_profile"
        WHEN 'balanced' THEN 'main'
        WHEN 'quality-optimized' THEN 'main-pro'
        WHEN 'cost-optimized' THEN 'small'
        WHEN 'latency-optimized' THEN 'fast'
        WHEN 'jev-managed' THEN 'fast'
        WHEN 'main' THEN 'main'
        WHEN 'main-pro' THEN 'main-pro'
        WHEN 'small' THEN 'small'
        WHEN 'fast' THEN 'fast'
        ELSE NULL
      END`;
      await db.exec(
        `UPDATE "conversations" SET "model" = ${mapped} WHERE "model" IS NULL AND "inference_profile" IS NOT NULL`,
      );
      await db.exec(
        `UPDATE "cron_jobs" SET "model" = ${mapped} WHERE "model" IS NULL AND "inference_profile" IS NOT NULL`,
      );

      const source = `CASE "inference_profile_source"
        WHEN 'override' THEN 'chat'
        WHEN 'active' THEN 'chat'
        WHEN 'auto' THEN 'chat'
        WHEN 'call_site' THEN 'call_site'
        WHEN 'default' THEN 'default'
        ELSE NULL
      END`;
      await db.exec(
        `UPDATE "tool_invocations" SET "model_source" = ${source} WHERE "model_source" IS NULL AND "inference_profile_source" IS NOT NULL`,
      );
      await db.exec(
        `UPDATE "llm_usage_events" SET "model_source" = ${source} WHERE "model_source" IS NULL AND "inference_profile_source" IS NOT NULL`,
      );

      // Remove the retired columns only after the data has landed.
      for (const [table, column] of [
        ["conversations", "inference_profile"],
        ["conversations", "inference_profile_session_id"],
        ["conversations", "inference_profile_expires_at"],
        ["conversations", "last_notified_inference_profile"],
        ["cron_jobs", "inference_profile"],
        ["tool_invocations", "inference_profile"],
        ["tool_invocations", "inference_profile_source"],
        ["llm_usage_events", "inference_profile"],
        ["llm_usage_events", "inference_profile_source"],
      ]) {
        await db.exec(
          `ALTER TABLE "${table}" DROP COLUMN IF EXISTS "${column}"`,
        );
      }
    },
    down: async (db) => {
      await db.exec(
        `ALTER TABLE "conversations" ADD COLUMN IF NOT EXISTS "inference_profile" text`,
      );
      await db.exec(
        `ALTER TABLE "conversations" ADD COLUMN IF NOT EXISTS "inference_profile_session_id" text`,
      );
      await db.exec(
        `ALTER TABLE "conversations" ADD COLUMN IF NOT EXISTS "inference_profile_expires_at" bigint`,
      );
      await db.exec(
        `ALTER TABLE "conversations" ADD COLUMN IF NOT EXISTS "last_notified_inference_profile" text`,
      );
      await db.exec(
        `ALTER TABLE "cron_jobs" ADD COLUMN IF NOT EXISTS "inference_profile" text`,
      );
      await db.exec(
        `ALTER TABLE "tool_invocations" ADD COLUMN IF NOT EXISTS "inference_profile" text`,
      );
      await db.exec(
        `ALTER TABLE "tool_invocations" ADD COLUMN IF NOT EXISTS "inference_profile_source" text`,
      );
      await db.exec(
        `ALTER TABLE "llm_usage_events" ADD COLUMN IF NOT EXISTS "inference_profile" text`,
      );
      await db.exec(
        `ALTER TABLE "llm_usage_events" ADD COLUMN IF NOT EXISTS "inference_profile_source" text`,
      );
      await db.exec(
        `UPDATE "conversations" SET "inference_profile" = "model" WHERE "inference_profile" IS NULL`,
      );
      await db.exec(
        `UPDATE "cron_jobs" SET "inference_profile" = "model" WHERE "inference_profile" IS NULL`,
      );
      await db.exec(
        `UPDATE "tool_invocations" SET "inference_profile_source" = "model_source" WHERE "inference_profile_source" IS NULL`,
      );
      await db.exec(
        `UPDATE "llm_usage_events" SET "inference_profile_source" = "model_source" WHERE "inference_profile_source" IS NULL`,
      );
    },
  },
  {
    name: "0003_projects",
    up: async (db) => {
      const now = Date.now();

      // Additive first: every statement below is safe to re-run, so an
      // interrupted apply resumes instead of failing on a half-built schema.
      await db.exec(
        `CREATE TABLE IF NOT EXISTS "projects" (
          "id" text PRIMARY KEY,
          "name" text NOT NULL,
          "description" text,
          "parent_id" text REFERENCES "projects"("id") ON DELETE SET NULL,
          "kind" text NOT NULL DEFAULT 'user',
          "sort_position" double precision NOT NULL DEFAULT 0,
          "is_archived" boolean NOT NULL DEFAULT false,
          "created_at" bigint NOT NULL,
          "updated_at" bigint NOT NULL,
          "archived_at" bigint,
          CONSTRAINT "projects_kind_check" CHECK ("kind" IN ('user', 'system', 'inbox')),
          CONSTRAINT "projects_inbox_not_archived_check" CHECK ("kind" <> 'inbox' OR "archived_at" IS NULL)
        )`,
      );
      await db.exec(
        `CREATE UNIQUE INDEX IF NOT EXISTS "projects_inbox_singleton" ON "projects" ("kind") WHERE "kind" = 'inbox'`,
      );
      await db.exec(
        `CREATE INDEX IF NOT EXISTS "idx_projects_parent" ON "projects" ("parent_id")`,
      );
      await db.exec(
        `CREATE INDEX IF NOT EXISTS "idx_projects_kind_archived" ON "projects" ("kind", "is_archived")`,
      );
      await db.exec(
        `CREATE TABLE IF NOT EXISTS "conversation_projects" (
          "conversation_id" text NOT NULL REFERENCES "conversations"("id") ON DELETE CASCADE,
          "project_id" text NOT NULL REFERENCES "projects"("id") ON DELETE CASCADE,
          PRIMARY KEY ("conversation_id", "project_id")
        )`,
      );
      await db.exec(
        `CREATE INDEX IF NOT EXISTS "idx_conversation_projects_project" ON "conversation_projects" ("project_id")`,
      );

      // The Inbox singleton. `ON CONFLICT DO NOTHING` keeps a re-run inert and
      // never overwrites a name the user has since changed.
      await db.run(
        `INSERT INTO "projects" ("id", "name", "kind", "sort_position", "is_archived", "created_at", "updated_at")
         VALUES ('inbox', 'Inbox', 'inbox', -1, FALSE, ?, ?)
         ON CONFLICT ("id") DO NOTHING`,
        [now, now],
      );

      // `conversation_groups` and `conversations.group_id` are created by the
      // runtime group migration, not by the baseline, so a database that has
      // not run it yet has nothing to backfill. On an upgrade they exist and
      // carry the groups this step converts.
      const groupSchema: { groups: boolean; group_id: boolean } | null =
        await db.get<{ groups: boolean; group_id: boolean }>(
          `SELECT
             to_regclass('conversation_groups') IS NOT NULL AS groups,
             EXISTS (
               SELECT 1 FROM information_schema.columns
               WHERE table_schema = current_schema()
                 AND table_name = 'conversations'
                 AND column_name = 'group_id'
             ) AS group_id`,
        );

      if (groupSchema?.groups === true && groupSchema?.group_id === true) {
        // User groups become user projects, keeping the group id as the project
        // id so the mapping is stable and the membership backfill below is a
        // straight join. `_`-prefixed ids are migration markers, not groups.
        await db.exec(
          `INSERT INTO "projects" ("id", "name", "kind", "sort_position", "created_at", "updated_at")
           SELECT g."id", g."name", 'user', g."sort_position", g."created_at", g."updated_at"
           FROM "conversation_groups" g
           WHERE g."is_system_group" = FALSE AND substr(g."id", 1, 1) <> '_'
           ON CONFLICT ("id") DO NOTHING`,
        );

        // The background and scheduled buckets keep their own system project
        // rather than collapsing into the Inbox.
        await db.exec(
          `INSERT INTO "projects" ("id", "name", "kind", "sort_position", "created_at", "updated_at")
           SELECT g."id", g."name", 'system', g."sort_position", g."created_at", g."updated_at"
           FROM "conversation_groups" g
           WHERE g."id" IN ('system:background', 'system:scheduled')
           ON CONFLICT ("id") DO NOTHING`,
        );

        // Membership for conversations that belonged to a migrated project.
        // `system:all` and `system:pinned` have no project row, so they fall
        // through to the Inbox insert below.
        await db.exec(
          `INSERT INTO "conversation_projects" ("conversation_id", "project_id")
           SELECT c."id", c."group_id"
           FROM "conversations" c
           JOIN "projects" p ON p."id" = c."group_id"
           WHERE c."group_id" IS NOT NULL
           ON CONFLICT ("conversation_id", "project_id") DO NOTHING`,
        );
        await db.exec(
          `INSERT INTO "conversation_projects" ("conversation_id", "project_id")
           SELECT c."id", 'inbox'
           FROM "conversations" c
           WHERE c."group_id" IS NULL OR c."group_id" IN ('system:all', 'system:pinned')
           ON CONFLICT ("conversation_id", "project_id") DO NOTHING`,
        );
      }

      // The two system projects exist even when the group rows are absent, so
      // the rest of the model has a stable place for background and scheduled
      // runs.
      await db.run(
        `INSERT INTO "projects" ("id", "name", "kind", "sort_position", "created_at", "updated_at")
         VALUES
           ('system:background', 'Background', 'system', 1, ?, ?),
           ('system:scheduled', 'Scheduled', 'system', 2, ?, ?)
         ON CONFLICT ("id") DO NOTHING`,
        [now, now, now, now],
      );
    },
    down: async (db) => {
      await db.exec(`DROP TABLE IF EXISTS "conversation_projects"`);
      await db.exec(`DROP TABLE IF EXISTS "projects"`);
    },
  },
  {
    name: "0004_cron_job_projects",
    up: async (db) => {
      // Additive and idempotent: an interrupted apply leaves a table that the
      // re-run completes, and neither statement depends on data.
      await db.exec(
        `CREATE TABLE IF NOT EXISTS "cron_job_projects" (
          "cron_job_id" text NOT NULL REFERENCES "cron_jobs"("id") ON DELETE CASCADE,
          "project_id" text NOT NULL REFERENCES "projects"("id") ON DELETE CASCADE,
          PRIMARY KEY ("cron_job_id", "project_id")
        )`,
      );
      await db.exec(
        `CREATE INDEX IF NOT EXISTS "idx_cron_job_projects_project" ON "cron_job_projects" ("project_id")`,
      );
    },
    down: async (db) => {
      await db.exec(`DROP TABLE IF EXISTS "cron_job_projects"`);
    },
  },
];
