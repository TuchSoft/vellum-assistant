import { getLogger } from "./logging.js";
import { memoryDbOrNull } from "./memory-db.js";

const log = getLogger("activation-session-store");

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
