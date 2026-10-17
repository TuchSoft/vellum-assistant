/**
 * Tests for the per-conversation wire surface record
 * (`persistence/conversation-tool-surface.ts`): the send-boundary recorder
 * stores the tools array a live turn sends with the delegation-section state
 * its prompt rendered, fork wakes read both back verbatim, and an unchanged
 * surface is never rewritten.
 */

import { beforeEach, expect, test } from "bun:test";

import {
  getConversationToolSurface as getConversationToolSurfaceViaPluginApi,
  getRecordedConversationToolSurface,
} from "../persistence/conversation-plugin-facade.js";
import {
  type ConversationToolSurface,
  getConversationToolSurface,
  hashConversationToolSurface,
  recordConversationToolSurface,
} from "../persistence/conversation-tool-surface.js";
import { requireMainDb } from "../persistence/db-facade.js";
import type { ToolDefinition } from "../providers/types.js";
import { describePg } from "./pg-test-db.js";

beforeEach(async () => {
  const db = requireMainDb();
  await db.run("DELETE FROM conversation_tool_surfaces");
  await db.run("DELETE FROM conversations");
  await db.run(
    "INSERT INTO conversations (id, created_at, updated_at) VALUES (?, ?, ?)",
    ["conv-1", Date.now(), Date.now()],
  );
});

const TOOLS: ToolDefinition[] = [
  {
    name: "remember",
    description: "Save a fact",
    input_schema: { type: "object", properties: { content: {} } },
  },
  { name: "bell_jingle", description: "Ring", input_schema: {} },
];

const SURFACE: ConversationToolSurface = {
  tools: TOOLS,
  delegateIndependentTasks: true,
};

async function storedRow(): Promise<{
  tools_hash: string;
  updated_at: number;
} | null> {
  return requireMainDb().get<{ tools_hash: string; updated_at: number }>(
    "SELECT tools_hash, updated_at FROM conversation_tool_surfaces WHERE conversation_id = ?",
    ["conv-1"],
  );
}

describePg("recordConversationToolSurface", () => {
  test("stores the surface and returns its content hash", async () => {
    const hash = await recordConversationToolSurface("conv-1", SURFACE);

    expect(hash).toBe(hashConversationToolSurface(SURFACE));
    expect((await storedRow())?.tools_hash).toBe(hash);
    expect(await getConversationToolSurface("conv-1")).toEqual(SURFACE);
  });

  test("replays the exact array, including key order and extra fields", async () => {
    const serverTool = {
      type: "web_search_20250305",
      name: "web_search",
      max_uses: 5,
    } as unknown as ToolDefinition;
    const tools = [...TOOLS, serverTool];

    await recordConversationToolSurface("conv-1", {
      tools,
      delegateIndependentTasks: false,
    });

    expect(
      JSON.stringify((await getConversationToolSurface("conv-1"))?.tools),
    ).toBe(JSON.stringify(tools));
  });

  test("the delegation-section state round-trips, unknown included", async () => {
    for (const delegateIndependentTasks of [true, false, null]) {
      await recordConversationToolSurface("conv-1", {
        tools: TOOLS,
        delegateIndependentTasks,
      });

      expect(
        (await getConversationToolSurface("conv-1"))?.delegateIndependentTasks,
      ).toBe(delegateIndependentTasks);
    }
  });

  test("an unchanged surface with a known hash skips the write", async () => {
    const hash = await recordConversationToolSurface("conv-1", SURFACE);
    const before = (await storedRow())!.updated_at;
    await requireMainDb().run(
      "UPDATE conversation_tool_surfaces SET updated_at = ? WHERE conversation_id = ?",
      [before - 1000, "conv-1"],
    );

    await recordConversationToolSurface("conv-1", SURFACE, hash);

    expect((await storedRow())!.updated_at).toBe(before - 1000);
  });

  test("an unchanged surface with no known hash compares against the stored row before writing", async () => {
    await recordConversationToolSurface("conv-1", SURFACE);
    const marker = 42;
    await requireMainDb().run(
      "UPDATE conversation_tool_surfaces SET updated_at = ? WHERE conversation_id = ?",
      [marker, "conv-1"],
    );

    // A freshly loaded conversation knows no hash yet; the stored row matches,
    // so nothing is rewritten.
    await recordConversationToolSurface("conv-1", SURFACE, undefined);

    expect((await storedRow())!.updated_at).toBe(marker);
  });

  test("a changed array overwrites the stored surface", async () => {
    const first = await recordConversationToolSurface("conv-1", SURFACE);
    const changed = { ...SURFACE, tools: TOOLS.slice(0, 1) };

    const second = await recordConversationToolSurface(
      "conv-1",
      changed,
      first,
    );

    expect(second).not.toBe(first);
    expect((await storedRow())?.tools_hash).toBe(second);
    expect(await getConversationToolSurface("conv-1")).toEqual(changed);
  });

  test("a change to the delegation-section state alone overwrites it too", async () => {
    // The state is part of the hash: a turn whose scope flips the section
    // (a background run's allowlist after an interactive turn) records it.
    const first = await recordConversationToolSurface("conv-1", SURFACE);
    const changed = { ...SURFACE, delegateIndependentTasks: false };

    const second = await recordConversationToolSurface(
      "conv-1",
      changed,
      first,
    );

    expect(second).not.toBe(first);
    expect((await storedRow())?.tools_hash).toBe(second);
    expect(await getConversationToolSurface("conv-1")).toEqual(changed);
  });

  test("a row recorded before the state existed reads unknown and is replaced on the next record", async () => {
    await requireMainDb().run(
      "INSERT INTO conversation_tool_surfaces (conversation_id, tools_json, tools_hash, updated_at) VALUES (?, ?, ?, ?)",
      ["conv-1", JSON.stringify(TOOLS), "pre-upgrade-hash", 1],
    );

    expect(await getConversationToolSurface("conv-1")).toEqual({
      tools: TOOLS,
      delegateIndependentTasks: null,
    });

    // The stored hash predates the state, so the next live turn's record
    // rewrites the row with it.
    const hash = await recordConversationToolSurface(
      "conv-1",
      SURFACE,
      undefined,
    );

    expect((await storedRow())?.tools_hash).toBe(hash);
    expect(await getConversationToolSurface("conv-1")).toEqual(SURFACE);
  });
});

describePg("getConversationToolSurface", () => {
  test("returns null when no turn has recorded a surface", async () => {
    expect(await getConversationToolSurface("conv-1")).toBeNull();
  });

  test("returns null for an unreadable stored payload", async () => {
    await requireMainDb().run(
      "INSERT INTO conversation_tool_surfaces (conversation_id, tools_json, tools_hash, updated_at) VALUES (?, ?, ?, ?)",
      ["conv-1", "not json", "h", 1],
    );

    expect(await getConversationToolSurface("conv-1")).toBeNull();
  });

  test("the row cascades with its conversation", async () => {
    await recordConversationToolSurface("conv-1", SURFACE);

    await requireMainDb().run("DELETE FROM conversations WHERE id = ?", [
      "conv-1",
    ]);

    expect(await getConversationToolSurface("conv-1")).toBeNull();
  });
});

describePg("plugin facade", () => {
  test("the array accessor is a projection of the recorded surface", async () => {
    expect(await getConversationToolSurfaceViaPluginApi("conv-1")).toBeNull();
    expect(await getRecordedConversationToolSurface("conv-1")).toBeNull();

    await recordConversationToolSurface("conv-1", SURFACE);

    expect(await getRecordedConversationToolSurface("conv-1")).toEqual(SURFACE);
    // The array shape the public `@vellumai/plugin-api` accessor returns.
    expect(await getConversationToolSurfaceViaPluginApi("conv-1")).toEqual(
      TOOLS,
    );
  });
});
