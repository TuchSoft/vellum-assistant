import { beforeEach, expect, mock, test } from "bun:test";

// Record enqueues instead of writing job rows — the sweep's scan/gate decision
// is the unit under test, not the jobs store's coalescing. The enqueue's own
// recursion/low-yield/user-activity guards are covered by
// memory-retrospective-enqueue tests; `enqueueDeclines` scripts a declined
// conversation so the cap accounting can be asserted.
let enqueueCalls: Array<{ conversationId: string; trigger: string }> = [];
let enqueueDeclines = new Set<string>();
mock.module("../memory-retrospective-enqueue.js", () => ({
  enqueueMemoryRetrospectiveIfEnabled: async (args: {
    conversationId: string;
    trigger: string;
  }) => {
    enqueueCalls.push(args);
    return !enqueueDeclines.has(args.conversationId);
  },
}));

import { describePg } from "../../../../__tests__/pg-test-db.js";
import type { AssistantConfig } from "../../../../config/types.js";
import { AUTO_ANALYSIS_SOURCE } from "../../../../persistence/auto-analysis-constants.js";
import { createConversation } from "../../../../persistence/conversation-crud.js";
import { MEMORY_V2_CONSOLIDATION_SOURCE } from "../../../../persistence/conversation-types.js";
import { getMemorySqlite } from "../../../../persistence/db-connection.js";
import { requireMainDb } from "../../../../persistence/db-facade.js";
import { upsertMemoryRetrospectiveJob } from "../../../../persistence/jobs-store.js";
import {
  MEMORY_RETROSPECTIVE_SOURCE,
  SKILL_CARD_MESSAGE_KIND,
} from "../memory-retrospective-constants.js";
import { upsertRetrospectiveState } from "../memory-retrospective-state.js";
import {
  listSweepCandidateConversationIds,
  runRetrospectiveSweep,
  SWEEP_MAX_ENQUEUES_PER_PASS,
} from "../memory-retrospective-sweep.js";

const SWEEP_INTERVAL_MS = 8 * 60 * 60 * 1000; // 8h
const SWEEP_LOOKBACK_MS = 7 * 24 * 60 * 60 * 1000; // 7d

function makeConfig(
  sweepIntervalMs = SWEEP_INTERVAL_MS,
  sweepLookbackMs = SWEEP_LOOKBACK_MS,
): AssistantConfig {
  return {
    memory: { retrospective: { sweepIntervalMs, sweepLookbackMs } },
  } as unknown as AssistantConfig;
}

async function setLastMessageAt(
  conversationId: string,
  ts: number | null,
): Promise<void> {
  await requireMainDb().run(
    "UPDATE conversations SET last_message_at = ? WHERE id = ?",
    [ts, conversationId],
  );
}

async function resetTables(): Promise<void> {
  const db = requireMainDb();
  await db.run(`DELETE FROM messages`);
  getMemorySqlite()!.exec(`DELETE FROM memory_retrospective_state`);
  getMemorySqlite()!.exec(`DELETE FROM memory_jobs`);
  await db.run(`DELETE FROM conversations`);
}

let messageSeq = 0;
async function insertMessage(
  conversationId: string,
  opts: {
    role?: string;
    createdAt: number;
    metadata?: Record<string, unknown> | null;
  },
): Promise<string> {
  const id = `msg-${String(++messageSeq).padStart(4, "0")}`;
  await requireMainDb().run(
    "INSERT INTO messages (id, conversation_id, role, content, created_at, metadata) VALUES (?, ?, ?, ?, ?, ?)",
    [
      id,
      conversationId,
      opts.role ?? "user",
      JSON.stringify([{ type: "text", text: "hello" }]),
      opts.createdAt,
      opts.metadata ? JSON.stringify(opts.metadata) : null,
    ],
  );
  // Mirrors `addMessage`'s conversation-stamp bump so seeded conversations
  // sit inside the sweep lookback window. The stamp is wall-clock (like
  // production), independent of the message's logical `createdAt`, which the
  // cursor accounting reads from the message rows. Dormancy tests override
  // via `setLastMessageAt`.
  await setLastMessageAt(conversationId, Date.now());
  return id;
}

describePg("runRetrospectiveSweep", () => {
  beforeEach(async () => {
    await resetTables();
    enqueueCalls = [];
    enqueueDeclines = new Set();
  });

  test("never-run conversation with unprocessed messages is swept", async () => {
    const conv = await createConversation({ id: "conv-a" });
    await insertMessage(conv.id, { createdAt: 1_000 });

    const result = await runRetrospectiveSweep(makeConfig());

    expect(enqueueCalls).toEqual([
      { conversationId: conv.id, trigger: "sweep" },
    ]);
    expect(result).toEqual({ scanned: 1, enqueued: 1 });
  });

  test("conversation with a recent attempt is skipped — the event triggers own it", async () => {
    const conv = await createConversation({ id: "conv-a" });
    const cutoff = await insertMessage(conv.id, { createdAt: 1_000 });
    await insertMessage(conv.id, { createdAt: 2_000 }); // unprocessed, but...
    await upsertRetrospectiveState({
      conversationId: conv.id,
      lastProcessedMessageId: cutoff,
      // Within one sweep interval → responsive triggers are still covering it.
      lastRunAt: Date.now() - SWEEP_INTERVAL_MS / 2,
    });

    await runRetrospectiveSweep(makeConfig());

    expect(enqueueCalls).toEqual([]);
  });

  test("conversation stale past the interval with unprocessed messages is swept", async () => {
    const conv = await createConversation({ id: "conv-a" });
    const cutoff = await insertMessage(conv.id, { createdAt: 1_000 });
    await insertMessage(conv.id, { createdAt: 2_000 });
    await upsertRetrospectiveState({
      conversationId: conv.id,
      lastProcessedMessageId: cutoff,
      lastRunAt: Date.now() - SWEEP_INTERVAL_MS - 60_000,
    });

    await runRetrospectiveSweep(makeConfig());

    expect(enqueueCalls).toEqual([
      { conversationId: conv.id, trigger: "sweep" },
    ]);
  });

  test("conversation whose cursor is caught up is skipped (no unprocessed work)", async () => {
    const conv = await createConversation({ id: "conv-a" });
    const latest = await insertMessage(conv.id, { createdAt: 1_000 });
    await upsertRetrospectiveState({
      conversationId: conv.id,
      lastProcessedMessageId: latest,
      lastRunAt: Date.now() - SWEEP_INTERVAL_MS - 60_000,
    });

    await runRetrospectiveSweep(makeConfig());

    expect(enqueueCalls).toEqual([]);
  });

  test("a card-only tail past the cursor does not count as unprocessed work", async () => {
    const conv = await createConversation({ id: "conv-a" });
    const cutoff = await insertMessage(conv.id, { createdAt: 1_000 });
    await upsertRetrospectiveState({
      conversationId: conv.id,
      lastProcessedMessageId: cutoff,
      lastRunAt: Date.now() - SWEEP_INTERVAL_MS - 60_000,
    });
    await insertMessage(conv.id, {
      role: "assistant",
      createdAt: 2_000,
      metadata: { kind: SKILL_CARD_MESSAGE_KIND, automated: true },
    });

    await runRetrospectiveSweep(makeConfig());

    expect(enqueueCalls).toEqual([]);
  });

  test("every eligible conversation is examined — a zero-work one does not starve a later one", async () => {
    // conv-a: caught up (zero work). conv-b: unprocessed. Ordered by id, the
    // zero-work conversation sorts first; the full scan must still reach conv-b.
    const a = await createConversation({ id: "conv-a" });
    const aMsg = await insertMessage(a.id, { createdAt: 1_000 });
    await upsertRetrospectiveState({
      conversationId: a.id,
      lastProcessedMessageId: aMsg,
      lastRunAt: Date.now() - SWEEP_INTERVAL_MS - 60_000,
    });

    const b = await createConversation({ id: "conv-b" });
    await insertMessage(b.id, { createdAt: 1_000 });

    const result = await runRetrospectiveSweep(makeConfig());

    expect(enqueueCalls).toEqual([{ conversationId: b.id, trigger: "sweep" }]);
    expect(result.scanned).toBe(2);
  });

  test("no work anywhere is a clean no-op", async () => {
    const result = await runRetrospectiveSweep(makeConfig());
    expect(result).toEqual({ scanned: 0, enqueued: 0 });
    expect(enqueueCalls).toEqual([]);
  });

  test("untrusted-actor conversation is never swept, even with unprocessed messages", async () => {
    // A contact-audience conversation: the retrospective would run under
    // guardian trust with `remember`, so its content must not reach memory.
    const conv = await createConversation({ id: "conv-a" });
    await insertMessage(conv.id, {
      createdAt: 1_000,
      metadata: { provenanceTrustClass: "unknown" },
    });

    await runRetrospectiveSweep(makeConfig());

    expect(enqueueCalls).toEqual([]);
  });

  test("guardian-authored conversation is swept", async () => {
    const conv = await createConversation({ id: "conv-a" });
    await insertMessage(conv.id, {
      createdAt: 1_000,
      metadata: { provenanceTrustClass: "guardian" },
    });

    await runRetrospectiveSweep(makeConfig());

    expect(enqueueCalls).toEqual([
      { conversationId: conv.id, trigger: "sweep" },
    ]);
  });

  test("conversation dormant beyond the lookback is not swept — a cold start over deep history enqueues nothing", async () => {
    const conv = await createConversation({ id: "conv-a" });
    // Unprocessed tail exists (no state row at all), which is the shape of
    // every historical conversation on a first sweep — but the conversation
    // has been dormant past the lookback, so its tail is an ordinary
    // end-of-conversation remainder, not stalled work.
    await insertMessage(conv.id, { createdAt: 1_000 });
    await setLastMessageAt(conv.id, Date.now() - SWEEP_LOOKBACK_MS - 60_000);

    const result = await runRetrospectiveSweep(makeConfig());

    expect(enqueueCalls).toEqual([]);
    expect(result).toEqual({ scanned: 0, enqueued: 0 });
  });

  test("source with an already-pending job is skipped and does not consume the cap", async () => {
    // Three stalled sources already have pending rows (e.g. the worker is
    // backed up); one fresh source has none. The pending ones must be skipped
    // outright — counting their coalescing upserts toward the cap would
    // starve later ids across passes.
    for (const id of ["conv-a", "conv-b", "conv-c"]) {
      const conv = await createConversation({ id });
      await insertMessage(conv.id, { createdAt: 1_000 });
      upsertMemoryRetrospectiveJob({ conversationId: conv.id });
    }
    const fresh = await createConversation({ id: "conv-d" });
    await insertMessage(fresh.id, { createdAt: 1_000 });

    const result = await runRetrospectiveSweep(makeConfig());

    expect(enqueueCalls).toEqual([
      { conversationId: fresh.id, trigger: "sweep" },
    ]);
    expect(result).toEqual({ scanned: 4, enqueued: 1 });
  });

  test("a running retrospective does not suppress the sweep — a mid-run arrival needs a follow-up row", async () => {
    // The running job's fork and cursor are pre-run snapshots; the sweep must
    // still be able to enqueue the follow-up behind it (the upsert's
    // pending-only coalescing creates a fresh pending row).
    const conv = await createConversation({ id: "conv-a" });
    await insertMessage(conv.id, { createdAt: 1_000 });
    upsertMemoryRetrospectiveJob({ conversationId: conv.id });
    getMemorySqlite()!.exec(
      `UPDATE memory_jobs SET status = 'running' WHERE type = 'memory_retrospective'`,
    );

    const result = await runRetrospectiveSweep(makeConfig());

    expect(enqueueCalls).toEqual([
      { conversationId: conv.id, trigger: "sweep" },
    ]);
    expect(result).toEqual({ scanned: 1, enqueued: 1 });
  });

  test("a lookback below the sweep cadence is clamped to twice the interval", async () => {
    // lookback 1 minute, interval 8h → effective window 16h. The doubled
    // floor covers work that lands in the scheduler/queue skew right after a
    // pass (older than one interval by the time the next pass executes)
    // while staying bounded across extended downtime.
    const seen = await createConversation({ id: "conv-seen" });
    await insertMessage(seen.id, { createdAt: 1_000 });
    await setLastMessageAt(seen.id, Date.now() - 10 * 60 * 60 * 1000); // 10h: past one interval
    const beyond = await createConversation({ id: "conv-beyond" });
    await insertMessage(beyond.id, { createdAt: 1_000 });
    await setLastMessageAt(beyond.id, Date.now() - 17 * 60 * 60 * 1000); // 17h: past the floor

    const result = await runRetrospectiveSweep(
      makeConfig(SWEEP_INTERVAL_MS, 60_000),
    );

    expect(enqueueCalls).toEqual([
      { conversationId: seen.id, trigger: "sweep" },
    ]);
    expect(result).toEqual({ scanned: 1, enqueued: 1 });
  });

  test("an enqueue the funnel declines is not counted and does not consume the cap", async () => {
    const declined = await createConversation({ id: "conv-a" });
    await insertMessage(declined.id, { createdAt: 1_000 });
    const accepted = await createConversation({ id: "conv-b" });
    await insertMessage(accepted.id, { createdAt: 1_000 });
    enqueueDeclines.add(declined.id);

    const result = await runRetrospectiveSweep(makeConfig());

    // Both conversations reach the funnel; only the accepted one counts.
    expect(enqueueCalls.map((c) => c.conversationId)).toEqual([
      declined.id,
      accepted.id,
    ]);
    expect(result).toEqual({ scanned: 2, enqueued: 1 });
  });

  test("enqueues clamp at the per-pass cap and defer the remainder", async () => {
    for (let i = 0; i < SWEEP_MAX_ENQUEUES_PER_PASS + 5; i++) {
      const conv = await createConversation({
        id: `conv-${String(i).padStart(3, "0")}`,
      });
      await insertMessage(conv.id, { createdAt: 1_000 });
    }

    const result = await runRetrospectiveSweep(makeConfig());

    expect(result.enqueued).toBe(SWEEP_MAX_ENQUEUES_PER_PASS);
    expect(enqueueCalls.length).toBe(SWEEP_MAX_ENQUEUES_PER_PASS);
  });
});

describePg("listSweepCandidateConversationIds", () => {
  beforeEach(async () => {
    await resetTables();
  });

  test("excludes retrospective, consolidation, auto-analysis, and scheduled sources; orders by id", () => {
    await createConversation({ id: "conv-a" });
    await createConversation({ id: "conv-b" });
    await createConversation({
      id: "conv-retro",
      source: MEMORY_RETROSPECTIVE_SOURCE,
    });
    await createConversation({
      id: "conv-consolidate",
      source: MEMORY_V2_CONSOLIDATION_SOURCE,
    });
    await createConversation({ id: "conv-auto", source: AUTO_ANALYSIS_SOURCE });
    await createConversation({
      id: "conv-scheduled",
      conversationType: "scheduled",
    });
    for (const id of [
      "conv-a",
      "conv-b",
      "conv-retro",
      "conv-consolidate",
      "conv-auto",
      "conv-scheduled",
    ]) {
      await setLastMessageAt(id, 5_000);
    }

    const ids = listSweepCandidateConversationIds("", 100, 0);

    expect(ids).toEqual(["conv-a", "conv-b"]);
  });

  test("keyset cursor resumes past the given id", () => {
    for (const id of ["conv-a", "conv-b", "conv-c"]) {
      await createConversation({ id });
      await setLastMessageAt(id, 5_000);
    }

    expect(listSweepCandidateConversationIds("conv-a", 100, 0)).toEqual([
      "conv-b",
      "conv-c",
    ]);
    expect(listSweepCandidateConversationIds("", 1, 0)).toEqual(["conv-a"]);
  });

  test("lookback cutoff excludes dormant and never-stamped conversations", () => {
    await createConversation({ id: "conv-recent" });
    await setLastMessageAt("conv-recent", 5_000);
    await createConversation({ id: "conv-dormant" });
    await setLastMessageAt("conv-dormant", 1_000);
    // No message stamp at all — `gt` NULL semantics exclude it.
    await createConversation({ id: "conv-unstamped" });

    expect(listSweepCandidateConversationIds("", 100, 2_000)).toEqual([
      "conv-recent",
    ]);
  });
});

describePg("runRetrospectiveSweep: cursor survives a regenerated reply", () => {
  beforeEach(async () => {
    await resetTables();
    enqueueCalls = [];
    enqueueDeclines = new Set();
  });

  test("a stale conversation whose cursor row was regenerated away is still swept", async () => {
    const conv = await createConversation({ id: "conv-a" });
    await insertMessage(conv.id, { createdAt: 1_000 });
    const reply = await insertMessage(conv.id, {
      role: "assistant",
      createdAt: 2_000,
    });
    await upsertRetrospectiveState({
      conversationId: conv.id,
      lastProcessedMessageId: reply,
      lastProcessedCreatedAt: 2_000,
      lastRunAt: Date.now() - SWEEP_INTERVAL_MS - 60_000,
    });
    await requireMainDb().run("DELETE FROM messages WHERE id = ?", [reply]);
    await insertMessage(conv.id, { role: "assistant", createdAt: 3_000 });

    await runRetrospectiveSweep(makeConfig());

    expect(enqueueCalls).toEqual([
      { conversationId: conv.id, trigger: "sweep" },
    ]);
  });
});
