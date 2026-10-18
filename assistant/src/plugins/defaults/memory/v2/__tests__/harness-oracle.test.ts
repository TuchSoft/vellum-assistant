import { beforeEach, expect, setDefaultTimeout, test } from "bun:test";

setDefaultTimeout(30_000);

import { describePg } from "../../../../../__tests__/pg-test-db.js";
import { requireMainDb } from "../../../../../persistence/db-facade.js";
import type { MemoryV2ConceptRowRecord } from "../activation-log-store.js";
import { extractOracleTurns } from "../harness/oracle.js";

const CONFIG_JSON = JSON.stringify({
  d: 0,
  c_user: 0,
  c_assistant: 0,
  c_now: 0,
  k: 0,
  hops: 0,
  top_k: 0,
  epsilon: 0,
});

let seq = 0;

async function ensureConversation(id: string): Promise<void> {
  const db = requireMainDb();
  const conversations = db.schema.conversations;
  await db.orm
    .insert(conversations)
    .values({ id, createdAt: 0, updatedAt: 0 })
    .onConflictDoNothing();
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

async function insertLog(opts: {
  conversationId: string;
  messageId: string | null;
  turn: number;
  mode: string;
  concepts: MemoryV2ConceptRowRecord[];
  createdAt: number;
}): Promise<void> {
  await ensureConversation(opts.conversationId);
  await requireMainDb().run(
    `INSERT INTO memory_v2_activation_logs (
       id, conversation_id, message_id, turn, mode,
       concepts_json, skills_json, config_json, created_at
     ) VALUES (?, ?, ?, ?, ?, ?, '[]', ?, ?)`,
    [
      `log-${seq++}`,
      opts.conversationId,
      opts.messageId,
      opts.turn,
      opts.mode,
      JSON.stringify(opts.concepts),
      CONFIG_JSON,
      opts.createdAt,
    ],
  );
}

async function insertMessage(
  id: string,
  conversationId: string,
  createdAt: number,
): Promise<void> {
  await ensureConversation(conversationId);
  const db = requireMainDb();
  const messages = db.schema.messages;
  await db.orm.insert(messages).values({
    id,
    conversationId,
    role: "assistant",
    content: JSON.stringify([{ type: "text", text: "reply" }]),
    createdAt,
  });
}

async function reset(): Promise<void> {
  const db = requireMainDb();
  await db.run(`DELETE FROM memory_v2_activation_logs`);
  await db.run(`DELETE FROM messages`);
}

describePg("harness/oracle extractOracleTurns", () => {
  beforeEach(reset);

  test("returns only mode='router' rows with a resolvable messageId", async () => {
    await insertMessage("m1", "c1", 100);
    await insertLog({
      conversationId: "c1",
      messageId: "m1",
      turn: 1,
      mode: "router",
      concepts: [makeConcept("a", "injected")],
      createdAt: 100,
    });
    // non-router row — ignored
    await insertMessage("m2", "c1", 200);
    await insertLog({
      conversationId: "c1",
      messageId: "m2",
      turn: 2,
      mode: "per-turn",
      concepts: [makeConcept("b", "injected")],
      createdAt: 200,
    });
    // router row, null messageId — skipped (no anchor)
    await insertLog({
      conversationId: "c1",
      messageId: null,
      turn: 3,
      mode: "router",
      concepts: [makeConcept("c", "injected")],
      createdAt: 300,
    });
    // router row, messageId does not resolve — skipped
    await insertLog({
      conversationId: "c1",
      messageId: "ghost",
      turn: 4,
      mode: "router",
      concepts: [makeConcept("d", "injected")],
      createdAt: 400,
    });

    const turns = await extractOracleTurns(requireMainDb(), { limit: 50 });
    expect(turns.length).toBe(1);
    expect(turns[0]?.turn).toBe(1);
    expect(turns[0]?.groundTruthSlugs).toEqual(["a"]);
    expect(turns[0]?.anchorMessageId).toBe("m1");
    expect(turns[0]?.anchorCreatedAt).toBe(100);
  });

  test("ground truth keeps injected/in_context, drops the rest", async () => {
    await insertMessage("m1", "c1", 100);
    await insertLog({
      conversationId: "c1",
      messageId: "m1",
      turn: 1,
      mode: "router",
      createdAt: 100,
      concepts: [
        makeConcept("inj", "injected"),
        makeConcept("ctx", "in_context"),
        makeConcept("noinj", "not_injected"),
        makeConcept("miss", "page_missing"),
        makeConcept("bad", "corrupt"),
      ],
    });
    const turns = await extractOracleTurns(requireMainDb());
    expect(turns[0]?.groundTruthSlugs.sort()).toEqual(["ctx", "inj"]);
  });

  test("includeNotInjected adds not_injected to ground truth", async () => {
    await insertMessage("m1", "c1", 100);
    await insertLog({
      conversationId: "c1",
      messageId: "m1",
      turn: 1,
      mode: "router",
      createdAt: 100,
      concepts: [
        makeConcept("inj", "injected"),
        makeConcept("noinj", "not_injected"),
      ],
    });
    const turns = await extractOracleTurns(requireMainDb(), {
      includeNotInjected: true,
    });
    expect(turns[0]?.groundTruthSlugs.sort()).toEqual(["inj", "noinj"]);
  });

  test("pageExists predicate drops slugs whose page is gone", async () => {
    await insertMessage("m1", "c1", 100);
    await insertLog({
      conversationId: "c1",
      messageId: "m1",
      turn: 1,
      mode: "router",
      createdAt: 100,
      concepts: [
        makeConcept("present", "injected"),
        makeConcept("gone", "injected"),
      ],
    });
    const turns = await extractOracleTurns(requireMainDb(), {
      pageExists: (slug) => slug === "present",
    });
    expect(turns[0]?.groundTruthSlugs).toEqual(["present"]);
  });

  test("skips rows whose ground truth is empty after filtering", async () => {
    await insertMessage("m1", "c1", 100);
    await insertLog({
      conversationId: "c1",
      messageId: "m1",
      turn: 1,
      mode: "router",
      createdAt: 100,
      concepts: [makeConcept("noinj", "not_injected")],
    });
    expect((await extractOracleTurns(requireMainDb())).length).toBe(0);
  });

  test("conversationIds filter restricts the scan", async () => {
    await insertMessage("m1", "c1", 100);
    await insertLog({
      conversationId: "c1",
      messageId: "m1",
      turn: 1,
      mode: "router",
      concepts: [makeConcept("a", "injected")],
      createdAt: 100,
    });
    await insertMessage("m2", "c2", 200);
    await insertLog({
      conversationId: "c2",
      messageId: "m2",
      turn: 1,
      mode: "router",
      concepts: [makeConcept("b", "injected")],
      createdAt: 200,
    });
    const turns = await extractOracleTurns(requireMainDb(), {
      conversationIds: ["c2"],
    });
    expect(turns.length).toBe(1);
    expect(turns[0]?.conversationId).toBe("c2");
  });
});
