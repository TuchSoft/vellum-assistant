import { beforeEach, expect, setDefaultTimeout, test } from "bun:test";

import {
  buildCallCompletionMessage,
  persistCallCompletionMessage,
} from "../calls/call-conversation-messages.js";
import {
  createCallSession,
  recordCallEvent,
  updateCallSession,
} from "../calls/call-store.js";
import { addMessage, getMessages } from "../persistence/conversation-crud.js";
import { requireMainDb } from "../persistence/db-facade.js";
import { contentBlockArraySchema } from "../providers/content-block-schema.js";
import { describePg } from "./pg-test-db.js";

async function ensureConversation(id: string): Promise<void> {
  const db = requireMainDb();
  const now = Date.now();
  await db.run(
    "INSERT INTO conversations (id, title, created_at, updated_at) VALUES (?, ?, ?, ?)",
    [id, `Conversation ${id}`, now, now],
  );
}

async function resetTables(): Promise<void> {
  const db = requireMainDb();
  await db.run("DELETE FROM call_events");
  await db.run("DELETE FROM call_pending_questions");
  await db.run("DELETE FROM call_sessions");
  await db.run("DELETE FROM messages");
  await db.run("DELETE FROM conversations");
}

type PersistedBlock = {
  type: string;
  text?: string;
  surfaceType?: string;
  surfaceId?: string;
  data?: { summaryText?: string };
  _surfaceFallback?: boolean;
};

/**
 * The blocks of the latest assistant message carrying a `call_summary` card.
 *
 * Selecting on the card rather than on "latest assistant row" keeps these
 * assertions independent of rows other test files leave in the shared
 * workspace DB when the suite runs as one process.
 */
async function getLatestAssistantBlocks(
  conversationId: string,
): Promise<PersistedBlock[]> {
  const rows = (await getMessages(conversationId)).filter((m) => {
    if (m.role !== "assistant") {
      return false;
    }
    const blocks = m.content as unknown as PersistedBlock[];
    return (
      Array.isArray(blocks) &&
      blocks.some(
        (b) => b.type === "ui_surface" && b.surfaceType === "call_summary",
      )
    );
  });
  expect(rows.length).toBeGreaterThan(0);
  return rows[rows.length - 1].content as unknown as PersistedBlock[];
}

/**
 * The message's model-visible copy. A call summary persists as a
 * `[ui_surface, text]` pair carrying the SAME sentence, so text blocks win and
 * the card is read only for legacy rows that predate the fallback sibling —
 * concatenating both would double the summary.
 */
async function getLatestAssistantText(conversationId: string): Promise<string> {
  const parsed = await getLatestAssistantBlocks(conversationId);
  const text = parsed
    .filter((b) => b.type === "text")
    .map((b) => b.text ?? "")
    .join("");
  if (text) {
    return text;
  }
  return parsed
    .filter((b) => b.type === "ui_surface" && b.surfaceType === "call_summary")
    .map((b) => b.data?.summaryText ?? "")
    .join("");
}

describePg("call-conversation-messages", () => {
  beforeEach(async () => {
    await resetTables();
  });

  test("buildCallCompletionMessage labels failed calls correctly", async () => {
    const conversationId = "conv-call-msg-failed";
    await ensureConversation(conversationId);
    const session = await createCallSession({
      direction: "inbound",
      conversationId,
      provider: "twilio",
      fromNumber: "+15550001111",
      toNumber: "+15550002222",
    });

    await updateCallSession(session.id, {
      status: "in_progress",
      startedAt: 1_000,
    });
    await updateCallSession(session.id, { status: "failed", endedAt: 6_000 });
    await recordCallEvent(session.id, "call_connected");
    await recordCallEvent(session.id, "call_failed");

    expect(await buildCallCompletionMessage(session.id)).toBe(
      "**Call failed** (5s). 2 event(s) recorded.",
    );
  });

  test("buildCallCompletionMessage labels cancelled calls correctly", async () => {
    const conversationId = "conv-call-msg-cancelled";
    await ensureConversation(conversationId);
    const session = await createCallSession({
      direction: "inbound",
      conversationId,
      provider: "twilio",
      fromNumber: "+15550001111",
      toNumber: "+15550002222",
    });

    await updateCallSession(session.id, {
      status: "in_progress",
      startedAt: 1_000,
    });
    await updateCallSession(session.id, {
      status: "cancelled",
      endedAt: 4_000,
    });
    await recordCallEvent(session.id, "call_connected");
    await recordCallEvent(session.id, "call_ended");

    expect(await buildCallCompletionMessage(session.id)).toBe(
      "**Call cancelled** (3s). 2 event(s) recorded.",
    );
  });

  test("persistCallCompletionMessage keeps completed label when status is completed", async () => {
    const conversationId = "conv-call-msg-completed";
    await ensureConversation(conversationId);
    const session = await createCallSession({
      direction: "inbound",
      conversationId,
      provider: "twilio",
      fromNumber: "+15550001111",
      toNumber: "+15550002222",
    });

    await updateCallSession(session.id, { status: "completed" });
    await recordCallEvent(session.id, "call_ended");

    const summary = await persistCallCompletionMessage(
      conversationId,
      session.id,
    );
    expect(summary).toBe("**Call completed**. 1 event(s) recorded.");
    expect(await getLatestAssistantText(conversationId)).toBe(
      "**Call completed**. 1 event(s) recorded.",
    );
  });

  test("persistCallCompletionMessage pairs the card with a flagged text fallback", async () => {
    // Every provider drops `ui_surface` when serializing history, so the card
    // alone left the model unable to tell that a call happened — the turn
    // reached the wire as a "blocks omitted" sentinel (LUM-2869). The
    // `_surfaceFallback` sibling is what carries the summary to the model,
    // search indexing, CLI display, and channel replies; its flag keeps
    // surface-capable clients from rendering the card AND a duplicate line.
    const conversationId = "conv-call-msg-fallback";
    await ensureConversation(conversationId);
    const session = await createCallSession({
      direction: "inbound",
      conversationId,
      provider: "twilio",
      fromNumber: "+12025550101",
      toNumber: "+12025550102",
    });

    await updateCallSession(session.id, {
      status: "in_progress",
      startedAt: 1_000,
    });
    await updateCallSession(session.id, {
      status: "completed",
      endedAt: 43_000,
    });
    await recordCallEvent(session.id, "call_ended");

    const summary = await persistCallCompletionMessage(
      conversationId,
      session.id,
    );
    const blocks = await getLatestAssistantBlocks(conversationId);

    expect(blocks).toHaveLength(2);
    const [surface, fallback] = blocks;

    expect(surface!.type).toBe("ui_surface");
    expect(surface!.surfaceType).toBe("call_summary");
    expect(surface!.surfaceId).toBeTruthy();
    expect(surface!.data?.summaryText).toBe(summary);

    expect(fallback!.type).toBe("text");
    expect(fallback!._surfaceFallback).toBe(true);
    expect(fallback!.text).toBe(summary);
    expect(fallback!.text).toContain("(42s)");
  });

  test("persisted call-summary blocks satisfy the ContentBlock schema", async () => {
    // The pair is JSON-serialized straight into `messages.content`. If it did
    // not validate, every read of the row would pay the per-block repair —
    // the read-path noise that spiked with voice GA (LUM-2869).
    const conversationId = "conv-call-msg-schema";
    await ensureConversation(conversationId);
    const session = await createCallSession({
      direction: "inbound",
      conversationId,
      provider: "twilio",
      fromNumber: "+12025550101",
      toNumber: "+12025550102",
    });
    await updateCallSession(session.id, { status: "completed" });
    await recordCallEvent(session.id, "call_ended");
    await persistCallCompletionMessage(conversationId, session.id);

    const blocks = await getLatestAssistantBlocks(conversationId);
    expect(contentBlockArraySchema.safeParse(blocks).success).toBe(true);
  });

  test("persisting a card-only message throws in tests (model-invisible guard)", async () => {
    // The guard in `insertMessageCore` is what stops LUM-2869 recurring: a
    // producer that persists a card with no model-readable sibling fails its
    // own suite instead of silently shipping turns the model cannot see.
    // (In production the same condition only warns — never-block posture.)
    const conversationId = "conv-card-only-guard";
    await ensureConversation(conversationId);
    await expect(
      addMessage(
        conversationId,
        "assistant",
        JSON.stringify([
          {
            type: "ui_surface",
            surfaceId: "bare-1",
            surfaceType: "call_summary",
            data: { summaryText: "orphaned card" },
          },
        ]),
      ),
    ).rejects.toThrow(/only content is ui_surface/);
  });
});

setDefaultTimeout(30_000);
