import { describe, expect, test } from "bun:test";

import type { Conversation } from "@/types/conversation-types";

import {
  conversationStatus,
  filterConversations,
  sortByLastActivity,
} from "./conversation-filters";

function make(
  conversationId: string,
  overrides: Partial<Conversation> = {},
): Conversation {
  return {
    conversationId,
    title: conversationId,
    createdAt: 1,
    lastMessageAt: 1,
    ...overrides,
  };
}

const NO_IDS = new Set<string>();

describe("sortByLastActivity", () => {
  test("orders by last message, newest first", () => {
    const sorted = sortByLastActivity([
      make("old", { lastMessageAt: 10 }),
      make("new", { lastMessageAt: 30 }),
      make("mid", { lastMessageAt: 20 }),
    ]);
    expect(sorted.map((c) => c.conversationId)).toEqual(["new", "mid", "old"]);
  });

  test("falls back to createdAt when no message exists", () => {
    const sorted = sortByLastActivity([
      make("a", { lastMessageAt: undefined, createdAt: 5 }),
      make("b", { lastMessageAt: undefined, createdAt: 9 }),
    ]);
    expect(sorted.map((c) => c.conversationId)).toEqual(["b", "a"]);
  });
});

describe("conversationStatus", () => {
  test("working outranks a lingering needs-input flag", () => {
    const conversation = make("a");
    expect(
      conversationStatus(
        conversation,
        new Set(["a"]),
        new Set(["a"]),
      ),
    ).toBe("working");
  });

  test("attention alone reads as needs-input", () => {
    expect(conversationStatus(make("a"), NO_IDS, new Set(["a"]))).toBe(
      "needs-input",
    );
  });

  test("neither set means no chip", () => {
    expect(conversationStatus(make("a"), NO_IDS, NO_IDS)).toBeNull();
  });
});

describe("filterConversations", () => {
  const rows = [
    make("working", { lastMessageAt: 40 }),
    make("waiting", { lastMessageAt: 30 }),
    make("unread", { lastMessageAt: 20, hasUnseenLatestAssistantMessage: true }),
    make("idle", { lastMessageAt: 10 }),
  ];
  const processing = new Set(["working"]);
  const attention = new Set(["waiting"]);

  test("active is processing plus attention", () => {
    const result = filterConversations(rows, "active", {
      processingIds: processing,
      attentionIds: attention,
    });
    expect(result.map((c) => c.conversationId)).toEqual([
      "working",
      "waiting",
    ]);
  });

  test("unread keeps only unseen assistant replies", () => {
    const result = filterConversations(rows, "unread", {
      processingIds: processing,
      attentionIds: attention,
    });
    expect(result.map((c) => c.conversationId)).toEqual(["unread"]);
  });

  test("recent keeps everything in recency order", () => {
    const result = filterConversations(rows, "recent", {
      processingIds: processing,
      attentionIds: attention,
    });
    expect(result.map((c) => c.conversationId)).toEqual([
      "working",
      "waiting",
      "unread",
      "idle",
    ]);
  });

  test("honors the row limit", () => {
    const result = filterConversations(rows, "recent", {
      processingIds: processing,
      attentionIds: attention,
      limit: 2,
    });
    expect(result).toHaveLength(2);
  });
});
