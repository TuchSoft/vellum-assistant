/**
 * Tests for `setAgentLoopExitReasonOnLatestLog` and the
 * `agentLoopExitReason` field on the LogRow type. The helper stamps the
 * reason onto the most-recent `llm_request_logs` row for a conversation,
 * which is how downstream tooling distinguishes "loop kept going" (null)
 * from "loop exited because X" (specific reason) on a per-row basis.
 */
import { beforeEach, expect, test } from "bun:test";

import { requireMainDb } from "../persistence/db-facade.js";
import {
  getRequestLogById,
  recordRequestLog,
  setAgentLoopExitReasonOnLatestLog,
} from "../persistence/llm-request-log-store.js";
import { describePg } from "./pg-test-db.js";

async function resetLogs(): Promise<void> {
  await requireMainDb().run("DELETE FROM llm_request_logs");
}

describePg("setAgentLoopExitReasonOnLatestLog", () => {
  beforeEach(async () => {
    await resetLogs();
  });

  test("recordRequestLog leaves agentLoopExitReason NULL", async () => {
    const id = await recordRequestLog("conv-1", '{"req":1}', '{"res":1}');
    const row = await getRequestLogById(id!);
    expect(row).not.toBeNull();
    expect(row!.agentLoopExitReason).toBeNull();
  });

  test("stamps the reason onto the most-recent log for the conversation", async () => {
    const first = await recordRequestLog("conv-1", '{"req":1}', '{"res":1}');
    // Ensure createdAt strict ordering — `recordRequestLog` uses
    // `Date.now()` and bun-sqlite is fast enough that two consecutive
    // inserts can share a millisecond. Sleep a tick to disambiguate.
    Bun.sleepSync(2);
    const second = await recordRequestLog("conv-1", '{"req":2}', '{"res":2}');

    await setAgentLoopExitReasonOnLatestLog("conv-1", "no_tool_calls");

    expect((await getRequestLogById(first!))?.agentLoopExitReason).toBeNull();
    expect((await getRequestLogById(second!))?.agentLoopExitReason).toBe(
      "no_tool_calls",
    );
  });

  test("scopes the stamp to the given conversation only", async () => {
    const a = await recordRequestLog("conv-a", '{"req":1}', '{"res":1}');
    Bun.sleepSync(2);
    const b = await recordRequestLog("conv-b", '{"req":1}', '{"res":1}');

    await setAgentLoopExitReasonOnLatestLog("conv-a", "yield_to_user");

    expect((await getRequestLogById(a!))?.agentLoopExitReason).toBe(
      "yield_to_user",
    );
    // conv-b is later overall but belongs to a different conversation —
    // must stay NULL.
    expect((await getRequestLogById(b!))?.agentLoopExitReason).toBeNull();
  });

  test("no-op when conversation has no logs", async () => {
    await expect(
      setAgentLoopExitReasonOnLatestLog("conv-missing", "error"),
    ).resolves.toBeUndefined();
  });

  test("does not clobber a previous run's reason when the current run never landed a row", async () => {
    // Previous run: completes, lands a log, gets stamped.
    const prev = await recordRequestLog(
      "conv-1",
      '{"prev_req":1}',
      '{"prev_res":1}',
    );
    await setAgentLoopExitReasonOnLatestLog("conv-1", "no_tool_calls");
    expect((await getRequestLogById(prev!))?.agentLoopExitReason).toBe(
      "no_tool_calls",
    );

    // Current run aborts pre-call (or similar) before any LLM call lands.
    // The helper must NOT overwrite the previous run's row.
    await setAgentLoopExitReasonOnLatestLog("conv-1", "aborted_pre_call");
    expect((await getRequestLogById(prev!))?.agentLoopExitReason).toBe(
      "no_tool_calls",
    );
  });

  test("stamps the current run's newest row even when a prior row is already stamped", async () => {
    // Prior run already stamped.
    const prev = await recordRequestLog(
      "conv-1",
      '{"prev_req":1}',
      '{"prev_res":1}',
    );
    await setAgentLoopExitReasonOnLatestLog("conv-1", "no_tool_calls");

    // Current run lands a new log, then exits.
    Bun.sleepSync(2);
    const current = await recordRequestLog(
      "conv-1",
      '{"cur_req":1}',
      '{"cur_res":1}',
    );
    await setAgentLoopExitReasonOnLatestLog("conv-1", "yield_to_user");

    expect((await getRequestLogById(prev!))?.agentLoopExitReason).toBe(
      "no_tool_calls",
    );
    expect((await getRequestLogById(current!))?.agentLoopExitReason).toBe(
      "yield_to_user",
    );
  });
});
