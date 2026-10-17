import type { ModeSession } from "../api/mode-session.js";
import { getLogger } from "../util/logger.js";
import type {
  ConversationModeSessionCoordinator,
  ModeSessionSourceHandle,
} from "./conversation-mode-session.js";

const log = getLogger("mode-session-tracking");

/** Optional bookkeeping must not interrupt accepted actions or content. */
export function bestEffortModeSessionTracking<T>(
  operation: string,
  track: () => T,
): T | undefined {
  try {
    return track();
  } catch (err) {
    log.warn({ err, operation }, "Mode-session tracking failed");
    return undefined;
  }
}

/** Retire a refused source while already accepted turn output keeps its owner. */
export async function claimModeSessionTurn(
  coordinator: Pick<
    ConversationModeSessionCoordinator,
    "claimTurn" | "retireSource"
  >,
  turnId: string,
  handle: ModeSessionSourceHandle,
  at: number,
): Promise<ModeSession | undefined> {
  let owner: ModeSession | undefined;
  try {
    owner = await coordinator.claimTurn(turnId, handle, at);
  } catch (err) {
    try {
      await coordinator.retireSource(handle, {
        status: "interrupted",
        endReason: "tracking_failed",
      });
    } catch (cleanupErr) {
      log.warn(
        { err: cleanupErr, operation: "failed admission cleanup" },
        "Mode-session tracking failed",
      );
    }
    throw err;
  }
  if (!owner || owner.id !== handle.id) {
    try {
      await coordinator.retireSource(handle, {
        status: "interrupted",
        endReason: "tracking_refused",
      });
    } catch (cleanupErr) {
      log.warn(
        { err: cleanupErr, operation: "refused admission cleanup" },
        "Mode-session tracking failed",
      );
    }
  }
  return owner;
}
