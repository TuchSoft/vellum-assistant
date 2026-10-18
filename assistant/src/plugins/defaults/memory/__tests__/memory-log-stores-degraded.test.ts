/**
 * Degraded-mode coverage for the per-turn memory log tables: with the
 * dedicated memory database unavailable, writes are best-effort no-ops and
 * reads return empty/zero results — nothing throws mid-turn.
 *
 * Unavailability is simulated by removing the database URL from the
 * environment, so the memory-slot facade resolves to null without mocking any
 * module (module mocks would leak into other test files in the same run).
 */
import {
  afterEach,
  beforeEach,
  describe,
  expect,
  setDefaultTimeout,
  test,
} from "bun:test";

setDefaultTimeout(30_000);

import {
  backfillMemoryRecallLogMessageId,
  getMemoryRecallLogByMessageIds,
  recordMemoryRecallLog,
} from "../memory-recall-log-store.js";
import { recordInjected } from "../v3/ever-injected-store.js";
import { planPrune } from "../v3/prune.js";

let previousDatabaseUrl: string | undefined;

beforeEach(() => {
  previousDatabaseUrl = process.env.VELLUM_DATABASE_URL;
  delete process.env.VELLUM_DATABASE_URL;
});

afterEach(() => {
  if (previousDatabaseUrl === undefined) {
    delete process.env.VELLUM_DATABASE_URL;
  } else {
    process.env.VELLUM_DATABASE_URL = previousDatabaseUrl;
  }
});

describe("memory log stores without a memory database", () => {
  test("recall-log writes no-op and reads return null", async () => {
    await recordMemoryRecallLog({
      conversationId: "conv-1",
      enabled: true,
      degraded: false,
      semanticHits: 1,
      mergedCount: 1,
      selectedCount: 1,
      tier1Count: 1,
      tier2Count: 0,
      hybridSearchLatencyMs: 50,
      sparseVectorUsed: false,
      injectedTokens: 100,
      latencyMs: 80,
      topCandidatesJson: [],
    });
    await backfillMemoryRecallLogMessageId("conv-1", "msg-1");
    expect(await getMemoryRecallLogByMessageIds(["msg-1"])).toBeNull();
  });
});

describe("memory-v3 prune valve without a memory database", () => {
  // The valve's candidate accounting (`memory_v3_injected_sections`) lives on
  // the memory connection too, degraded by the outer beforeEach. With no
  // resident candidates the valve cannot plan a prune, so it no-ops rather than
  // throwing.
  test("planPrune no-ops (returns null) when candidate accounting is unavailable", async () => {
    // The record write is a no-op (memory DB down), so the valve reads no
    // resident entries.
    await recordInjected(
      "conv-degraded-prune",
      [{ slug: "domain-a/page-old", key: "", bytes: 600 }],
      1_000,
    );

    expect(
      await planPrune(
        { maxResidentBytes: 1_000, targetResidentBytes: 500 },
        "conv-degraded-prune",
      ),
    ).toBeNull();
  });
});
