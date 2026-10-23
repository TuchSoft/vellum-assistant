/**
 * One-time migration: create the skill grant tombstone store.
 *
 * `skill_grant_tombstones` is declared in `schema.ts`, so the startup schema
 * push already creates it on any database that boots with this build. The
 * migration exists for databases provisioned earlier, where the push may not
 * have run yet (or ran against a binary that predates the table), so a
 * revocation always has somewhere to write from the first request onward.
 *
 * Idempotent: `CREATE TABLE IF NOT EXISTS` and `CREATE UNIQUE INDEX IF NOT
 * EXISTS` make a re-run a no-op, and no existing row is touched.
 *
 * `down()` is intentionally a no-op: the migration is additive, and dropping
 * the table would let the seed resurrect grants a user revoked.
 */

import type { Database } from "bun:sqlite";

import { getLogger } from "../../logger.js";
import { getGatewayDb } from "../connection.js";

import type { MigrationResult } from "./index.js";

const log = getLogger("m0020-skill-grant-tombstones-table");

function getRawGatewayDb(): Database {
  return (getGatewayDb() as unknown as { $client: Database }).$client;
}

export function up(): MigrationResult {
  try {
    const db = getRawGatewayDb();

    db.exec(/*sql*/ `
      CREATE TABLE IF NOT EXISTS skill_grant_tombstones (
        skill_id TEXT NOT NULL,
        version_hash TEXT NOT NULL,
        revoked_at INTEGER NOT NULL
      )
    `);

    db.exec(/*sql*/ `
      CREATE UNIQUE INDEX IF NOT EXISTS idx_skill_grant_tombstones_skill_version
        ON skill_grant_tombstones (skill_id, version_hash)
    `);

    log.info("Ensured skill_grant_tombstones table and its index exist");
    return "done";
  } catch (err) {
    log.error({ err }, "Failed to create the skill_grant_tombstones table");
    return "skip";
  }
}

export function down(): MigrationResult {
  return "done";
}
