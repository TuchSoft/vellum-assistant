/**
 * Tests for the memory v2 activation-log store. The store reads and writes
 * `memory_v2_activation_logs` in the shared Postgres database.
 */
import { beforeEach, expect, setDefaultTimeout, test } from "bun:test";

setDefaultTimeout(30_000);

import { describePg } from "../../../../__tests__/pg-test-db.js";
import { requireMainDb } from "../../../../persistence/db-facade.js";
import {
  backfillMemoryV2ActivationMessageId,
  getMemoryV2ActivationLogByMessageIds,
  type MemoryV2ConceptRowRecord,
  recordMemoryV2ActivationLog,
} from "../v2/activation-log-store.js";
import {
  sampleConcepts,
  sampleConfig,
} from "./fixtures/memory-v2-activation-fixtures.js";

interface LogRow {
  message_id: string | null;
  turn: number;
  mode: string;
}

async function allRows(): Promise<LogRow[]> {
  return await requireMainDb().all<LogRow>(
    `SELECT message_id, turn, mode FROM memory_v2_activation_logs ORDER BY turn`,
  );
}

describePg("memory-v2-activation-log-store", () => {
  beforeEach(async () => {
    await requireMainDb().run(`DELETE FROM memory_v2_activation_logs`);
  });

  test("round-trip: record → backfill messageId → query by messageId", async () => {
    const conversationId = "conv-1";
    const messageId = "msg-1";

    await recordMemoryV2ActivationLog({
      conversationId,
      turn: 3,
      mode: "per-turn",
      concepts: sampleConcepts,
      config: sampleConfig,
    });

    await backfillMemoryV2ActivationMessageId(conversationId, messageId);

    const result = await getMemoryV2ActivationLogByMessageIds([messageId]);
    expect(result).not.toBeNull();
    expect(result!.conversationId).toBe(conversationId);
    expect(result!.turn).toBe(3);
    expect(result!.mode).toBe("per-turn");
    expect(result!.concepts).toEqual(sampleConcepts);
    expect(result!.config).toEqual(sampleConfig);
  });

  test("round-trip: router-mode log row with zeroed activations and source: 'router'", async () => {
    const conversationId = "conv-router";
    const messageId = "msg-router";

    const routerConcepts: MemoryV2ConceptRowRecord[] = [
      {
        slug: "concept-router-a",
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
        status: "injected",
      },
      {
        slug: "concept-router-b",
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
        status: "not_injected",
      },
    ];

    await recordMemoryV2ActivationLog({
      conversationId,
      turn: 7,
      mode: "router",
      concepts: routerConcepts,
      config: sampleConfig,
    });

    await backfillMemoryV2ActivationMessageId(conversationId, messageId);

    const result = await getMemoryV2ActivationLogByMessageIds([messageId]);
    expect(result).not.toBeNull();
    expect(result!.conversationId).toBe(conversationId);
    expect(result!.turn).toBe(7);
    expect(result!.mode).toBe("router");
    expect(result!.concepts).toEqual(routerConcepts);
    expect(result!.config).toEqual(sampleConfig);
    for (const concept of result!.concepts) {
      expect(concept.source).toBe("router");
      expect(concept.finalActivation).toBe(0);
      expect(concept.ownActivation).toBe(0);
      expect(concept.priorActivation).toBe(0);
      expect(concept.simUser).toBe(0);
      expect(concept.simAssistant).toBe(0);
      expect(concept.simNow).toBe(0);
      expect(concept.simUserRerankBoost).toBe(0);
      expect(concept.simAssistantRerankBoost).toBe(0);
      expect(concept.spreadContribution).toBe(0);
    }
  });

  test("returns null for empty messageIds array", async () => {
    const result = await getMemoryV2ActivationLogByMessageIds([]);
    expect(result).toBeNull();
  });

  test("writes land in the memory connection", async () => {
    await recordMemoryV2ActivationLog({
      conversationId: "conv-mem",
      turn: 1,
      mode: "per-turn",
      concepts: sampleConcepts,
      config: sampleConfig,
    });
    const row = await requireMainDb().get<{ n: number }>(
      `SELECT COUNT(*) AS n FROM memory_v2_activation_logs`,
    );
    expect(row!.n).toBe(1);
  });

  test("backfill only updates rows with NULL messageId", async () => {
    const conversationId = "conv-2";

    await recordMemoryV2ActivationLog({
      conversationId,
      turn: 1,
      mode: "context-load",
      concepts: sampleConcepts,
      config: sampleConfig,
    });
    await recordMemoryV2ActivationLog({
      conversationId,
      turn: 2,
      mode: "per-turn",
      concepts: sampleConcepts,
      config: sampleConfig,
    });

    // First backfill: both rows should now have msg-a.
    await backfillMemoryV2ActivationMessageId(conversationId, "msg-a");

    const afterFirstBackfill = await allRows();
    expect(afterFirstBackfill).toHaveLength(2);
    for (const row of afterFirstBackfill) {
      expect(row.message_id).toBe("msg-a");
    }

    // Record a third row (messageId is NULL initially).
    await recordMemoryV2ActivationLog({
      conversationId,
      turn: 3,
      mode: "per-turn",
      concepts: sampleConcepts,
      config: sampleConfig,
    });

    // Second backfill with msg-b should only set the third row,
    // and must not overwrite the first two rows already set to msg-a.
    await backfillMemoryV2ActivationMessageId(conversationId, "msg-b");

    const byTurn = new Map((await allRows()).map((r) => [r.turn, r]));
    expect(byTurn.get(1)!.message_id).toBe("msg-a");
    expect(byTurn.get(2)!.message_id).toBe("msg-a");
    expect(byTurn.get(3)!.message_id).toBe("msg-b");
  });

  test("backfill skips v3_shadow rows, leaving their messageId null", async () => {
    const conversationId = "conv-shadow-backfill";

    // A live router row (null messageId) and a detached v3_shadow row (null
    // messageId) coexist in the same conversation.
    await recordMemoryV2ActivationLog({
      conversationId,
      turn: 5,
      mode: "router",
      concepts: sampleConcepts,
      config: sampleConfig,
    });
    await recordMemoryV2ActivationLog({
      conversationId,
      turn: 5,
      mode: "v3_shadow",
      concepts: sampleConcepts,
      config: sampleConfig,
    });

    await backfillMemoryV2ActivationMessageId(conversationId, "msg-live");

    const byMode = new Map((await allRows()).map((r) => [r.mode, r]));
    // The live router row got stamped; the shadow row stayed null (not
    // mis-attributed to the live message).
    expect(byMode.get("router")!.message_id).toBe("msg-live");
    expect(byMode.get("v3_shadow")!.message_id).toBeNull();
  });
});
