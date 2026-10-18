import { getLogger } from "./logging.js";
import { memoryDbOrNull } from "./memory-db.js";

const log = getLogger("activation-session-store");

/**
 * In-process mirror of the activation-session rows. The tool resolver is
 * synchronous by contract, so it reads this set instead of querying. The set
 * is primed at startup and updated on every mark.
 */
const activeSessionIds = new Set<string>();

/** Whether this process has seen the conversation marked as an activation session. */
export function isActivationSessionCached(conversationId: string): boolean {
  return activeSessionIds.has(conversationId);
}

/** Load every persisted activation session into the in-process mirror. */
export async function primeActivationSessionCache(): Promise<void> {
  try {
    const db = memoryDbOrNull("primeActivationSessionCache");
    if (!db) {
      return;
    }
    const rows = await db.all<{ conversation_id: string }>(
      /*sql*/ `SELECT conversation_id FROM activation_sessions`,
    );
    for (const row of rows) {
      activeSessionIds.add(row.conversation_id);
    }
  } catch (err) {
    log.warn({ err }, "Failed to prime activation session cache");
  }
}

/**
 * Mark a conversation as an activation-rail session. Idempotent (the row's
 * primary key is the conversation id) and best-effort: an unavailable memory
 * database or a write failure is logged and swallowed so it never blocks the
 * turn that triggered it.
 */
export async function markActivationSession(
  conversationId: string,
): Promise<void> {
  try {
    const db = memoryDbOrNull("markActivationSession");
    if (!db) {
      return;
    }
    await db.run(
      /*sql*/ `INSERT INTO activation_sessions (conversation_id, created_at) VALUES (?, ?)
              ON CONFLICT (conversation_id) DO NOTHING`,
      [conversationId, Date.now()],
    );
    activeSessionIds.add(conversationId);
  } catch (err) {
    log.warn({ err, conversationId }, "Failed to mark activation session");
  }
}

/**
 * Whether the given conversation was started on the activation rail.
 * Best-effort: an unavailable memory database or a read failure is logged and
 * treated as "not an activation session".
 */
export async function isActivationSession(
  conversationId: string,
): Promise<boolean> {
  try {
    const db = memoryDbOrNull("isActivationSession");
    if (!db) {
      return false;
    }
    const row = await db.get(
      /*sql*/ `SELECT 1 FROM activation_sessions WHERE conversation_id = ?`,
      [conversationId],
    );
    return row != null;
  } catch (err) {
    log.warn({ err, conversationId }, "Failed to read activation session");
    return false;
  }
}
