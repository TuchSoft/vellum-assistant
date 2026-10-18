/**
 * Cancel contract for the three stop modes.
 *
 * - `hard` (the default) signals `hard_cancel` and force-clears the
 *   conversation's processing flag, so Stop is not left waiting on a turn that
 *   ignores its signal.
 * - `graceful` signals `user_cancel` and leaves the flag to the turn's
 *   `finally`, so the queue drains normally.
 * - `main-only` signals only the main turn: child subagents are left running.
 *
 * This file pins the handler-side contract. The queue parking itself is covered
 * by `daemon/__tests__/abort-null-controller.test.ts`.
 */
import { afterEach, describe, expect, spyOn, test } from "bun:test";

import type { Conversation } from "../daemon/conversation.js";
import {
  deleteConversation,
  setConversation,
} from "../daemon/conversation-registry.js";
import {
  cancelGeneration,
  cancelGenerationWithMode,
} from "../daemon/handlers/conversations.js";
import { getSubagentManager } from "../subagent/index.js";
import { isAbortReason } from "../util/abort-reasons.js";

interface CancelledConversation {
  isProcessing: () => boolean;
  setProcessingCalls: () => boolean[];
  abortCount: () => number;
  abortReasonKinds: () => string[];
}

/**
 * Register a conversation whose in-flight turn is processing. The fake records
 * abort reasons and any `setProcessing` writes so the test can assert what each
 * mode does without running a real turn.
 */
function registerProcessingTurn(id: string): CancelledConversation {
  let processing = true;
  let abortCount = 0;
  const setProcessingCalls: boolean[] = [];
  const abortReasonKinds: string[] = [];
  const fake = {
    isProcessing: () => processing,
    setProcessing: (value: boolean) => {
      setProcessingCalls.push(value);
      processing = value;
    },
    abort: (reason?: unknown) => {
      abortCount += 1;
      if (isAbortReason(reason)) {
        abortReasonKinds.push(reason.kind);
      }
    },
  };
  setConversation(id, fake as unknown as Conversation);
  return {
    isProcessing: () => processing,
    setProcessingCalls: () => setProcessingCalls,
    abortCount: () => abortCount,
    abortReasonKinds: () => abortReasonKinds,
  };
}

describe("cancelGeneration modes", () => {
  const conversationId = "cancel-clears-processing-test-conversation";
  const manager = getSubagentManager();
  let abortAllSpy: ReturnType<typeof spyOn> | undefined;

  afterEach(() => {
    abortAllSpy?.mockRestore();
    abortAllSpy = undefined;
    deleteConversation(conversationId);
  });

  test("default mode is hard: signals hard_cancel and force-clears processing", () => {
    // GIVEN a registered conversation that is processing, with child subagents
    const fake = registerProcessingTurn(conversationId);
    abortAllSpy = spyOn(manager, "abortAllForParent").mockReturnValue(2);

    // WHEN the user cancels generation without naming a mode
    const cancelled = cancelGeneration(conversationId);

    // THEN the cancel is acknowledged
    expect(cancelled).toBe(true);
    // AND the turn is signalled with the hard-cancel reason
    expect(fake.abortCount()).toBe(1);
    expect(fake.abortReasonKinds()).toEqual(["hard_cancel"]);
    // AND processing is force-cleared without waiting for the turn's finally
    expect(fake.setProcessingCalls()).toContain(false);
    expect(fake.isProcessing()).toBe(false);
    // AND child subagents are stopped
    expect(abortAllSpy.mock.calls).toHaveLength(1);
  });

  test("graceful signals user_cancel and leaves processing to the turn", () => {
    // GIVEN a registered conversation that is processing
    const fake = registerProcessingTurn(conversationId);
    abortAllSpy = spyOn(manager, "abortAllForParent").mockReturnValue(1);

    // WHEN the user cancels gracefully
    const outcome = cancelGenerationWithMode(conversationId, "graceful");

    // THEN the turn is signalled with the cooperative reason
    expect(outcome.found).toBe(true);
    expect(fake.abortReasonKinds()).toEqual(["user_cancel"]);
    // AND the processing flag is left for the turn's `finally`
    expect(fake.setProcessingCalls()).not.toContain(false);
    expect(fake.isProcessing()).toBe(true);
    // AND child subagents are still stopped
    expect(outcome.subagents).toBe(1);
    expect(abortAllSpy.mock.calls).toHaveLength(1);
  });

  test("main-only signals the main turn and leaves child subagents running", () => {
    // GIVEN a registered conversation that is processing
    const fake = registerProcessingTurn(conversationId);
    abortAllSpy = spyOn(manager, "abortAllForParent").mockReturnValue(3);

    // WHEN the user stops only the main turn
    const outcome = cancelGenerationWithMode(conversationId, "main-only");

    // THEN the main turn is signalled
    expect(outcome.found).toBe(true);
    expect(fake.abortReasonKinds()).toEqual(["user_cancel"]);
    // AND nothing else is touched: no subagents, no force-clear
    expect(outcome.subagents).toBe(0);
    expect(abortAllSpy.mock.calls).toHaveLength(0);
    expect(fake.setProcessingCalls()).not.toContain(false);
    expect(fake.isProcessing()).toBe(true);
  });

  test("returns false for a conversation that is not registered", () => {
    // GIVEN no conversation registered under the id

    // WHEN the user cancels generation for the unknown id
    const cancelled = cancelGeneration("cancel-clears-processing-unknown-id");

    // THEN the cancel reports that nothing was found
    expect(cancelled).toBe(false);
  });
});
