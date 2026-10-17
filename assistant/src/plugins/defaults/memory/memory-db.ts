import type { AsyncDb } from "../../../persistence/db-facade.js";
import { getMemoryAsyncDb } from "../../../persistence/db-facade.js";
import { getLogger } from "./logging.js";

const log = getLogger("memory-db");

/**
 * The plugin's accessor for the memory domain, which resolves the shared
 * Postgres facade. The memory tables the plugin owns are created by the
 * plugin's schema setup.
 *
 * Fail-soft: returns `null` when the database is unavailable, logging a warn
 * tagged with the calling context. Callers degrade rather than throw, the
 * memory database holds scoring signal and derived state, and losing it must
 * never break routing or a turn. This is the single place plugin code resolves
 * the memory connection; new plugin modules should import it from here rather
 * than reaching into `persistence/db-facade` directly.
 */
export function memoryDbOrNull(context: string): AsyncDb | null {
  const db = getMemoryAsyncDb();
  if (!db) {
    log.warn(
      { context },
      "memory database unavailable; memory-db reads/writes degraded",
    );
  }
  return db;
}

/** The facade {@link memoryDbOrNull} resolves, for modules that name it. */
export type MemoryDb = NonNullable<ReturnType<typeof memoryDbOrNull>>;
