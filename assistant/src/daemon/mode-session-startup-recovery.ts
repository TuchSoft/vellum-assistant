import { setModeSessionRecoveryHealthy } from "../config/session-groups-gate.js";
import { recoverActiveConversationModeSessions } from "../persistence/conversation-mode-sessions.js";
import { setDbReady } from "./daemon-readiness.js";

export type ModeSessionStartupRecoveryResult =
  | { ok: true; interruptedCount: number }
  | { ok: false; error: unknown };

/** Runs after migrations; auxiliary recovery failure disables tracking for this boot. */
export async function recoverModeSessionsBeforeDbReady(
  recover: () => Promise<number> = recoverActiveConversationModeSessions,
): Promise<ModeSessionStartupRecoveryResult> {
  try {
    const interruptedCount = await recover();
    setModeSessionRecoveryHealthy(true);
    return { ok: true, interruptedCount };
  } catch (error) {
    setModeSessionRecoveryHealthy(false);
    return { ok: false, error };
  } finally {
    setDbReady(true);
  }
}
