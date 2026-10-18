import { beforeEach, expect, test } from "bun:test";

import { describePg } from "../../../../../__tests__/pg-test-db.js";
import type { AssistantConfig } from "../../../../../config/types.js";
import { requireMainDb } from "../../../../../persistence/db-facade.js";
import {
  conversations,
  messages,
} from "../../../../../persistence/schema/index.js";
import type { MemoryV2ConceptRowRecord } from "../activation-log-store.js";
import { runComparisonOverHistory } from "../harness/compare.js";
import type { RetrievalOutput, Retriever } from "../harness/retriever.js";

// loadNowText reads workspace files; a nonexistent dir yields "".
const WORKSPACE = "/tmp/harness-compare-nonexistent-workspace";

const ZERO_CONFIG = {
  d: 0,
  c_user: 0,
  c_assistant: 0,
  c_now: 0,
  k: 0,
  hops: 0,
  top_k: 0,
  epsilon: 0,
};

let seq = 0;

function config(historicalPairs: number): AssistantConfig {
  return {
    memory: { v2: { router: { historical_pairs: historicalPairs } } },
  } as unknown as AssistantConfig;
}

async function ensureConversation(id: string): Promise<void> {
  await requireMainDb()
    .orm.insert(conversations)
    .values({ id, createdAt: 0, updatedAt: 0 })
    .onConflictDoNothing();
}

async function insertMessage(
  id: string,
  conversationId: string,
  role: string,
  text: string,
  createdAt: number,
): Promise<void> {
  await ensureConversation(conversationId);
  await requireMainDb()
    .orm.insert(messages)
    .values({
      id,
      conversationId,
      role,
      content: JSON.stringify([{ type: "text", text }]),
      createdAt,
    });
}

function makeConcept(
  slug: string,
  status: MemoryV2ConceptRowRecord["status"],
): MemoryV2ConceptRowRecord {
  return {
    slug,
    finalActivation: 0,
    ownActivation: 0,
    priorActivation: 0,
    simUser: 0,
    simAssistant: 0,
    simNow: 0,
    simUserRerankBoost: 0,
    simAssistantRerankBoost: 0,
    inRerankPool: false,
    spreadContribution: 0,
    source: "router",
    status,
  };
}

async function insertRouterLog(
  conversationId: string,
  messageId: string,
  turn: number,
  concepts: MemoryV2ConceptRowRecord[],
  createdAt: number,
): Promise<void> {
  await ensureConversation(conversationId);
  // The activation log lives in the dedicated memory database.
  await requireMainDb().run(
    `INSERT INTO memory_v2_activation_logs (
       id, conversation_id, message_id, turn, mode,
       concepts_json, skills_json, config_json, created_at
     ) VALUES (?, ?, ?, ?, 'router', ?, '[]', ?, ?)`,
    [
      `log-${seq++}`,
      conversationId,
      messageId,
      turn,
      JSON.stringify(concepts),
      JSON.stringify(ZERO_CONFIG),
      createdAt,
    ],
  );
}

function stubRetriever(name: string, selected: string[]): Retriever {
  return {
    name,
    retrieve: async (): Promise<RetrievalOutput> => ({
      selectedSlugs: selected,
      sourceBySlug: new Map(selected.map((s): [string, string] => [s, name])),
    }),
  };
}

async function reset(): Promise<void> {
  const db = requireMainDb();
  await db.run(`DELETE FROM memory_v2_activation_logs`);
  await db.run(`DELETE FROM messages`);
}

/** Seed one router turn: user msg, assistant anchor, and the logged picks. */
async function seedTurn(groundTruth: string[]): Promise<void> {
  await insertMessage("u1", "c1", "user", "hello", 10);
  await insertMessage("a1", "c1", "assistant", "hi", 20); // anchor for turn 1
  await insertRouterLog(
    "c1",
    "a1",
    1,
    groundTruth.map((slug) => makeConcept(slug, "injected")),
    20,
  );
}

describePg("harness/compare runComparisonOverHistory", () => {
  beforeEach(reset);

  test("scores a stub retriever against the logged ground truth", async () => {
    await seedTurn(["p1", "p2"]);

    const report = await runComparisonOverHistory({
      db: requireMainDb(),
      workspaceDir: WORKSPACE,
      config: config(1),
      retrievers: [stubRetriever("stub", ["p1", "z"])],
      ks: [5],
    });

    expect(report.turnsConsidered).toBe(1);
    expect(report.turnsScored).toBe(1);
    expect(report.turnsSkipped).toBe(0);
    // hit p1, miss p2 → recall@5 = 1/2
    expect(report.retrievers[0]?.aggregate.meanRecallAtK[5]).toBeCloseTo(0.5);
  });

  test("pageExists narrows the ground truth set", async () => {
    await seedTurn(["p1", "p2"]);

    const report = await runComparisonOverHistory({
      db: requireMainDb(),
      workspaceDir: WORKSPACE,
      config: config(1),
      retrievers: [stubRetriever("stub", ["p1", "z"])],
      ks: [5],
      pageExists: (slug) => slug === "p1", // p2 no longer exists
    });

    // ground truth is just {p1}; stub selected p1 → recall 1.0
    expect(report.retrievers[0]?.aggregate.meanRecallAtK[5]).toBeCloseTo(1);
  });
});
