import {
  beforeEach,
  describe,
  expect,
  setDefaultTimeout,
  test,
} from "bun:test";

import { eq } from "drizzle-orm";

import {
  getAttentionStateByConversationIds,
  listConversationAttention,
  markConversationUnread,
  projectAssistantMessage,
  recordConversationSeenSignal,
} from "../persistence/conversation-attention-store.js";
import { requireMainDb } from "../persistence/db-facade.js";
import {
  conversationAssistantAttentionState,
  conversationAttentionEvents,
  conversations,
  messages,
} from "../persistence/pg-schema/index.js";
import { describePg } from "./pg-test-db.js";

async function ensureConversation(id: string): Promise<void> {
  const db = requireMainDb();
  const now = Date.now();
  await db.orm.insert(conversations).values({
    id,
    title: `Conversation ${id}`,
    createdAt: now,
    updatedAt: now,
  });
}

async function clearTables(): Promise<void> {
  const db = requireMainDb();
  await db.orm.delete(conversationAttentionEvents);
  await db.orm.delete(conversationAssistantAttentionState);
  await db.orm.delete(messages);
  await db.orm.delete(conversations);
}

async function insertAssistantMessage(
  conversationId: string,
  messageId: string,
  createdAt: number,
): Promise<void> {
  const db = requireMainDb();
  await db.orm.insert(messages).values({
    id: messageId,
    conversationId,
    role: "assistant",
    content: `Assistant message ${messageId}`,
    createdAt,
    metadata: null,
  });
}

describePg("conversation-attention-store", () => {
  beforeEach(async () => {
    await clearTables();
  });

  // ── projectAssistantMessage ─────────────────────────────────────

  describe("projectAssistantMessage", () => {
    test("creates a new state row when none exists", async () => {
      await ensureConversation("conv-1");
      await projectAssistantMessage({
        conversationId: "conv-1",
        messageId: "msg-1",
        messageAt: 1000,
      });

      const states = await getAttentionStateByConversationIds(["conv-1"]);
      expect(states.size).toBe(1);
      const state = states.get("conv-1")!;
      expect(state.latestAssistantMessageId).toBe("msg-1");
      expect(state.latestAssistantMessageAt).toBe(1000);
      expect(state.lastSeenAssistantMessageId).toBeNull();
      expect(state.lastSeenAssistantMessageAt).toBeNull();
    });

    test("advances cursor when new message is later", async () => {
      await ensureConversation("conv-1");
      await projectAssistantMessage({
        conversationId: "conv-1",
        messageId: "msg-1",
        messageAt: 1000,
      });
      await projectAssistantMessage({
        conversationId: "conv-1",
        messageId: "msg-2",
        messageAt: 2000,
      });

      const states = await getAttentionStateByConversationIds(["conv-1"]);
      const state = states.get("conv-1")!;
      expect(state.latestAssistantMessageId).toBe("msg-2");
      expect(state.latestAssistantMessageAt).toBe(2000);
    });

    test("does not move cursor backward (monotonic invariant)", async () => {
      await ensureConversation("conv-1");
      await projectAssistantMessage({
        conversationId: "conv-1",
        messageId: "msg-2",
        messageAt: 2000,
      });
      await projectAssistantMessage({
        conversationId: "conv-1",
        messageId: "msg-1",
        messageAt: 1000,
      });

      const states = await getAttentionStateByConversationIds(["conv-1"]);
      const state = states.get("conv-1")!;
      expect(state.latestAssistantMessageId).toBe("msg-2");
      expect(state.latestAssistantMessageAt).toBe(2000);
    });

    test("does not advance cursor when timestamp is equal", async () => {
      await ensureConversation("conv-1");
      await projectAssistantMessage({
        conversationId: "conv-1",
        messageId: "msg-1",
        messageAt: 1000,
      });
      await projectAssistantMessage({
        conversationId: "conv-1",
        messageId: "msg-1-dup",
        messageAt: 1000,
      });

      const states = await getAttentionStateByConversationIds(["conv-1"]);
      const state = states.get("conv-1")!;
      expect(state.latestAssistantMessageId).toBe("msg-1");
    });

    test("returns true when creating new attention state (no prior state)", async () => {
      await ensureConversation("conv-1");
      const result = await projectAssistantMessage({
        conversationId: "conv-1",
        messageId: "msg-1",
        messageAt: 1000,
      });
      expect(result).toBe(true);
    });

    test("returns true when advancing cursor past seen position (seen→unseen)", async () => {
      await ensureConversation("conv-1");
      await projectAssistantMessage({
        conversationId: "conv-1",
        messageId: "msg-1",
        messageAt: 1000,
      });
      await recordConversationSeenSignal({
        conversationId: "conv-1",
        sourceChannel: "vellum",
        signalType: "macos_conversation_opened",
        confidence: "explicit",
        source: "test",
      });
      const result = await projectAssistantMessage({
        conversationId: "conv-1",
        messageId: "msg-2",
        messageAt: 2000,
      });
      expect(result).toBe(true);
    });

    test("returns false when conversation is already unseen", async () => {
      await ensureConversation("conv-1");
      await projectAssistantMessage({
        conversationId: "conv-1",
        messageId: "msg-1",
        messageAt: 1000,
      });
      const result = await projectAssistantMessage({
        conversationId: "conv-1",
        messageId: "msg-2",
        messageAt: 2000,
      });
      expect(result).toBe(false);
    });

    test("returns false when cursor does not advance (older message)", async () => {
      await ensureConversation("conv-1");
      await projectAssistantMessage({
        conversationId: "conv-1",
        messageId: "msg-2",
        messageAt: 2000,
      });
      const result = await projectAssistantMessage({
        conversationId: "conv-1",
        messageId: "msg-1",
        messageAt: 1000,
      });
      expect(result).toBe(false);
    });

    test("returns false when cursor does not advance (equal timestamp)", async () => {
      await ensureConversation("conv-1");
      await projectAssistantMessage({
        conversationId: "conv-1",
        messageId: "msg-1",
        messageAt: 1000,
      });
      const result = await projectAssistantMessage({
        conversationId: "conv-1",
        messageId: "msg-1-dup",
        messageAt: 1000,
      });
      expect(result).toBe(false);
    });

    test("returns true when row exists with null latestAssistantMessageAt (seen signal before first assistant msg)", async () => {
      await ensureConversation("conv-1");
      // Simulate: user opens conversation before any assistant message,
      // which calls recordConversationSeenSignal and creates a state row
      // with latestAssistantMessageAt = null.
      await recordConversationSeenSignal({
        conversationId: "conv-1",
        sourceChannel: "vellum",
        signalType: "macos_conversation_opened",
        confidence: "explicit",
        source: "test",
      });
      const states = await getAttentionStateByConversationIds(["conv-1"]);
      expect(states.get("conv-1")!.latestAssistantMessageAt).toBeNull();

      // First assistant message should transition to unseen
      const result = await projectAssistantMessage({
        conversationId: "conv-1",
        messageId: "msg-1",
        messageAt: 1000,
      });
      expect(result).toBe(true);
    });
  });

  // ── recordConversationSeenSignal ────────────────────────────────

  describe("recordConversationSeenSignal", () => {
    test("preserves iOS conversation-opened provenance", async () => {
      await ensureConversation("conv-1");
      await projectAssistantMessage({
        conversationId: "conv-1",
        messageId: "msg-1",
        messageAt: 1000,
      });

      await recordConversationSeenSignal({
        conversationId: "conv-1",
        sourceChannel: "vellum",
        signalType: "ios_conversation_opened",
        confidence: "explicit",
        source: "ios-client",
      });

      const states = await getAttentionStateByConversationIds(["conv-1"]);
      const state = states.get("conv-1")!;
      expect(state.lastSeenSignalType).toBe("ios_conversation_opened");
      expect(state.lastSeenAssistantMessageId).toBe("msg-1");
    });

    test("appends an immutable event row", async () => {
      await ensureConversation("conv-1");
      const event = await recordConversationSeenSignal({
        conversationId: "conv-1",
        sourceChannel: "vellum",
        signalType: "macos_conversation_opened",
        confidence: "explicit",
        source: "desktop-client",
      });

      expect(event.id).toBeTruthy();
      expect(event.conversationId).toBe("conv-1");
      expect(event.signalType).toBe("macos_conversation_opened");
      expect(event.confidence).toBe("explicit");
    });

    test("advances seen cursor to current latest assistant message", async () => {
      await ensureConversation("conv-1");

      // Project an assistant message first
      await projectAssistantMessage({
        conversationId: "conv-1",
        messageId: "msg-1",
        messageAt: 1000,
      });

      // Now record a seen signal
      await recordConversationSeenSignal({
        conversationId: "conv-1",
        sourceChannel: "vellum",
        signalType: "macos_conversation_opened",
        confidence: "explicit",
        source: "desktop-client",
      });

      const states = await getAttentionStateByConversationIds(["conv-1"]);
      const state = states.get("conv-1")!;
      expect(state.lastSeenAssistantMessageId).toBe("msg-1");
      expect(state.lastSeenAssistantMessageAt).toBe(1000);
    });

    test("creates state row if none exists when recording seen signal", async () => {
      await ensureConversation("conv-1");

      await recordConversationSeenSignal({
        conversationId: "conv-1",
        sourceChannel: "telegram",
        signalType: "telegram_inbound_message",
        confidence: "inferred",
        source: "telegram-gateway",
      });

      const states = await getAttentionStateByConversationIds(["conv-1"]);
      expect(states.size).toBe(1);
      const state = states.get("conv-1")!;
      // No latest assistant message to mark as seen
      expect(state.lastSeenAssistantMessageId).toBeNull();
      expect(state.lastSeenSignalType).toBe("telegram_inbound_message");
    });

    test("does not regress seen cursor (monotonic invariant)", async () => {
      await ensureConversation("conv-1");

      // Project two assistant messages
      await projectAssistantMessage({
        conversationId: "conv-1",
        messageId: "msg-1",
        messageAt: 1000,
      });

      // Mark as seen at msg-1
      await recordConversationSeenSignal({
        conversationId: "conv-1",
        sourceChannel: "vellum",
        signalType: "macos_conversation_opened",
        confidence: "explicit",
        source: "desktop-client",
      });

      // Project a second message
      await projectAssistantMessage({
        conversationId: "conv-1",
        messageId: "msg-2",
        messageAt: 2000,
      });

      // Mark as seen at msg-2
      await recordConversationSeenSignal({
        conversationId: "conv-1",
        sourceChannel: "vellum",
        signalType: "macos_conversation_opened",
        confidence: "explicit",
        source: "desktop-client",
      });

      const states = await getAttentionStateByConversationIds(["conv-1"]);
      const state = states.get("conv-1")!;
      expect(state.lastSeenAssistantMessageId).toBe("msg-2");
      expect(state.lastSeenAssistantMessageAt).toBe(2000);
    });

    test("records evidence text and metadata in event", async () => {
      await ensureConversation("conv-1");

      const event = await recordConversationSeenSignal({
        conversationId: "conv-1",
        sourceChannel: "telegram",
        signalType: "telegram_callback",
        confidence: "explicit",
        source: "telegram-gateway",
        evidenceText: "User pressed inline button",
        metadata: { callbackData: "ack:123" },
      });

      expect(event.evidenceText).toBe("User pressed inline button");
      expect(JSON.parse(event.metadataJson)).toEqual({
        callbackData: "ack:123",
      });
    });

    test("seen signal with no latest assistant message does not set seen cursor", async () => {
      await ensureConversation("conv-1");

      // Record seen signal without any assistant message
      await recordConversationSeenSignal({
        conversationId: "conv-1",
        sourceChannel: "vellum",
        signalType: "macos_notification_view",
        confidence: "inferred",
        source: "desktop-client",
      });

      const states = await getAttentionStateByConversationIds(["conv-1"]);
      const state = states.get("conv-1")!;
      expect(state.lastSeenAssistantMessageId).toBeNull();
      expect(state.lastSeenAssistantMessageAt).toBeNull();
      expect(state.lastSeenSignalType).toBe("macos_notification_view");
    });

    test("already-seen conversation does not regress on additional seen signal", async () => {
      await ensureConversation("conv-1");

      await projectAssistantMessage({
        conversationId: "conv-1",
        messageId: "msg-1",
        messageAt: 1000,
      });

      // Mark as seen
      await recordConversationSeenSignal({
        conversationId: "conv-1",
        sourceChannel: "vellum",
        signalType: "macos_conversation_opened",
        confidence: "explicit",
        source: "desktop-client",
      });

      // Record another seen signal (should not regress)
      await recordConversationSeenSignal({
        conversationId: "conv-1",
        sourceChannel: "telegram",
        signalType: "telegram_inbound_message",
        confidence: "inferred",
        source: "telegram-gateway",
      });

      const states = await getAttentionStateByConversationIds(["conv-1"]);
      const state = states.get("conv-1")!;
      // Seen cursor should still point to msg-1
      expect(state.lastSeenAssistantMessageId).toBe("msg-1");
      expect(state.lastSeenAssistantMessageAt).toBe(1000);
      // Signal metadata should reflect the latest signal
      expect(state.lastSeenSignalType).toBe("telegram_inbound_message");
    });
  });

  // ── markConversationUnread ───────────────────────────────────────

  describe("markConversationUnread", () => {
    test("rewinds the seen cursor to null when the latest assistant message is the first one", async () => {
      await ensureConversation("conv-1");
      await insertAssistantMessage("conv-1", "msg-1", 1000);
      await projectAssistantMessage({
        conversationId: "conv-1",
        messageId: "msg-1",
        messageAt: 1000,
      });
      await recordConversationSeenSignal({
        conversationId: "conv-1",
        sourceChannel: "vellum",
        signalType: "macos_conversation_opened",
        confidence: "explicit",
        source: "desktop-client",
      });

      await markConversationUnread("conv-1");

      const states = await getAttentionStateByConversationIds(["conv-1"]);
      const state = states.get("conv-1")!;
      expect(state.latestAssistantMessageId).toBe("msg-1");
      expect(state.lastSeenAssistantMessageId).toBeNull();
      expect(state.lastSeenAssistantMessageAt).toBeNull();
      expect(
        (await listConversationAttention({ state: "unseen" })).map(
          (entry) => entry.conversationId,
        ),
      ).toEqual(["conv-1"]);
    });

    test("rewinds the seen cursor to the prior assistant message", async () => {
      await ensureConversation("conv-1");
      await insertAssistantMessage("conv-1", "msg-1", 1000);
      await insertAssistantMessage("conv-1", "msg-2", 2000);
      await projectAssistantMessage({
        conversationId: "conv-1",
        messageId: "msg-1",
        messageAt: 1000,
      });
      await projectAssistantMessage({
        conversationId: "conv-1",
        messageId: "msg-2",
        messageAt: 2000,
      });
      await recordConversationSeenSignal({
        conversationId: "conv-1",
        sourceChannel: "vellum",
        signalType: "macos_conversation_opened",
        confidence: "explicit",
        source: "desktop-client",
      });

      await markConversationUnread("conv-1");

      const states = await getAttentionStateByConversationIds(["conv-1"]);
      const state = states.get("conv-1")!;
      expect(state.latestAssistantMessageId).toBe("msg-2");
      expect(state.latestAssistantMessageAt).toBe(2000);
      expect(state.lastSeenAssistantMessageId).toBe("msg-1");
      expect(state.lastSeenAssistantMessageAt).toBe(1000);
    });

    test("bootstraps unread rewind to a strictly older assistant timestamp", async () => {
      await ensureConversation("conv-1");
      await insertAssistantMessage("conv-1", "msg-1", 1000);
      await insertAssistantMessage("conv-1", "msg-2", 2000);
      await insertAssistantMessage("conv-1", "msg-3", 2000);

      await markConversationUnread("conv-1");

      const states = await getAttentionStateByConversationIds(["conv-1"]);
      const state = states.get("conv-1")!;
      expect(state.latestAssistantMessageId).toBe("msg-3");
      expect(state.latestAssistantMessageAt).toBe(2000);
      expect(state.lastSeenAssistantMessageId).toBe("msg-1");
      expect(state.lastSeenAssistantMessageAt).toBe(1000);
      expect(
        (await listConversationAttention({ state: "unseen" })).map(
          (entry) => entry.conversationId,
        ),
      ).toEqual(["conv-1"]);
    });

    test("is idempotent when the conversation is already unread", async () => {
      await ensureConversation("conv-1");
      await insertAssistantMessage("conv-1", "msg-1", 1000);
      await insertAssistantMessage("conv-1", "msg-2", 2000);
      await projectAssistantMessage({
        conversationId: "conv-1",
        messageId: "msg-1",
        messageAt: 1000,
      });
      await projectAssistantMessage({
        conversationId: "conv-1",
        messageId: "msg-2",
        messageAt: 2000,
      });
      await recordConversationSeenSignal({
        conversationId: "conv-1",
        sourceChannel: "vellum",
        signalType: "macos_conversation_opened",
        confidence: "explicit",
        source: "desktop-client",
      });

      await markConversationUnread("conv-1");
      const onceUnread = (
        await getAttentionStateByConversationIds(["conv-1"])
      ).get("conv-1")!;

      await markConversationUnread("conv-1");

      const twiceUnread = (
        await getAttentionStateByConversationIds(["conv-1"])
      ).get("conv-1")!;
      expect(twiceUnread.lastSeenAssistantMessageId).toBe(
        onceUnread.lastSeenAssistantMessageId,
      );
      expect(twiceUnread.lastSeenAssistantMessageAt).toBe(
        onceUnread.lastSeenAssistantMessageAt,
      );
    });

    test("rejects conversations with no assistant message", async () => {
      await ensureConversation("conv-1");

      await expect(markConversationUnread("conv-1")).rejects.toThrow(
        "Conversation has no assistant message to mark unread",
      );
    });
  });

  // ── getAttentionStateByConversationIds ──────────────────────────

  describe("getAttentionStateByConversationIds", () => {
    test("returns empty map for empty input", async () => {
      const result = await getAttentionStateByConversationIds([]);
      expect(result.size).toBe(0);
    });

    test("returns states for multiple conversations", async () => {
      await ensureConversation("conv-1");
      await ensureConversation("conv-2");

      await projectAssistantMessage({
        conversationId: "conv-1",
        messageId: "msg-1",
        messageAt: 1000,
      });
      await projectAssistantMessage({
        conversationId: "conv-2",
        messageId: "msg-2",
        messageAt: 2000,
      });

      const result = await getAttentionStateByConversationIds([
        "conv-1",
        "conv-2",
      ]);
      expect(result.size).toBe(2);
      expect(result.get("conv-1")!.latestAssistantMessageId).toBe("msg-1");
      expect(result.get("conv-2")!.latestAssistantMessageId).toBe("msg-2");
    });

    test("omits conversations without state", async () => {
      await ensureConversation("conv-1");
      await ensureConversation("conv-2");

      await projectAssistantMessage({
        conversationId: "conv-1",
        messageId: "msg-1",
        messageAt: 1000,
      });

      const result = await getAttentionStateByConversationIds([
        "conv-1",
        "conv-2",
      ]);
      expect(result.size).toBe(1);
      expect(result.has("conv-1")).toBe(true);
      expect(result.has("conv-2")).toBe(false);
    });
  });

  // ── listConversationAttention ───────────────────────────────────

  describe("listConversationAttention", () => {
    test("returns all states for an assistant", async () => {
      await ensureConversation("conv-1");
      await ensureConversation("conv-2");

      await projectAssistantMessage({
        conversationId: "conv-1",
        messageId: "msg-1",
        messageAt: 1000,
      });
      await projectAssistantMessage({
        conversationId: "conv-2",
        messageId: "msg-2",
        messageAt: 2000,
      });

      const result = await listConversationAttention({});
      expect(result).toHaveLength(2);
    });

    test("filters by unseen state", async () => {
      await ensureConversation("conv-1");
      await ensureConversation("conv-2");

      // conv-1: has assistant message, not seen
      await projectAssistantMessage({
        conversationId: "conv-1",
        messageId: "msg-1",
        messageAt: 1000,
      });

      // conv-2: has assistant message, seen
      await projectAssistantMessage({
        conversationId: "conv-2",
        messageId: "msg-2",
        messageAt: 2000,
      });
      await recordConversationSeenSignal({
        conversationId: "conv-2",
        sourceChannel: "vellum",
        signalType: "macos_conversation_opened",
        confidence: "explicit",
        source: "desktop-client",
      });

      const unseen = await listConversationAttention({
        state: "unseen",
      });
      expect(unseen).toHaveLength(1);
      expect(unseen[0].conversationId).toBe("conv-1");
    });

    test("filters by seen state", async () => {
      await ensureConversation("conv-1");
      await ensureConversation("conv-2");

      await projectAssistantMessage({
        conversationId: "conv-1",
        messageId: "msg-1",
        messageAt: 1000,
      });

      await projectAssistantMessage({
        conversationId: "conv-2",
        messageId: "msg-2",
        messageAt: 2000,
      });
      await recordConversationSeenSignal({
        conversationId: "conv-2",
        sourceChannel: "vellum",
        signalType: "macos_conversation_opened",
        confidence: "explicit",
        source: "desktop-client",
      });

      const seen = await listConversationAttention({
        state: "seen",
      });
      expect(seen).toHaveLength(1);
      expect(seen[0].conversationId).toBe("conv-2");
    });

    test("respects limit parameter", async () => {
      await ensureConversation("conv-1");
      await ensureConversation("conv-2");
      await ensureConversation("conv-3");

      await projectAssistantMessage({
        conversationId: "conv-1",
        messageId: "msg-1",
        messageAt: 1000,
      });
      await projectAssistantMessage({
        conversationId: "conv-2",
        messageId: "msg-2",
        messageAt: 2000,
      });
      await projectAssistantMessage({
        conversationId: "conv-3",
        messageId: "msg-3",
        messageAt: 3000,
      });

      const result = await listConversationAttention({
        limit: 2,
      });
      expect(result).toHaveLength(2);
    });

    test("orders by latest assistant message descending", async () => {
      await ensureConversation("conv-1");
      await ensureConversation("conv-2");
      await ensureConversation("conv-3");

      await projectAssistantMessage({
        conversationId: "conv-1",
        messageId: "msg-1",
        messageAt: 1000,
      });
      await projectAssistantMessage({
        conversationId: "conv-2",
        messageId: "msg-2",
        messageAt: 3000,
      });
      await projectAssistantMessage({
        conversationId: "conv-3",
        messageId: "msg-3",
        messageAt: 2000,
      });

      const result = await listConversationAttention({});
      expect(result[0].conversationId).toBe("conv-2");
      expect(result[1].conversationId).toBe("conv-3");
      expect(result[2].conversationId).toBe("conv-1");
    });

    test("before cursor filters out newer conversations", async () => {
      await ensureConversation("conv-1");
      await ensureConversation("conv-2");
      await ensureConversation("conv-3");

      await projectAssistantMessage({
        conversationId: "conv-1",
        messageId: "msg-1",
        messageAt: 1000,
      });
      await projectAssistantMessage({
        conversationId: "conv-2",
        messageId: "msg-2",
        messageAt: 2000,
      });
      await projectAssistantMessage({
        conversationId: "conv-3",
        messageId: "msg-3",
        messageAt: 3000,
      });

      const result = await listConversationAttention({
        before: 2500,
      });
      expect(result).toHaveLength(2);
      expect(result[0].conversationId).toBe("conv-2");
      expect(result[1].conversationId).toBe("conv-1");
    });
  });

  // ── Evidence immutability ───────────────────────────────────────

  describe("evidence immutability", () => {
    test("multiple seen signals append separate event rows", async () => {
      await ensureConversation("conv-1");

      await projectAssistantMessage({
        conversationId: "conv-1",
        messageId: "msg-1",
        messageAt: 1000,
      });

      await recordConversationSeenSignal({
        conversationId: "conv-1",
        sourceChannel: "vellum",
        signalType: "macos_notification_view",
        confidence: "inferred",
        source: "desktop-client",
      });

      await recordConversationSeenSignal({
        conversationId: "conv-1",
        sourceChannel: "vellum",
        signalType: "macos_conversation_opened",
        confidence: "explicit",
        source: "desktop-client",
      });

      const db = requireMainDb();
      const events = await db.orm
        .select()
        .from(conversationAttentionEvents)
        .where(eq(conversationAttentionEvents.conversationId, "conv-1"));

      expect(events).toHaveLength(2);
      expect(events[0].signalType).not.toBe(events[1].signalType);
    });
  });
});

describePg("attention watermarks and streaming rows", () => {
  test("state init from an upgraded database anchors on the latest finalized reply", async () => {
    await clearTables();
    await ensureConversation("conv-1");
    await insertAssistantMessage("conv-1", "msg-done", 1_000);
    await requireMainDb().orm.insert(messages).values({
      id: "msg-streaming",
      conversationId: "conv-1",
      role: "assistant",
      content: "still being written",
      createdAt: 2_000,
      metadata: null,
      finalized: 0,
    });

    // No attention row exists, so the seen signal initializes state from the
    // messages table. The streaming row is newest but is not a reply yet;
    // anchoring the watermark on it would classify the finished reply as
    // already seen the moment it completes.
    await recordConversationSeenSignal({
      conversationId: "conv-1",
      sourceChannel: "vellum",
      signalType: "macos_conversation_opened",
      confidence: "explicit",
      source: "desktop-client",
    });

    const state = (await getAttentionStateByConversationIds(["conv-1"])).get(
      "conv-1",
    )!;
    expect(state.latestAssistantMessageId).toBe("msg-done");
    expect(state.lastSeenAssistantMessageId).toBe("msg-done");
  });
});

describePg("markConversationUnread with only a streaming reply", () => {
  test("reports no assistant message rather than rewinding onto the streaming row", async () => {
    await clearTables();
    await ensureConversation("conv-1");
    await requireMainDb().orm.insert(messages).values({
      id: "msg-streaming-only",
      conversationId: "conv-1",
      role: "assistant",
      content: "still being written",
      createdAt: 1_000,
      metadata: null,
      finalized: 0,
    });

    // The write-path projection anchors at the finalize seam
    // (`reserveMessage` deliberately skips it), so attention state for this
    // conversation says "no reply yet". The rewind fallback must agree with
    // the projection rather than anchoring on the streaming row.
    await expect(markConversationUnread("conv-1")).rejects.toThrow(
      /no assistant message/i,
    );
  });
});

setDefaultTimeout(30_000);
