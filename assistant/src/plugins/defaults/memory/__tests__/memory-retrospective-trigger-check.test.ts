import { beforeEach, describe, expect, mock, test } from "bun:test";

// Record enqueues instead of writing job rows — the trigger decision is the
// unit under test here, not the jobs store's gating.
let enqueueCalls: Array<{ conversationId: string; trigger: string }> = [];
mock.module("../memory-retrospective-enqueue.js", () => ({
  enqueueMemoryRetrospectiveIfEnabled: async (args: {
    conversationId: string;
    trigger: string;
  }) => {
    enqueueCalls.push(args);
  },
}));

import { describePg } from "../../../../__tests__/pg-test-db.js";
import type { AssistantConfig } from "../../../../config/types.js";
import { createConversation } from "../../../../persistence/conversation-crud.js";
import { requireMainDb } from "../../../../persistence/db-facade.js";
import { SKILL_CARD_MESSAGE_KIND } from "../memory-retrospective-constants.js";
import { upsertRetrospectiveState } from "../memory-retrospective-state.js";
import {
  maybeEnqueueRetrospective,
  shouldEnqueueRetrospective,
} from "../memory-retrospective-trigger-check.js";

const THRESHOLDS = {
  timeThresholdMs: 30 * 60 * 1000, // 30 min
  messageThreshold: 10,
  minCooldownMs: 5 * 60 * 1000, // 5 min
};

describe("shouldEnqueueRetrospective", () => {
  test("no state — returns 'interval' regardless of message count", async () => {
    const result = shouldEnqueueRetrospective({
      state: null,
      newMessageCount: 0,
      now: Date.now(),
      ...THRESHOLDS,
    });
    expect(result).toBe("interval");
  });

  test("cooldown gate — within minCooldownMs, returns null even if other thresholds would trip", async () => {
    const now = Date.now();
    const result = shouldEnqueueRetrospective({
      state: { lastProcessedMessageId: "m1", lastRunAt: now - 60_000 }, // 1 min ago
      newMessageCount: 50, // way over threshold
      now,
      ...THRESHOLDS,
    });
    expect(result).toBeNull();
  });

  test("cooldown elapsed + time threshold reached — returns 'interval'", async () => {
    const now = Date.now();
    const result = shouldEnqueueRetrospective({
      state: { lastProcessedMessageId: "m1", lastRunAt: now - 31 * 60_000 },
      newMessageCount: 1,
      now,
      ...THRESHOLDS,
    });
    expect(result).toBe("interval");
  });

  test("cooldown elapsed + time threshold not reached + message threshold met — returns 'message_count'", async () => {
    const now = Date.now();
    const result = shouldEnqueueRetrospective({
      state: { lastProcessedMessageId: "m1", lastRunAt: now - 6 * 60_000 }, // past cooldown
      newMessageCount: 10, // exactly at threshold
      now,
      ...THRESHOLDS,
    });
    expect(result).toBe("message_count");
  });

  test("cooldown elapsed + neither threshold met — returns null", async () => {
    const now = Date.now();
    const result = shouldEnqueueRetrospective({
      state: { lastProcessedMessageId: "m1", lastRunAt: now - 6 * 60_000 },
      newMessageCount: 5, // below threshold
      now,
      ...THRESHOLDS,
    });
    expect(result).toBeNull();
  });

  test("time threshold at exact boundary — returns 'interval'", async () => {
    const now = Date.now();
    const result = shouldEnqueueRetrospective({
      state: { lastProcessedMessageId: "m1", lastRunAt: now - 30 * 60_000 },
      newMessageCount: 1,
      now,
      ...THRESHOLDS,
    });
    expect(result).toBe("interval");
  });

  test("mid-turn job skip leaves lastRunAt unbumped, so the turn-end trigger check fires immediately (event-driven requeue)", async () => {
    // The job's `source_processing` skip does NOT bump `lastRunAt` (see
    // memory-retrospective-job.ts) precisely so the indexing pass on the
    // turn's final assistant message re-enqueues with no cooldown block.
    const now = Date.now();

    // Fresh conversation: the burned first run left no state row at all →
    // the first-run interval fires as soon as any message indexes.
    expect(
      shouldEnqueueRetrospective({
        state: null,
        newMessageCount: 1,
        now,
        ...THRESHOLDS,
      }),
    ).toBe("interval");

    // Established conversation: `lastRunAt` still reflects the run BEFORE
    // the skipped one, so the same threshold that tripped the skipped
    // enqueue trips again immediately.
    expect(
      shouldEnqueueRetrospective({
        state: { lastProcessedMessageId: "m1", lastRunAt: now - 31 * 60_000 },
        newMessageCount: 1,
        now,
        ...THRESHOLDS,
      }),
    ).toBe("interval");
  });

  test("message threshold prefers 'message_count' label when both could fire (interval also at boundary)", async () => {
    // When the interval is also at threshold AND there are also enough
    // new messages, interval wins because it's evaluated first — the
    // trigger label is for observability only, the action is the same.
    const now = Date.now();
    const result = shouldEnqueueRetrospective({
      state: { lastProcessedMessageId: "m1", lastRunAt: now - 31 * 60_000 },
      newMessageCount: 20,
      now,
      ...THRESHOLDS,
    });
    expect(result).toBe("interval");
  });
});

// ---------------------------------------------------------------------------
// maybeEnqueueRetrospective — kind-aware accounting (real DB).
//
// The retrospective's own `skill-authored-card` message is inserted AFTER the
// cursor the run just persisted, so it always sits past
// `lastProcessedMessageId`. It must never count as unprocessed conversation
// content: a card-only tail hits the zero-new-messages early-out (suppressing
// even the interval trigger), and mixed tails count only the real rows.
// ---------------------------------------------------------------------------

async function resetTables(): Promise<void> {
  const db = requireMainDb();
  await db.run(`DELETE FROM messages`);
  // `memory_retrospective_state` lives on the memory connection now.
  await requireMainDb().exec(`DELETE FROM memory_retrospective_state`);
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
  const id = `msg-${++messageSeq}`;
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
  return id;
}

async function insertSkillCardMessage(
  conversationId: string,
  createdAt: number,
): Promise<string> {
  return await insertMessage(conversationId, {
    role: "assistant",
    createdAt,
    metadata: { kind: SKILL_CARD_MESSAGE_KIND, automated: true },
  });
}

function makeConfig(
  overrides: Partial<typeof THRESHOLDS> = {},
): AssistantConfig {
  return {
    memory: {
      retrospective: { ...THRESHOLDS, ...overrides },
    },
  } as unknown as AssistantConfig;
}

describePg("maybeEnqueueRetrospective — kind-aware accounting", () => {
  beforeEach(async () => {
    await resetTables();
    enqueueCalls = [];
  });

  test("card-only tail past the cursor: no enqueue, even when the interval threshold has long elapsed", async () => {
    const conv = await createConversation("conv");
    const cutoff = await insertMessage(conv.id, { createdAt: 1_000 });
    await upsertRetrospectiveState({
      conversationId: conv.id,
      lastProcessedMessageId: cutoff,
      // Way past the interval threshold — if the card counted as new work,
      // the interval trigger would fire.
      lastRunAt: Date.now() - 24 * 60 * 60_000,
    });
    await insertSkillCardMessage(conv.id, 2_000);

    await maybeEnqueueRetrospective(conv.id, makeConfig());

    expect(enqueueCalls).toEqual([]);
  });

  test("real message past the cursor still enqueues (the exclusion is card-specific)", async () => {
    const conv = await createConversation("conv");
    const cutoff = await insertMessage(conv.id, { createdAt: 1_000 });
    await upsertRetrospectiveState({
      conversationId: conv.id,
      lastProcessedMessageId: cutoff,
      lastRunAt: Date.now() - 24 * 60 * 60_000,
    });
    await insertMessage(conv.id, { createdAt: 2_000 });

    await maybeEnqueueRetrospective(conv.id, makeConfig());

    expect(enqueueCalls).toEqual([
      { conversationId: conv.id, trigger: "interval" },
    ]);
  });

  test("message_count trigger counts only real messages, not interleaved cards", async () => {
    const conv = await createConversation("conv");
    const cutoff = await insertMessage(conv.id, { createdAt: 1_000 });
    // Cooldown elapsed, interval NOT reached — only message_count can fire.
    await upsertRetrospectiveState({
      conversationId: conv.id,
      lastProcessedMessageId: cutoff,
      lastRunAt: Date.now() - 6 * 60_000,
    });
    await insertSkillCardMessage(conv.id, 2_000);
    await insertMessage(conv.id, { createdAt: 3_000 });

    // Card + 1 real = raw count 2 (at threshold), kind-aware count 1 → quiet.
    await maybeEnqueueRetrospective(
      conv.id,
      makeConfig({ messageThreshold: 2 }),
    );
    expect(enqueueCalls).toEqual([]);

    // A second real message tips the kind-aware count to the threshold.
    await insertMessage(conv.id, { createdAt: 4_000 });
    await maybeEnqueueRetrospective(
      conv.id,
      makeConfig({ messageThreshold: 2 }),
    );
    expect(enqueueCalls).toEqual([
      { conversationId: conv.id, trigger: "message_count" },
    ]);
  });

  test("no state row: a card-only conversation stays quiet; a real message fires the first-run interval", async () => {
    const conv = await createConversation("conv");
    await insertSkillCardMessage(conv.id, 1_000);

    await maybeEnqueueRetrospective(conv.id, makeConfig());
    expect(enqueueCalls).toEqual([]);

    await insertMessage(conv.id, { createdAt: 2_000 });
    await maybeEnqueueRetrospective(conv.id, makeConfig());
    expect(enqueueCalls).toEqual([
      { conversationId: conv.id, trigger: "interval" },
    ]);
  });

  test("'' cursor sentinel (failure-only state) counts everything except cards", async () => {
    const conv = await createConversation("conv");
    // Failure-seeded rows carry the "" sentinel — treated like "no cursor".
    await upsertRetrospectiveState({
      conversationId: conv.id,
      lastProcessedMessageId: "",
      lastRunAt: Date.now() - 24 * 60 * 60_000,
    });
    await insertSkillCardMessage(conv.id, 1_000);

    await maybeEnqueueRetrospective(conv.id, makeConfig());
    expect(enqueueCalls).toEqual([]);

    await insertMessage(conv.id, { createdAt: 2_000 });
    await maybeEnqueueRetrospective(conv.id, makeConfig());
    expect(enqueueCalls).toEqual([
      { conversationId: conv.id, trigger: "interval" },
    ]);
  });
});

// ---------------------------------------------------------------------------
// maybeEnqueueRetrospective: the cursor survives a regenerated reply.
//
// The cursor normally lands on the latest assistant reply, and a regenerate
// deletes exactly that row. With its `createdAt` persisted the cursor still
// bounds the count, so the conversation keeps getting retrospectives.
// ---------------------------------------------------------------------------

describePg(
  "maybeEnqueueRetrospective: cursor survives a regenerated reply",
  () => {
    beforeEach(async () => {
      await resetTables();
      enqueueCalls = [];
    });

    test("a regenerate that deletes the cursor's row does not stall the conversation", async () => {
      const conv = await createConversation("conv");
      await insertMessage(conv.id, { createdAt: 1_000 });
      const reply = await insertMessage(conv.id, {
        role: "assistant",
        createdAt: 2_000,
      });
      await upsertRetrospectiveState({
        conversationId: conv.id,
        lastProcessedMessageId: reply,
        lastProcessedCreatedAt: 2_000,
        lastRunAt: Date.now() - 24 * 60 * 60_000,
      });
      // Regenerate: the retry route discards the latest assistant turn, then
      // a fresh reply and the next user message land.
      await requireMainDb().run("DELETE FROM messages WHERE id = ?", [reply]);
      await insertMessage(conv.id, { role: "assistant", createdAt: 3_000 });
      await insertMessage(conv.id, { createdAt: 4_000 });

      await maybeEnqueueRetrospective(conv.id, makeConfig());

      expect(enqueueCalls).toEqual([
        { conversationId: conv.id, trigger: "interval" },
      ]);
    });

    test("a cursor written without a timestamp still goes quiet once its row is gone", async () => {
      const conv = await createConversation("conv");
      await insertMessage(conv.id, { createdAt: 1_000 });
      const reply = await insertMessage(conv.id, {
        role: "assistant",
        createdAt: 2_000,
      });
      await upsertRetrospectiveState({
        conversationId: conv.id,
        lastProcessedMessageId: reply,
        lastRunAt: Date.now() - 24 * 60 * 60_000,
      });
      await requireMainDb().run("DELETE FROM messages WHERE id = ?", [reply]);
      await insertMessage(conv.id, { createdAt: 4_000 });

      await maybeEnqueueRetrospective(conv.id, makeConfig());

      expect(enqueueCalls).toEqual([]);
    });
  },
);
