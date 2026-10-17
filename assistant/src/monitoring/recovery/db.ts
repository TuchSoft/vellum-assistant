/**
 * Shared database access for the monitor's recovery steps.
 *
 * Recovery runs OUT OF PROCESS from the daemon, so it never uses the daemon's
 * `requireMainDb()` singleton lifecycle. It resolves the shared Postgres facade
 * from the same `VELLUM_DATABASE_URL` instead, and every step awaits its
 * queries.
 */

import type { AsyncDb } from "../../persistence/db-facade.js";
import { getAsyncDb } from "../../persistence/db-facade.js";
import { getLogger } from "../../util/logger.js";
import { readDaemonBootTime } from "../daemon-boot-time.js";

const log = getLogger("recovery-db");

/**
 * Resolve the facade pointing at the daemon's database. Returns null when no
 * database URL is configured, so a step keeps its existing "nothing to do"
 * branch rather than throwing.
 */
export function openRecoveryDb(): AsyncDb | null {
  return getAsyncDb();
}

/**
 * Run one recovery step against a boot-fenced database handle.
 *
 * Every step reconciles rows a dead process left behind, so every step needs
 * the same two guards first: a daemon boot time to fence against (without it
 * a live daemon's in-flight row is indistinguishable from a dead process's
 * orphan) and an available database. `run` is invoked only when both hold.
 *
 * Steps keep their own logger and their own result logging: this owns the
 * preconditions, not what a step does or says. A throw propagates to the
 * orchestrator, which treats it as "schema not ready yet" and retries on the
 * next monitor run.
 */
export async function withBootFencedRecoveryDb(
  step: string,
  run: (db: AsyncDb, bootTime: number) => void | Promise<void>,
): Promise<void> {
  const bootTime = readDaemonBootTime();
  if (bootTime == null) {
    log.warn({ step }, "Skipping recovery step: daemon boot time unavailable");
    return;
  }
  const db = openRecoveryDb();
  if (db == null) {
    return;
  }
  await run(db, bootTime);
}
