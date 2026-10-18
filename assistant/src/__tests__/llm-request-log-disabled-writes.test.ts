/**
 * Tests the master switch for LLM request logging (`llmRequestLogs.enabled`).
 * When logging is off, the store's insert paths (`recordRequestLog`,
 * `recordSyntheticAgentErrorMessageLog`) must skip the write entirely — no
 * prompt/completion payload lands on disk — and return `null`. The read-side
 * 4xx is exercised separately at the route layer.
 */
import { beforeEach, expect, test } from "bun:test";

import { requireMainDb } from "../persistence/db-facade.js";
import {
  getRequestLogById,
  getRequestLogsByConversationId,
  recordRequestLog,
  recordSyntheticAgentErrorMessageLog,
} from "../persistence/llm-request-log-store.js";
import { setConfig } from "./helpers/set-config.js";
import { describePg } from "./pg-test-db.js";

function setLlmRequestLogging(enabled: boolean): void {
  setConfig("llmRequestLogs", { readSource: "local", enabled });
}

async function resetLogs(): Promise<void> {
  await requireMainDb().run("DELETE FROM llm_request_logs");
}

describePg("llmRequestLogs.enabled write gate", () => {
  beforeEach(async () => {
    await resetLogs();
    setLlmRequestLogging(true);
  });

  test("recordRequestLog writes normally when logging is enabled", async () => {
    const id = await recordRequestLog("conv-1", '{"req":1}', '{"res":1}');
    expect(id).not.toBeNull();
    expect(await getRequestLogById(id!)).not.toBeNull();
  });

  test("recordRequestLog skips the write when logging is disabled", async () => {
    setLlmRequestLogging(false);
    const id = await recordRequestLog("conv-1", '{"req":1}', '{"res":1}');
    expect(id).toBeNull();
    expect(await getRequestLogsByConversationId("conv-1")).toEqual([]);
  });

  test("recordSyntheticAgentErrorMessageLog skips the write when disabled", async () => {
    setLlmRequestLogging(false);
    const id = await recordSyntheticAgentErrorMessageLog({
      conversationId: "conv-2",
      messageId: "msg-2",
      exitReason: "budget_yield_unrecovered",
      noticeText: "Out of budget.",
      preparedRequest: null,
      createdAt: Date.now(),
    });
    expect(id).toBeNull();
    expect(await getRequestLogsByConversationId("conv-2")).toEqual([]);
  });

  test("re-enabling logging restores writes", async () => {
    setLlmRequestLogging(false);
    expect(
      await recordRequestLog("conv-3", '{"req":1}', '{"res":1}'),
    ).toBeNull();
    setLlmRequestLogging(true);
    const id = await recordRequestLog("conv-3", '{"req":2}', '{"res":2}');
    expect(id).not.toBeNull();
    expect(await getRequestLogsByConversationId("conv-3")).toHaveLength(1);
  });
});
