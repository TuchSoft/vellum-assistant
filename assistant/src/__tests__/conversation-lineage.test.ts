/**
 * Tests for `resolveConversationLineage`: a conversation plus every subagent
 * ancestor above it, nearest first, bounded by a depth cap and a visited set.
 */

import { beforeEach, describe, expect, mock, test } from "bun:test";

/**
 * Resident top-level conversations, mapped to the id they were forked from —
 * the eviction-managed store. A key absent from the map stands for a
 * conversation that is not resident there.
 */
let residents = new Map<string, string | undefined>();

/**
 * Resident subagent conversations, in the separate index `SubagentManager`
 * owns. A background subagent's id lives only here, never in `residents`.
 */
let subagentResidents = new Map<string, string | undefined>();

mock.module("../daemon/conversation-registry.js", () => ({
  findConversationOrSubagent: (id: string | undefined) => {
    if (id === undefined) {
      return undefined;
    }
    // Mirrors the registry: top-level store first, then the subagent index.
    if (residents.has(id)) {
      return { parentConversationId: residents.get(id) };
    }
    if (subagentResidents.has(id)) {
      return { parentConversationId: subagentResidents.get(id) };
    }
    return undefined;
  },
  /** Present so a lookup through the top-level-only accessor fails loudly. */
  findConversation: () => {
    throw new Error(
      "lineage must resolve through findConversationOrSubagent, not findConversation",
    );
  },
}));

/**
 * Durable `parent_conversation_id` rows, keyed by conversation id. Stands for
 * parentage that outlives residency in either in-memory index.
 */
let persistedParents = new Map<string, string>();

/** When set, every durable read fails — the degraded-database case. */
let persistedReadFails = false;

mock.module("../persistence/conversation-parent.js", () => ({
  getPersistedParentConversationId: (id: string) => {
    if (persistedReadFails) {
      throw new Error("database unavailable");
    }
    return persistedParents.get(id);
  },
}));

const { MAX_LINEAGE_DEPTH, resolveConversationLineage } =
  await import("../daemon/conversation-lineage.js");

describe("resolveConversationLineage", () => {
  beforeEach(() => {
    residents = new Map();
    subagentResidents = new Map();
    persistedParents = new Map();
    persistedReadFails = false;
  });

  test("a plain conversation is its own lineage", async () => {
    residents.set("conv-a", undefined);

    expect(await resolveConversationLineage("conv-a")).toEqual(["conv-a"]);
  });

  test("one fork level reaches the spawner", async () => {
    residents.set("conv-child", "conv-parent");
    residents.set("conv-parent", undefined);

    expect(await resolveConversationLineage("conv-child")).toEqual([
      "conv-child",
      "conv-parent",
    ]);
  });

  test("two fork levels are ordered nearest first", async () => {
    residents.set("conv-child", "conv-mid");
    residents.set("conv-mid", "conv-root");
    residents.set("conv-root", undefined);

    expect(await resolveConversationLineage("conv-child")).toEqual([
      "conv-child",
      "conv-mid",
      "conv-root",
    ]);
  });

  test("a background subagent id reaches its user-visible parent", async () => {
    // The live-voice duplex continuation: the seed id is registered only in
    // the subagent index, never in the eviction-managed top-level store.
    subagentResidents.set("conv-subagent", "conv-visible");
    residents.set("conv-visible", undefined);

    expect(await resolveConversationLineage("conv-subagent")).toEqual([
      "conv-subagent",
      "conv-visible",
    ]);
  });

  test("nested subagents walk out of the subagent index into the store", async () => {
    subagentResidents.set("conv-inner", "conv-outer");
    subagentResidents.set("conv-outer", "conv-visible");
    residents.set("conv-visible", undefined);

    expect(await resolveConversationLineage("conv-inner")).toEqual([
      "conv-inner",
      "conv-outer",
      "conv-visible",
    ]);
  });

  test("a conversation resident nowhere and unparented in the database is its own lineage", async () => {
    expect(await resolveConversationLineage("conv-gone")).toEqual([
      "conv-gone",
    ]);
  });

  test("a non-resident ancestor with no durable parentage ends the walk", async () => {
    residents.set("conv-child", "conv-evicted");

    expect(await resolveConversationLineage("conv-child")).toEqual([
      "conv-child",
      "conv-evicted",
    ]);
  });

  // ── Durable parentage ─────────────────────────────────────────────────────
  // The subagent index entry is dropped as soon as a run goes terminal and
  // idle top-level conversations are evicted, so an artifact linked after
  // either point must still reach the user-visible thread.

  test("a seed dropped from the subagent index still reaches its parent", async () => {
    persistedParents.set("conv-terminal-subagent", "conv-visible");
    residents.set("conv-visible", undefined);

    expect(await resolveConversationLineage("conv-terminal-subagent")).toEqual([
      "conv-terminal-subagent",
      "conv-visible",
    ]);
  });

  test("an ancestor resident only in the database is reached", async () => {
    subagentResidents.set("conv-inner", "conv-outer");
    persistedParents.set("conv-outer", "conv-visible");

    expect(await resolveConversationLineage("conv-inner")).toEqual([
      "conv-inner",
      "conv-outer",
      "conv-visible",
    ]);
  });

  test("the resident record wins over the durable column", async () => {
    subagentResidents.set("conv-fork", "conv-resident-parent");
    persistedParents.set("conv-fork", "conv-stale-parent");
    residents.set("conv-resident-parent", undefined);

    expect(await resolveConversationLineage("conv-fork")).toEqual([
      "conv-fork",
      "conv-resident-parent",
    ]);
  });

  test("a failing durable read degrades to the chain resolved so far", async () => {
    subagentResidents.set("conv-inner", "conv-outer");
    persistedReadFails = true;

    expect(async () => {
      await resolveConversationLineage("conv-inner");
    }).not.toThrow();
    expect(await resolveConversationLineage("conv-inner")).toEqual([
      "conv-inner",
      "conv-outer",
    ]);
  });

  test("a cycle spanning the durable column terminates", async () => {
    persistedParents.set("conv-a", "conv-b");
    persistedParents.set("conv-b", "conv-a");

    expect(await resolveConversationLineage("conv-a")).toEqual([
      "conv-a",
      "conv-b",
    ]);
  });

  test("a durable chain longer than the depth cap is truncated at the cap", async () => {
    const chain = Array.from(
      { length: MAX_LINEAGE_DEPTH + 5 },
      (_, i) => `conv-durable-${i}`,
    );
    for (const [i, id] of chain.entries()) {
      const parent = chain[i + 1];
      if (parent) {
        persistedParents.set(id, parent);
      }
    }

    expect(await resolveConversationLineage(chain[0]!)).toEqual(
      chain.slice(0, MAX_LINEAGE_DEPTH),
    );
  });

  test("a self-referential parent does not loop forever", async () => {
    residents.set("conv-self", "conv-self");

    expect(await resolveConversationLineage("conv-self")).toEqual([
      "conv-self",
    ]);
  });

  test("a cycle between two conversations terminates", async () => {
    residents.set("conv-a", "conv-b");
    residents.set("conv-b", "conv-a");

    expect(await resolveConversationLineage("conv-a")).toEqual([
      "conv-a",
      "conv-b",
    ]);
  });

  test("a chain longer than the depth cap is truncated at the cap", async () => {
    const chain = Array.from(
      { length: MAX_LINEAGE_DEPTH + 5 },
      (_, i) => `conv-${i}`,
    );
    for (const [i, id] of chain.entries()) {
      residents.set(id, chain[i + 1]);
    }

    expect(await resolveConversationLineage(chain[0]!)).toEqual(
      chain.slice(0, MAX_LINEAGE_DEPTH),
    );
  });
});
