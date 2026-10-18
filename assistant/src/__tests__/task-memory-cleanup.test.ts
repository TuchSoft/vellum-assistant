import { beforeEach, expect, mock, test } from "bun:test";

import { eq } from "drizzle-orm";

mock.module("../persistence/embeddings/qdrant-client.js", () => ({
  getQdrantClient: () => ({
    searchWithFilter: async () => [],
    upsertPoints: async () => {},
    deletePoints: async () => {},
  }),
  initQdrantClient: () => {},
  resolveQdrantUrl: () => "http://127.0.0.1:6333",
}));

import { requireMainDb } from "../persistence/db-facade.js";
import { enqueueMemoryJob } from "../persistence/jobs-store.js";
import {
  invalidateAssistantInferredItemsForConversation,
  isConversationFailed,
} from "../plugins/defaults/memory/task-memory-cleanup.js";
import { describePg } from "./pg-test-db.js";

const DEFAULT_EMOTIONAL_CHARGE =
  '{"valence":0,"intensity":0.1,"decayCurve":"linear","decayRate":0.05,"originalIntensity":0.1}';

describePg("invalidateAssistantInferredItemsForConversation", () => {
  const now = 1_701_100_000_000;
  const convId = "conv-task-cleanup";
  const otherConvId = "conv-other";

  beforeEach(async () => {
    const db = requireMainDb();
    await db.run("DELETE FROM memory_graph_nodes");
    await db.run("DELETE FROM memory_jobs");
    await db.run("DELETE FROM messages");
    await db.run("DELETE FROM cron_runs");
    await db.run("DELETE FROM cron_jobs");
    await db.run("DELETE FROM conversations");
  });

  async function seedConversations(): Promise<void> {
    const db = requireMainDb();
    for (const id of [convId, otherConvId]) {
      await db.orm.insert(db.schema.conversations).values({
        id,
        title: null,
        createdAt: now,
        updatedAt: now,
        totalInputTokens: 0,
        totalOutputTokens: 0,
        totalEstimatedCost: 0,
        contextSummary: null,
        contextCompactedMessageCount: 0,
        contextCompactedAt: null,
      });
    }
  }

  async function seedMessages(): Promise<void> {
    const db = requireMainDb();
    await db.orm.insert(db.schema.messages).values([
      {
        id: "msg-task-1",
        conversationId: convId,
        role: "assistant",
        content: "[]",
        createdAt: now + 10,
      },
      {
        id: "msg-task-2",
        conversationId: convId,
        role: "user",
        content: "[]",
        createdAt: now + 20,
      },
      {
        id: "msg-other",
        conversationId: otherConvId,
        role: "assistant",
        content: "[]",
        createdAt: now + 30,
      },
    ]);
  }

  async function seedMemoryGraphNodes(): Promise<void> {
    const db = requireMainDb();
    await db.orm.insert(db.schema.memoryGraphNodes).values([
      {
        id: "item-assistant-inferred",
        content: "DMV appointment\nBooked a DMV appointment at 9 AM.",
        type: "semantic",
        created: now + 10,
        lastAccessed: now + 10,
        lastConsolidated: now + 10,
        emotionalCharge: DEFAULT_EMOTIONAL_CHARGE,
        fidelity: "vivid",
        confidence: 0.8,
        significance: 0.7,
        stability: 14,
        reinforcementCount: 0,
        lastReinforced: now + 10,
        sourceConversations: JSON.stringify([convId]),
        sourceType: "inferred",
        narrativeRole: null,
        partOfStory: null,
      },
      {
        id: "item-user-reported",
        content: "notification pref\nUser prefers email notifications.",
        type: "semantic",
        created: now + 20,
        lastAccessed: now + 20,
        lastConsolidated: now + 20,
        emotionalCharge: DEFAULT_EMOTIONAL_CHARGE,
        fidelity: "vivid",
        confidence: 0.9,
        significance: 0.8,
        stability: 14,
        reinforcementCount: 0,
        lastReinforced: now + 20,
        sourceConversations: JSON.stringify([convId]),
        sourceType: "direct",
        narrativeRole: null,
        partOfStory: null,
      },
      {
        id: "item-other-conv",
        content: "weather check\nChecked weather for tomorrow.",
        type: "semantic",
        created: now + 30,
        lastAccessed: now + 30,
        lastConsolidated: now + 30,
        emotionalCharge: DEFAULT_EMOTIONAL_CHARGE,
        fidelity: "vivid",
        confidence: 0.7,
        significance: 0.5,
        stability: 14,
        reinforcementCount: 0,
        lastReinforced: now + 30,
        sourceConversations: JSON.stringify([otherConvId]),
        sourceType: "inferred",
        narrativeRole: null,
        partOfStory: null,
      },
      {
        id: "item-already-gone",
        content: "old claim\nOld assistant claim already gone.",
        type: "semantic",
        created: now + 5,
        lastAccessed: now + 5,
        lastConsolidated: now + 5,
        emotionalCharge: DEFAULT_EMOTIONAL_CHARGE,
        fidelity: "gone",
        confidence: 0.6,
        significance: 0.4,
        stability: 14,
        reinforcementCount: 0,
        lastReinforced: now + 5,
        sourceConversations: JSON.stringify([convId]),
        sourceType: "inferred",
        narrativeRole: null,
        partOfStory: null,
      },
    ]);
  }

  test("only invalidates inferred items, not direct (user-reported)", async () => {
    await seedConversations();
    await seedMessages();
    await seedMemoryGraphNodes();

    const affected =
      await invalidateAssistantInferredItemsForConversation(convId);

    expect(affected).toBe(1);

    const db = requireMainDb();
    const [inferredItem] = await db.orm
      .select()
      .from(db.schema.memoryGraphNodes)
      .where(eq(db.schema.memoryGraphNodes.id, "item-assistant-inferred"));
    expect(inferredItem?.fidelity).toBe("gone");

    const [directItem] = await db.orm
      .select()
      .from(db.schema.memoryGraphNodes)
      .where(eq(db.schema.memoryGraphNodes.id, "item-user-reported"));
    expect(directItem?.fidelity).toBe("vivid");
  });

  test("does not affect items from other conversations", async () => {
    await seedConversations();
    await seedMessages();
    await seedMemoryGraphNodes();

    await invalidateAssistantInferredItemsForConversation(convId);

    const db = requireMainDb();
    const [otherItem] = await db.orm
      .select()
      .from(db.schema.memoryGraphNodes)
      .where(eq(db.schema.memoryGraphNodes.id, "item-other-conv"));
    expect(otherItem?.fidelity).toBe("vivid");
  });

  test("does not invalidate items also sourced from another conversation", async () => {
    await seedConversations();
    await seedMessages();

    // Insert a node sourced from both conversations (corroboration).
    const db = requireMainDb();
    await db.orm.insert(db.schema.memoryGraphNodes).values({
      id: "item-corroborated",
      content: "DMV appointment\nBooked a DMV appointment at 9 AM.",
      type: "semantic",
      created: now + 10,
      lastAccessed: now + 10,
      lastConsolidated: now + 10,
      emotionalCharge: DEFAULT_EMOTIONAL_CHARGE,
      fidelity: "vivid",
      confidence: 0.8,
      significance: 0.7,
      stability: 14,
      reinforcementCount: 0,
      lastReinforced: now + 10,
      sourceConversations: JSON.stringify([convId, otherConvId]),
      sourceType: "inferred",
      narrativeRole: null,
      partOfStory: null,
    });

    const affected =
      await invalidateAssistantInferredItemsForConversation(convId);

    // The item has sources from both conversations, so it should NOT be invalidated.
    expect(affected).toBe(0);

    const [item] = await db.orm
      .select()
      .from(db.schema.memoryGraphNodes)
      .where(eq(db.schema.memoryGraphNodes.id, "item-corroborated"));
    expect(item?.fidelity).toBe("vivid");
  });

  test("does not affect already-gone items", async () => {
    await seedConversations();
    await seedMessages();
    await seedMemoryGraphNodes();

    await invalidateAssistantInferredItemsForConversation(convId);

    const db = requireMainDb();
    const [goneItem] = await db.orm
      .select()
      .from(db.schema.memoryGraphNodes)
      .where(eq(db.schema.memoryGraphNodes.id, "item-already-gone"));
    expect(goneItem?.fidelity).toBe("gone");
  });

  test("returns 0 when no matching items exist", async () => {
    await seedConversations();
    await seedMessages();
    // No memory graph nodes seeded

    const affected =
      await invalidateAssistantInferredItemsForConversation(convId);
    expect(affected).toBe(0);
  });

  test("returns 0 for unknown conversation", async () => {
    await seedConversations();
    await seedMessages();
    await seedMemoryGraphNodes();

    const affected =
      await invalidateAssistantInferredItemsForConversation("conv-nonexistent");
    expect(affected).toBe(0);
  });

  test("invalidates items when corroborating conversation is from a failed schedule run", async () => {
    const db = requireMainDb();
    const convA = "conv-failed-sched-a";
    const convB = "conv-failed-sched-b";

    for (const id of [convA, convB]) {
      await db.orm.insert(db.schema.conversations).values({
        id,
        title: null,
        createdAt: now,
        updatedAt: now,
        totalInputTokens: 0,
        totalOutputTokens: 0,
        totalEstimatedCost: 0,
        contextSummary: null,
        contextCompactedMessageCount: 0,
        contextCompactedAt: null,
      });
    }

    await db.orm.insert(db.schema.messages).values([
      {
        id: "msg-sched-a",
        conversationId: convA,
        role: "assistant",
        content: "[]",
        createdAt: now + 10,
      },
      {
        id: "msg-sched-b",
        conversationId: convB,
        role: "assistant",
        content: "[]",
        createdAt: now + 20,
      },
    ]);

    // Both conversations are from failed schedule runs
    await db.orm.insert(db.schema.cronJobs).values({
      id: "cron-1",
      name: "Test schedule",
      cronExpression: "0 9 * * *",
      message: "test",
      nextRunAt: now + 100_000,
      createdBy: "agent",
      createdAt: now,
      updatedAt: now,
    });

    await db.orm.insert(db.schema.cronRuns).values([
      {
        id: "cron-run-a",
        jobId: "cron-1",
        status: "error",
        conversationId: convA,
        startedAt: now + 10,
        createdAt: now + 10,
      },
      {
        id: "cron-run-b",
        jobId: "cron-1",
        status: "error",
        conversationId: convB,
        startedAt: now + 20,
        createdAt: now + 20,
      },
    ]);

    await requireMainDb()
      .orm.insert(requireMainDb().schema.memoryGraphNodes)
      .values({
        id: "item-cross-sched",
        content:
          "cross-sourced schedule claim\nClaim from two failed schedules.",
        type: "semantic",
        created: now + 10,
        lastAccessed: now + 20,
        lastConsolidated: now + 10,
        emotionalCharge: DEFAULT_EMOTIONAL_CHARGE,
        fidelity: "vivid",
        confidence: 0.8,
        significance: 0.7,
        stability: 14,
        reinforcementCount: 0,
        lastReinforced: now + 10,
        sourceConversations: JSON.stringify([convA, convB]),
        sourceType: "inferred",
        narrativeRole: null,
        partOfStory: null,
      });

    const affected =
      await invalidateAssistantInferredItemsForConversation(convA);
    expect(affected).toBe(1);

    const [item] = await requireMainDb()
      .orm.select()
      .from(requireMainDb().schema.memoryGraphNodes)
      .where(
        eq(requireMainDb().schema.memoryGraphNodes.id, "item-cross-sched"),
      );
    expect(item?.fidelity).toBe("gone");
  });

  test("preserves items when corroborating conversation is from a successful schedule run", async () => {
    const db = requireMainDb();
    const convFailed = "conv-failed-task";
    const convSuccess = "conv-success-task";

    for (const id of [convFailed, convSuccess]) {
      await db.orm.insert(db.schema.conversations).values({
        id,
        title: null,
        createdAt: now,
        updatedAt: now,
        totalInputTokens: 0,
        totalOutputTokens: 0,
        totalEstimatedCost: 0,
        contextSummary: null,
        contextCompactedMessageCount: 0,
        contextCompactedAt: null,
      });
    }

    await db.orm.insert(db.schema.messages).values([
      {
        id: "msg-failed",
        conversationId: convFailed,
        role: "assistant",
        content: "[]",
        createdAt: now + 10,
      },
      {
        id: "msg-success",
        conversationId: convSuccess,
        role: "assistant",
        content: "[]",
        createdAt: now + 20,
      },
    ]);

    await db.orm.insert(db.schema.cronJobs).values({
      id: "cron-2",
      name: "Test schedule 2",
      cronExpression: "0 9 * * *",
      message: "test",
      nextRunAt: now + 100_000,
      createdBy: "agent",
      createdAt: now,
      updatedAt: now,
    });

    await db.orm.insert(db.schema.cronRuns).values([
      {
        id: "cron-run-failed",
        jobId: "cron-2",
        status: "error",
        conversationId: convFailed,
        startedAt: now + 10,
        createdAt: now + 10,
      },
      {
        id: "cron-run-success",
        jobId: "cron-2",
        status: "ok",
        conversationId: convSuccess,
        startedAt: now + 20,
        createdAt: now + 20,
      },
    ]);

    await requireMainDb()
      .orm.insert(requireMainDb().schema.memoryGraphNodes)
      .values({
        id: "item-with-good-corroboration",
        content: "corroborated claim\nClaim corroborated by successful task.",
        type: "semantic",
        created: now + 10,
        lastAccessed: now + 20,
        lastConsolidated: now + 10,
        emotionalCharge: DEFAULT_EMOTIONAL_CHARGE,
        fidelity: "vivid",
        confidence: 0.8,
        significance: 0.7,
        stability: 14,
        reinforcementCount: 0,
        lastReinforced: now + 10,
        sourceConversations: JSON.stringify([convFailed, convSuccess]),
        sourceType: "inferred",
        narrativeRole: null,
        partOfStory: null,
      });

    // The successful schedule run corroborates the claim, so it should NOT be invalidated
    const affected =
      await invalidateAssistantInferredItemsForConversation(convFailed);
    expect(affected).toBe(0);

    const [item] = await requireMainDb()
      .orm.select()
      .from(requireMainDb().schema.memoryGraphNodes)
      .where(
        eq(
          requireMainDb().schema.memoryGraphNodes.id,
          "item-with-good-corroboration",
        ),
      );
    expect(item?.fidelity).toBe("vivid");
  });

  test("isConversationFailed detects failed schedule runs", async () => {
    await seedConversations();
    await seedMessages();

    const db = requireMainDb();

    expect(await isConversationFailed(convId)).toBe(false);

    // Insert a failed schedule run for convId
    await db.orm.insert(db.schema.cronJobs).values({
      id: "cron-durable",
      name: "Durable schedule test",
      cronExpression: "0 9 * * *",
      message: "test",
      nextRunAt: now + 100_000,
      createdBy: "agent",
      createdAt: now,
      updatedAt: now,
    });

    await db.orm.insert(db.schema.cronRuns).values({
      id: "cron-run-durable",
      jobId: "cron-durable",
      status: "error",
      conversationId: convId,
      startedAt: now + 50,
      createdAt: now + 50,
    });

    expect(await isConversationFailed(convId)).toBe(true);
    expect(await isConversationFailed(otherConvId)).toBe(false);
  });

  test("cancels pending graph_extract jobs for the failed conversation", async () => {
    await seedConversations();
    await seedMessages();

    // memory_jobs lives in the dedicated memory connection.
    const db = requireMainDb();

    // Enqueue graph_extract jobs for the target conversation
    await enqueueMemoryJob("graph_extract", {
      conversationId: convId,
    });
    await enqueueMemoryJob("graph_extract", {
      conversationId: convId,
    });
    // Enqueue a graph_extract job for a different conversation
    await enqueueMemoryJob("graph_extract", {
      conversationId: otherConvId,
    });

    // Verify all jobs are pending
    const pendingBefore = await db.orm
      .select()
      .from(db.schema.memoryJobs)
      .where(eq(db.schema.memoryJobs.type, "graph_extract"));
    expect(pendingBefore.filter((j) => j.status === "pending")).toHaveLength(3);

    await invalidateAssistantInferredItemsForConversation(convId);

    // Jobs for the failed conversation should be cancelled (failed)
    const allJobs = await db.orm
      .select()
      .from(db.schema.memoryJobs)
      .where(eq(db.schema.memoryJobs.type, "graph_extract"));
    const failedJobs = allJobs.filter((j) => j.status === "failed");
    const pendingJobs = allJobs.filter((j) => j.status === "pending");

    // Two jobs for the failed conversation should be cancelled
    expect(failedJobs).toHaveLength(2);
    for (const j of failedJobs) {
      expect(j.lastError).toBe("conversation_failed");
    }

    // The job for the other conversation should remain pending
    expect(pendingJobs).toHaveLength(1);
    const payload = JSON.parse(pendingJobs[0].payload);
    expect(payload.conversationId).toBe(otherConvId);
  });
});
