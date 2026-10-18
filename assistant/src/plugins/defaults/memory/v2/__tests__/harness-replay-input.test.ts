import { beforeEach, expect, setDefaultTimeout, test } from "bun:test";

setDefaultTimeout(30_000);

import { describePg } from "../../../../../__tests__/pg-test-db.js";
import type { AssistantConfig } from "../../../../../config/types.js";
import { requireMainDb } from "../../../../../persistence/db-facade.js";
import {
  conversations,
  messages,
} from "../../../../../persistence/schema/index.js";
import type { MemoryV2ConceptRowRecord } from "../activation-log-store.js";
import type { OracleTurn } from "../harness/oracle.js";
import { reconstructInput } from "../harness/replay-input.js";

// loadNowText reads workspace files; a nonexistent dir yields "".
const WORKSPACE = "/tmp/harness-replay-nonexistent-workspace";

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

async function ensureConversation(id: string): Promise<void> {
  await requireMainDb()
    .orm.insert(conversations)
    .values({ id, createdAt: 0, updatedAt: 0 })
    .onConflictDoNothing();
}

function config(historicalPairs: number): AssistantConfig {
  return {
    memory: { v2: { router: { historical_pairs: historicalPairs } } },
  } as unknown as AssistantConfig;
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

function turnFor(
  conversationId: string,
  turn: number,
  anchorMessageId: string,
  anchorCreatedAt: number,
): OracleTurn {
  return {
    conversationId,
    turn,
    anchorMessageId,
    anchorCreatedAt,
    groundTruthSlugs: ["x"],
    loggedConfig: ZERO_CONFIG,
    createdAt: anchorCreatedAt,
  };
}

async function reset(): Promise<void> {
  const db = requireMainDb();
  await db.run(`DELETE FROM memory_v2_activation_logs`);
  await db.run(`DELETE FROM messages`);
}

describePg("harness/replay-input reconstructInput", () => {
  beforeEach(reset);

  test("reconstructs the last (assistant,user) pair before the anchor reply", async () => {
    await insertMessage("u1", "c1", "user", "first user", 10);
    await insertMessage("a1", "c1", "assistant", "first reply", 20);
    await insertMessage("u2", "c1", "user", "second user", 30);
    await insertMessage("a2", "c1", "assistant", "second reply", 40); // anchor

    const r = await reconstructInput(
      requireMainDb(),
      turnFor("c1", 2, "a2", 40),
      config(1),
      WORKSPACE,
    );
    expect(r).not.toBeNull();
    expect(r?.input.recentTurnPairs).toEqual([
      { assistantMessage: "first reply", userMessage: "second user" },
    ]);
    expect(r?.meta.pairsReconstructed).toBe(1);
    expect(r?.input.nowText).toBe("");
  });

  test("historical_pairs=2 returns the last two pairs", async () => {
    await insertMessage("u1", "c1", "user", "u-one", 10);
    await insertMessage("a1", "c1", "assistant", "a-one", 20);
    await insertMessage("u2", "c1", "user", "u-two", 30);
    await insertMessage("a2", "c1", "assistant", "a-two", 40);
    await insertMessage("u3", "c1", "user", "u-three", 50);
    await insertMessage("a3", "c1", "assistant", "a-three", 60); // anchor

    const r = await reconstructInput(
      requireMainDb(),
      turnFor("c1", 3, "a3", 60),
      config(2),
      WORKSPACE,
    );
    expect(r?.input.recentTurnPairs).toEqual([
      { assistantMessage: "a-one", userMessage: "u-two" },
      { assistantMessage: "a-two", userMessage: "u-three" },
    ]);
  });

  test("returns null when the anchor message is not found", async () => {
    await insertMessage("u1", "c1", "user", "hi", 10);
    const r = await reconstructInput(
      requireMainDb(),
      turnFor("c1", 1, "missing-anchor", 999),
      config(1),
      WORKSPACE,
    );
    expect(r).toBeNull();
  });

  test("priorEverInjected mirrors production everInjected retention from earlier router turns", async () => {
    await insertMessage("u1", "c1", "user", "u1", 10);
    await insertMessage("a1", "c1", "assistant", "a1", 20);
    await insertMessage("u2", "c1", "user", "u2", 30);
    await insertMessage("a2", "c1", "assistant", "a2", 40); // anchor for turn 2
    await insertRouterLog(
      "c1",
      "a1",
      1,
      [
        makeConcept("p1", "injected"),
        makeConcept("p2", "in_context"),
        // page_missing / corrupt concept pages are retained in production's
        // everInjected (so they aren't re-attempted every turn), so the replay
        // must include them too.
        makeConcept("p3", "page_missing"),
        makeConcept("p4", "corrupt"),
        makeConcept("p5", "not_injected"),
      ],
      20,
    );

    const r = await reconstructInput(
      requireMainDb(),
      turnFor("c1", 2, "a2", 40),
      config(1),
      WORKSPACE,
    );
    const slugs = (r?.input.priorEverInjected ?? []).map((e) => e.slug).sort();
    expect(slugs).toEqual(["p1", "p2", "p3", "p4"]);
    expect(r?.meta.priorEverInjectedCount).toBe(4);
  });
});
