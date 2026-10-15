import { afterEach, describe, expect, mock, test } from "bun:test";

// ─── Mocks ─────────────────────────────────────────────────────────────

let sidechainCalls = 0;

// In-memory stand-in for the memory_checkpoints table so the cache
// round-trips without a real database.
const checkpointStore = new Map<string, string>();

mock.module("../../persistence/checkpoints.js", () => ({
  getMemoryCheckpoint: (key: string) => checkpointStore.get(key) ?? null,
  setMemoryCheckpoint: (key: string, value: string) => {
    checkpointStore.set(key, value);
  },
  deleteMemoryCheckpoint: (key: string) => {
    checkpointStore.delete(key);
  },
}));

mock.module("../../runtime/btw-sidechain.js", () => ({
  runBtwSidechain: async () => {
    sidechainCalls++;
    return { text: "should never be called" };
  },
}));

const { getSuggestedPrompts, refreshAssistantSuggestedPrompts } =
  await import("../suggested-prompts.js");
const { invalidateAssistantSuggestedPromptsCache } =
  await import("../suggested-prompts-cache.js");

// ─── Tests ─────────────────────────────────────────────────────────────

// Suggested prompts are disabled by custom patch 06: the producer never
// asks the LLM for prompts and always serves an empty list. These tests
// pin that kill-switch contract so an upstream re-enable cannot slip in
// silently.

describe("getSuggestedPrompts", () => {
  afterEach(() => {
    checkpointStore.clear();
    sidechainCalls = 0;
  });

  test("always returns an empty array", async () => {
    expect(await getSuggestedPrompts()).toEqual([]);
  });

  test("refresh always reports no new content", async () => {
    expect(await refreshAssistantSuggestedPrompts()).toBe(false);
  });

  test("refresh never invokes the LLM sidechain", async () => {
    await refreshAssistantSuggestedPrompts();
    expect(sidechainCalls).toBe(0);
  });

  test("prompts stay empty after refresh and invalidation", async () => {
    await refreshAssistantSuggestedPrompts();
    invalidateAssistantSuggestedPromptsCache();
    expect(await getSuggestedPrompts()).toEqual([]);
  });

  test("no prompt cache is written to the checkpoint store", async () => {
    await refreshAssistantSuggestedPrompts();
    expect(checkpointStore.has("home:suggested_prompts:json")).toBe(false);
  });
});
