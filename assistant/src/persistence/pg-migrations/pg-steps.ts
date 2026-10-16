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
  // --- Data backfills appended below, one named step each. ---
];
