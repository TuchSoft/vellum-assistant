import { beforeEach, expect, mock, test } from "bun:test";

// Toggle for the share_analytics opt-out gate the audit listener consults
// when populating the telemetry columns.
let shareAnalytics = true;

mock.module("../platform/consent-cache.js", () => ({
  getRawShareAnalytics: () => shareAnalytics,
}));

import { describePg } from "../__tests__/pg-test-db.js";
import { requireMainDb } from "../persistence/db-facade.js";
import { initializeDb } from "../persistence/db-init.js";
import { recordToolExecuted } from "./tool-audit.js";
import { queryUnreportedToolExecutedEvents } from "./tool-executed-events-store.js";

await initializeDb();

const PII_SENTINEL = "must never leave the device";
const CONVERSATION_ID = "conv-tool-executed-store-test";

interface InvocationSpec {
  id: string;
  createdAt: number;
  toolName?: string;
  decision?: string;
  durationMs?: number;
  argBytes?: number | null;
  resultBytes?: number | null;
  provider?: string | null;
  model?: string | null;
  modelSource?: string | null;
}

async function waitForToolRows(count: number): Promise<void> {
  const deadline = Date.now() + 5_000;
  while (Date.now() < deadline) {
    const rows = await requireMainDb().all<{ id: string }>(
      `SELECT id FROM tool_invocations`,
    );
    if (rows.length >= count) {
      return;
    }
    await Bun.sleep(10);
  }
  throw new Error(`Timed out waiting for ${count} tool_invocations rows`);
}

async function insertInvocation(spec: InvocationSpec): Promise<void> {
  const db = requireMainDb();
  // tool_invocations has an enforced FK to conversations.
  await db.run(
    `INSERT INTO conversations (id, title, created_at, updated_at)
     VALUES (?, 'test', 1000, 1000)
     ON CONFLICT (id) DO NOTHING`,
    [CONVERSATION_ID],
  );
  await db.run(
    `INSERT INTO tool_invocations (
       id, conversation_id, tool_name, input, result, decision, risk_level,
       duration_ms, created_at, arg_bytes, result_bytes, provider, model,
       inference_profile, inference_profile_source
     ) VALUES (?, ?, ?, ?, ?, ?, 'low', ?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      spec.id,
      CONVERSATION_ID,
      spec.toolName ?? "calendar_list_events",
      `{"secret":"raw tool args - ${PII_SENTINEL}"}`,
      `{"secret":"raw tool output - ${PII_SENTINEL}"}`,
      spec.decision ?? "allow",
      spec.durationMs ?? 12,
      spec.createdAt,
      spec.argBytes !== undefined ? spec.argBytes : 2,
      spec.resultBytes !== undefined ? spec.resultBytes : 9,
      spec.provider ?? null,
      spec.model ?? null,
      spec.modelSource ?? null,
    ],
  );
}

describePg("tool-executed-events-store", () => {
  beforeEach(async () => {
    shareAnalytics = true;
    const db = requireMainDb();
    await db.run(`DELETE FROM tool_invocations`);
    await db.run(`DELETE FROM conversations`);
  });

  test("projects telemetry fields in (createdAt, id) order without input/result", async () => {
    await insertInvocation({
      id: "ti-b",
      createdAt: 2000,
      toolName: "web_search",
      decision: "error",
      durationMs: 7,
    });
    await insertInvocation({
      id: "ti-a",
      createdAt: 1000,
      argBytes: 42,
      resultBytes: 9001,
      provider: "anthropic",
      model: "model-a",
      modelSource: "chat",
    });

    const rows = await queryUnreportedToolExecutedEvents(0, undefined, 100);
    expect(rows.map((r) => r.id)).toEqual(["ti-a", "ti-b"]);
    expect(rows[0]).toEqual({
      id: "ti-a",
      toolName: "calendar_list_events",
      decision: "allow",
      durationMs: 12,
      argBytes: 42,
      resultBytes: 9001,
      provider: "anthropic",
      model: "model-a",
      modelSource: "chat",
      conversationId: CONVERSATION_ID,
      createdAt: 1000,
    });
    expect(rows[1]).toMatchObject({
      toolName: "web_search",
      decision: "error",
      durationMs: 7,
    });
    // Raw tool args/outputs are potentially PII — the projection must
    // never include them.
    expect(JSON.stringify(rows)).not.toContain(PII_SENTINEL);
  });

  test("excludes permission-denied rows", async () => {
    await insertInvocation({
      id: "ti-denied",
      createdAt: 1000,
      decision: "denied",
    });
    await insertInvocation({ id: "ti-allow", createdAt: 2000 });
    await insertInvocation({
      id: "ti-error",
      createdAt: 3000,
      decision: "error",
    });

    const rows = await queryUnreportedToolExecutedEvents(0, undefined, 100);
    expect(rows.map((r) => r.id)).toEqual(["ti-allow", "ti-error"]);
  });

  test("excludes legacy pre-migration rows (null arg_bytes)", async () => {
    // Already shipped under the reverted tool_execution type — never
    // projected, even from a zero watermark.
    await insertInvocation({
      id: "ti-legacy",
      createdAt: 1000,
      argBytes: null,
      resultBytes: null,
    });
    await insertInvocation({ id: "ti-new", createdAt: 2000 });

    const rows = await queryUnreportedToolExecutedEvents(0, undefined, 100);
    expect(rows.map((r) => r.id)).toEqual(["ti-new"]);
  });

  test("rows recorded while opted out are never projected, even from a zero watermark", async () => {
    // End-to-end through the real audit terminal: the write-time opt-out
    // gate persists NULL telemetry columns, which the arg_bytes IS NOT NULL
    // filter excludes permanently — the same mechanism as legacy rows. No
    // watermark state is involved, so no later opt-in can ship these rows.
    await requireMainDb().run(
      `INSERT INTO conversations (id, title, created_at, updated_at) VALUES (?, 'test', 1000, 1000) ON CONFLICT (id) DO NOTHING`,
      [CONVERSATION_ID],
    );
    const recordExecuted = async (toolName: string): Promise<void> =>
      await recordToolExecuted({
        conversationId: CONVERSATION_ID,
        toolName,
        input: { path: "/tmp/a" },
        resultContent: "ok",
        resultBytes: 2,
        decision: "allow",
        riskLevel: "low",
        durationMs: 5,
        attribution: null,
      });

    await recordExecuted("t-opted-in-before");

    shareAnalytics = false;
    await recordExecuted("t-opted-out");

    shareAnalytics = true;
    await recordExecuted("t-opted-in-after");
    await waitForToolRows(3);

    // Mid-session opt-out flip: only rows recorded while opted in project.
    const rows = await queryUnreportedToolExecutedEvents(0, undefined, 100);
    expect(rows.map((r) => r.toolName).sort()).toEqual([
      "t-opted-in-after",
      "t-opted-in-before",
    ]);

    // The audit row itself is still recorded — only its telemetry columns
    // are NULL.
    const auditRows = await requireMainDb().all<{
      toolName: string;
      decision: string;
      argBytes: number | null;
      resultBytes: number | null;
      provider: string | null;
      model: string | null;
      inferenceProfile: string | null;
    }>(
      `SELECT tool_name AS "toolName", decision, arg_bytes AS "argBytes", result_bytes AS "resultBytes", provider, model, model_source AS "modelSource" FROM tool_invocations`,
    );
    expect(auditRows).toHaveLength(3);
    const optedOut = auditRows.find((r) => r.toolName === "t-opted-out");
    expect(optedOut).toMatchObject({
      decision: "allow",
      argBytes: null,
      resultBytes: null,
      provider: null,
      model: null,
      modelSource: null,
    });
  });

  test("post-migration rows project with null attribution columns", async () => {
    await insertInvocation({ id: "ti-no-attr", createdAt: 1000 });

    const rows = await queryUnreportedToolExecutedEvents(0, undefined, 100);
    expect(rows[0]).toMatchObject({
      argBytes: 2,
      resultBytes: 9,
      provider: null,
      model: null,
      modelSource: null,
    });
  });

  test("query advances past the compound (createdAt, id) cursor", async () => {
    // Two rows in the same millisecond: pagination must use the id
    // tiebreaker to make forward progress, not loop.
    await insertInvocation({ id: "ti-1", createdAt: 5000 });
    await insertInvocation({ id: "ti-2", createdAt: 5000 });
    await insertInvocation({ id: "ti-3", createdAt: 6000 });

    const first = await queryUnreportedToolExecutedEvents(0, undefined, 1);
    expect(first.map((r) => r.id)).toEqual(["ti-1"]);

    const second = await queryUnreportedToolExecutedEvents(
      first[0]!.createdAt,
      first[0]!.id,
      100,
    );
    expect(second.map((r) => r.id)).toEqual(["ti-2", "ti-3"]);

    // Without an id cursor the timestamp-only branch is used.
    expect(
      (await queryUnreportedToolExecutedEvents(5000, undefined, 100)).map(
        (r) => r.id,
      ),
    ).toEqual(["ti-3"]);

    // Cursor past the last row returns nothing.
    const last = second[second.length - 1]!;
    expect(
      (await queryUnreportedToolExecutedEvents(last.createdAt, last.id, 100))
        .length,
    ).toBe(0);
  });

  test("honors the limit", async () => {
    await insertInvocation({ id: "ti-l1", createdAt: 1000 });
    await insertInvocation({ id: "ti-l2", createdAt: 2000 });
    await insertInvocation({ id: "ti-l3", createdAt: 3000 });

    const rows = await queryUnreportedToolExecutedEvents(0, undefined, 2);
    expect(rows.map((r) => r.id)).toEqual(["ti-l1", "ti-l2"]);
  });
});
