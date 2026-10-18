/**
 * Tests that the store's write path routes to ClickHouse instead of local
 * SQLite when a ClickHouse sink is configured — and stays on SQLite
 * otherwise. The sink module is mocked so the routing decision is observable
 * without a live ClickHouse.
 */
import { afterAll, beforeEach, expect, mock, test } from "bun:test";

// Logging stays enabled and writes stay on local SQLite — both are the
// schema defaults, so no config seeding is needed (the sink factory itself
// is mocked below).

// Mutable fake sink: when non-null, the store must route to it. Mirrors the
// `LlmRequestLogWriter` surface the store dispatches through.
interface CapturedRow {
  id: string;
  conversationId: string;
  callSite: string | null;
}
let capturedRows: CapturedRow[] = [];
let sinkActive = false;
mock.module("../persistence/llm-request-log-sink-clickhouse.js", () => ({
  getClickHouseLlmRequestLogSink: () =>
    sinkActive
      ? {
          insertRequestLog: (row: CapturedRow) => {
            capturedRows.push(row);
          },
          setAgentLoopExitReasonOnLatestLog: () => {},
          backfillMessageIdOnLogs: () => {},
          relinkLlmRequestLogs: () => {},
          backfillMessageIdOnRecoveredLogs: () => {},
        }
      : null,
}));

afterAll(() => {
  sinkActive = false;
});

import { requireMainDb } from "../persistence/db-facade.js";
import {
  getRequestLogsByConversationId,
  recordRequestLog,
  recordSyntheticAgentErrorMessageLog,
} from "../persistence/llm-request-log-store.js";
import { describePg } from "./pg-test-db.js";

async function resetLogs(): Promise<void> {
  await requireMainDb().run("DELETE FROM llm_request_logs");
}

describePg("write routing between SQLite and ClickHouse", () => {
  beforeEach(async () => {
    await resetLogs();
    capturedRows = [];
    sinkActive = false;
  });

  test("writes to local SQLite when no ClickHouse sink is configured", async () => {
    const id = await recordRequestLog(
      "conv-local",
      '{"req":1}',
      '{"res":1}',
      undefined,
      "anthropic",
      "mainAgent",
    );
    expect(id).not.toBeNull();
    expect(capturedRows).toHaveLength(0);
    const rows = await getRequestLogsByConversationId("conv-local");
    expect(rows).toHaveLength(1);
    expect(rows[0]!.provider).toBe("anthropic");
  });

  test("routes to ClickHouse and skips SQLite when a sink is configured", async () => {
    sinkActive = true;
    const id = await recordRequestLog(
      "conv-ch",
      '{"req":1}',
      '{"res":1}',
      "msg-ch",
      "openai",
      "mainAgent",
    );
    expect(id).not.toBeNull();
    // Nothing landed in the local table.
    expect(await getRequestLogsByConversationId("conv-ch")).toEqual([]);
    // The row went to the sink, carrying the same id and call site.
    expect(capturedRows).toHaveLength(1);
    expect(capturedRows[0]!.id).toBe(id!);
    expect(capturedRows[0]!.conversationId).toBe("conv-ch");
    expect(capturedRows[0]!.callSite).toBe("mainAgent");
  });

  test("routes synthetic error rows to ClickHouse too", async () => {
    sinkActive = true;
    const id = await recordSyntheticAgentErrorMessageLog({
      conversationId: "conv-ch-2",
      messageId: "msg-ch-2",
      exitReason: "budget_yield_unrecovered",
      noticeText: "Out of budget.",
      preparedRequest: null,
      createdAt: 1_700_000_000_000,
    });
    expect(id).not.toBeNull();
    expect(await getRequestLogsByConversationId("conv-ch-2")).toEqual([]);
    expect(capturedRows).toHaveLength(1);
    expect(capturedRows[0]!.callSite).toBe("syntheticAgentErrorMessage");
  });
});
