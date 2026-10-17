import { and, eq, inArray } from "drizzle-orm";

import { peekAcpSessionManager } from "../acp/index.js";
import { isLiveAcpStatus } from "../acp/types.js";
import { findConversation } from "../daemon/conversation-registry.js";
import { hasPendingTurnFinalization } from "../daemon/turn-finalization.js";
import { hasPendingBackgroundWork } from "../notifications/has-pending-background-work.js";
import { requireMainDb } from "../persistence/db-facade.js";
import { getByConversation } from "../runtime/pending-interactions.js";

export async function hasAutoArchiveBlockingWork(
  conversationId: string,
): Promise<boolean> {
  const conversation = findConversation(conversationId);
  if (
    conversation?.hasInFlightWork() ||
    (conversation?.inFlightSendRequestIds.size ?? 0) > 0 ||
    (conversation?.pendingStandaloneSurfaces.size ?? 0) > 0 ||
    hasPendingTurnFinalization(conversationId) ||
    getByConversation(conversationId).length > 0 ||
    (await hasPendingBackgroundWork(conversationId))
  ) {
    return true;
  }

  const manager = peekAcpSessionManager();
  if (!manager) {
    return false;
  }
  const states = manager.getStatus();
  if (!Array.isArray(states)) {
    return true;
  }
  if (
    states.some(
      (state) =>
        state.parentConversationId === conversationId &&
        isLiveAcpStatus(state.status),
    )
  ) {
    return true;
  }
  const registered = new Set(states.map((state) => state.id));
  const pendingIds = manager
    .getActiveAndPendingIds()
    .filter((id) => !registered.has(id));
  if (pendingIds.length === 0) {
    return false;
  }
  // An ACP resume reserves its history id before it registers a live session.
  const db = requireMainDb();
  const acpSessionHistory = db.schema.acpSessionHistory;
  const rows = await db.orm
    .select({ id: acpSessionHistory.id })
    .from(acpSessionHistory)
    .where(
      and(
        eq(acpSessionHistory.parentConversationId, conversationId),
        inArray(acpSessionHistory.id, pendingIds),
      ),
    )
    .limit(1);
  return rows.length > 0;
}
