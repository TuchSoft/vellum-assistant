/**
 * Boot-time connection warm-up.
 *
 * Every inference call goes through the single LLM gateway connection. Legacy
 * per-provider connection backfill no longer applies, so this only loads the
 * connection snapshot that synchronous lookups read.
 */

import { getLogger } from "../../util/logger.js";
import { ensureConnectionSnapshot } from "./connections.js";

const log = getLogger("provider-connections-backfill");

export async function runProviderConnectionsBackfill(): Promise<void> {
  try {
    await ensureConnectionSnapshot();
  } catch (err) {
    log.error(
      { err },
      "provider connection snapshot warm-up failed; retrying on next boot",
    );
  }
}
