import type { Conversation } from "../daemon/conversation.js";
import {
  allSubagentConversations,
  findConversation,
} from "../daemon/conversation-registry.js";
import {
  getSubagentRecordByConversationId,
  getSubagentRecordsByParent,
} from "../persistence/subagent-store.js";
import { hasPendingAgentWake } from "../runtime/agent-wake-queue.js";
import { TERMINAL_STATUSES } from "../subagent/types.js";
import { hasBackgroundToolWork } from "../tools/background-tool-registry.js";
import { isUserFacingSubagent, workStartedAfter } from "./completion-work.js";

async function hasPendingTurn(
  conversation: Conversation | undefined,
  startedAfter?: number,
): Promise<boolean> {
  if (!conversation) {
    return false;
  }
  if (conversation.isProcessing()) {
    if (
      startedAfter === undefined ||
      conversation.currentTurnWorkOrigins === undefined
    ) {
      return true;
    }
    for (const origin of conversation.currentTurnWorkOrigins) {
      if (await workStartedAfter(origin, startedAfter)) {
        return true;
      }
    }
  }
  if (startedAfter === undefined) {
    return (
      conversation.hasQueuedMessages() ||
      (conversation.pendingQueuedDispatches?.size ?? 0) > 0
    );
  }
  for (const message of conversation.snapshotQueuedMessages()) {
    if (await workStartedAfter(message, startedAfter)) {
      return true;
    }
  }
  for (const dispatches of conversation.pendingQueuedDispatches?.values() ??
    []) {
    for (const dispatch of dispatches) {
      for (const message of dispatch.messages) {
        if (await workStartedAfter(message, startedAfter)) {
          return true;
        }
      }
    }
  }
  return false;
}

/** A finished turn can still own delegated work whose result is not ready. */
export async function hasPendingBackgroundWork(
  conversationId: string,
  options?: { startedAfter?: number },
): Promise<boolean> {
  const conversation = findConversation(conversationId);
  // Terminal records can retain a live child while its queued follow-ups drain.
  for (const child of allSubagentConversations()) {
    if (
      child.parentConversationId !== conversationId ||
      !(await hasPendingTurn(child))
    ) {
      continue;
    }
    const task = await getSubagentRecordByConversationId(child.conversationId);
    if (
      task &&
      isUserFacingSubagent(task) &&
      (options?.startedAfter === undefined ||
        task.createdAt >= options.startedAfter)
    ) {
      return true;
    }
  }
  if (await hasPendingTurn(conversation, options?.startedAfter)) {
    return true;
  }
  if (hasPendingAgentWake(conversationId, undefined, options)) {
    return true;
  }
  const parentTasks = await getSubagentRecordsByParent(conversationId, {
    terminalStatuses: [...TERMINAL_STATUSES],
    maxTerminal: 0,
  });
  if (
    parentTasks.some(
      (task) =>
        isUserFacingSubagent(task) &&
        (options?.startedAfter === undefined ||
          task.createdAt >= options.startedAfter),
    )
  ) {
    return true;
  }
  return hasBackgroundToolWork(conversationId, options);
}
