/**
 * The ordered Postgres migration step list.
 *
 * Step `0000_baseline` materialises the schema captured from the live SQLite
 * databases (see `baseline.generated.ts`); it is idempotent, so it is safe on
 * both an empty database and one that already has the schema.
 *
 * Data backfills: append ONE entry per upstream migration that carries data
 * (an UPDATE/INSERT of mass rows). Keep each as its own named step so the
 * ledger checkpoints it independently, and make it idempotent (a re-run after
 * an interrupted apply must not double-apply). Schema-only upstream changes do
 * not need a step here: they are captured by regenerating the baseline while
 * the port is in its baseline phase, and by `drizzle-kit generate` afterwards
 * (see `assistant/drizzle.config.ts`).
 */

import { BASELINE_STATEMENTS, BASELINE_TABLES } from "./baseline.generated.js";
import type { PgMigrationStep } from "./run-pg-migrations.js";

const IDENTIFIER = /^[A-Za-z_][A-Za-z0-9_]*$/;

export const PG_STEPS: readonly PgMigrationStep[] = [
  {
    name: "0000_baseline",
    up: async (db) => {
      for (const statement of BASELINE_STATEMENTS) {
        await db.exec(statement);
      }
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
];
