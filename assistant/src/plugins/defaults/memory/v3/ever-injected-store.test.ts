/**
 * Tests for `ever-injected-store.ts`, memory-v3's per-conversation record of
 * injected sections:
 *   - record/get/active-set round-trip at `(slug, key)` grain and re-record
 *     clearing `pruned_at`;
 *   - `markPruned` excluding exactly the named pair from the active set and
 *     `residentBytes`, leaving sibling sections of the page resident;
 *   - `touchSelected` stamping `last_selected_at` on exactly the named rows
 *     (batched past SQLite's expression depth), the stamp `recordInjected`
 *     sets for new and re-recorded rows and a full fork copies;
 *   - `clearConversation` (compaction reset), the conversation's legacy card
 *     rows included so no later copy re-imports them;
 *   - fork hooks: full-row copy (pruned state included) and truncated-fork
 *     seeding from inherited block sections (bytes measured from each
 *     inherited span, tombstones carried over);
 *   - migration idempotence (run twice), and the one-shot legacy copy the
 *     lazy per-connection ensure records in the checkpoint ledger.
 *
 * The rows live in the shared Postgres database. The plugin-init ensure and
 * the checkpoint ledger it records the one-shot legacy copy in are exercised
 * against the same fixture tables.
 */

import {
  afterEach,
  beforeEach,
  expect,
  setDefaultTimeout,
  test,
} from "bun:test";

setDefaultTimeout(30_000);

import { describePg } from "../../../../__tests__/pg-test-db.js";
import { requireMainDb } from "../../../../persistence/db-facade.js";
import { wrapMemoryBlock } from "../memory-marker.js";
import { injectedSectionHeader } from "../substrate/injected-block-slugs.js";
import { renderedBytes } from "../substrate/injected-block-slugs.js";
import {
  ensureMemoryV3InjectedSectionsSchema,
  ensureMemoryV3PluginSchema,
  SECTIONS_LEGACY_COPY_DONE_KEY,
} from "./plugin-schema.js";
import type { InjectedBlock } from "./types.js";

let previousDatabaseUrl: string | undefined;

async function resetTables(): Promise<void> {
  const db = requireMainDb();
  await db.run(`DELETE FROM memory_v3_injected_sections`);
  await db.run(`DELETE FROM memory_v3_ever_injected`);
  await db.run(`DELETE FROM memory_checkpoints WHERE key = ?`, [
    SECTIONS_LEGACY_COPY_DONE_KEY,
  ]);
}

const {
  clearConversation,
  forkEverInjected,
  getActiveEntries,
  getActiveSections,
  getInjected,
  getPrunedSections,
  markPruned,
  MEMORY_V3_INJECTED_BLOCK_METADATA_KEY,
  recordInjected,
  residentBytes,
  sectionRefSetHas,
  seedEverInjectedFromBlocks,
  touchSelected,
} = await import("./ever-injected-store.js");

beforeEach(async () => {
  previousDatabaseUrl = process.env.VELLUM_DATABASE_URL;
  await ensureMemoryV3InjectedSectionsSchema(requireMainDb());
  await resetTables();
});

afterEach(() => {
  if (previousDatabaseUrl === undefined) {
    delete process.env.VELLUM_DATABASE_URL;
  } else {
    process.env.VELLUM_DATABASE_URL = previousDatabaseUrl;
  }
});

/** Project the oracle rows down to the fields a test asserts on. */
async function summary(conversationId: string) {
  return (await getInjected(conversationId)).map(
    ({ slug, key, bytes, prunedAt }) => ({
      slug,
      key,
      bytes,
      prunedAt,
    }),
  );
}

/** The conversation's rows in the legacy card table, by slug. */
async function legacySlugs(conversationId: string): Promise<string[]> {
  const rows = await requireMainDb().all<{ slug: string }>(
    `SELECT slug FROM memory_v3_ever_injected
     WHERE conversation_id = ? ORDER BY slug`,
    [conversationId],
  );
  return rows.map((row) => row.slug);
}

/** Whether the ledger on the main connection records the legacy copy. */
async function legacyCopyRecorded(): Promise<boolean> {
  const row = await requireMainDb().get<{ value: string }>(
    `SELECT value FROM memory_checkpoints WHERE key = ?`,
    [SECTIONS_LEGACY_COPY_DONE_KEY],
  );
  return row != null;
}

describePg("metadata key constant", () => {
  test("exports the v3 injected-block metadata key", async () => {
    expect(MEMORY_V3_INJECTED_BLOCK_METADATA_KEY).toBe("memoryV3InjectedBlock");
  });
});

describePg("recordInjected / getInjected / getActiveSections", () => {
  test("round-trips the recorded entries at (slug, key) grain", async () => {
    await recordInjected(
      "conv-1",
      [
        { slug: "topics/page-a", key: "", bytes: 100 },
        { slug: "topics/page-a", key: "Notes", bytes: 80 },
        { slug: "topics/page-b", key: "Design#1", bytes: 250 },
      ],
      1_000,
    );

    expect(await summary("conv-1")).toEqual([
      { slug: "topics/page-a", key: "", bytes: 100, prunedAt: null },
      { slug: "topics/page-a", key: "Notes", bytes: 80, prunedAt: null },
      { slug: "topics/page-b", key: "Design#1", bytes: 250, prunedAt: null },
    ]);
    // The turn that injects a section selected it.
    expect(
      (await getInjected("conv-1")).map((row) => row.lastSelectedAt),
    ).toEqual([1_000, 1_000, 1_000]);
    const active = await getActiveSections("conv-1");
    expect(active).toEqual(
      new Map([
        ["topics/page-a", new Set(["", "Notes"])],
        ["topics/page-b", new Set(["Design#1"])],
      ]),
    );
    expect(sectionRefSetHas(active, "topics/page-a", "Notes")).toBe(true);
    expect(sectionRefSetHas(active, "topics/page-a", "Design")).toBe(false);
    expect(sectionRefSetHas(active, "topics/page-c", "")).toBe(false);
    // Other conversations see nothing.
    expect(await getInjected("conv-other")).toEqual([]);
    expect((await getActiveSections("conv-other")).size).toBe(0);
  });

  test("re-recording a pruned section clears pruned_at and refreshes bytes, injected_at, and last_selected_at", async () => {
    await recordInjected(
      "conv-1",
      [{ slug: "topics/page-a", key: "Notes", bytes: 100 }],
      1_000,
    );
    await markPruned(
      "conv-1",
      [{ slug: "topics/page-a", key: "Notes" }],
      2_000,
    );
    expect(await summary("conv-1")).toEqual([
      { slug: "topics/page-a", key: "Notes", bytes: 100, prunedAt: 2_000 },
    ]);

    await recordInjected(
      "conv-1",
      [{ slug: "topics/page-a", key: "Notes", bytes: 140 }],
      3_000,
    );

    expect(await getInjected("conv-1")).toEqual([
      {
        slug: "topics/page-a",
        key: "Notes",
        bytes: 140,
        injectedAt: 3_000,
        lastSelectedAt: 3_000,
        prunedAt: null,
      },
    ]);
    expect(await getActiveSections("conv-1")).toEqual(
      new Map([["topics/page-a", new Set(["Notes"])]]),
    );
  });

  test("empty entries are a no-op", async () => {
    await recordInjected("conv-1", []);
    expect(await getInjected("conv-1")).toEqual([]);
  });
});

describePg("markPruned / residentBytes / getPrunedSections", () => {
  test("pruned rows leave the active set and resident bytes but stay on record; siblings stay resident", async () => {
    await recordInjected(
      "conv-1",
      [
        { slug: "topics/page-a", key: "", bytes: 100 },
        { slug: "topics/page-a", key: "Notes", bytes: 250 },
        { slug: "topics/page-b", key: "", bytes: 50 },
      ],
      1_000,
    );
    expect(await residentBytes("conv-1")).toBe(400);

    await markPruned(
      "conv-1",
      [
        { slug: "topics/page-a", key: "" },
        { slug: "topics/page-b", key: "" },
      ],
      2_000,
    );

    expect(await getActiveSections("conv-1")).toEqual(
      new Map([["topics/page-a", new Set(["Notes"])]]),
    );
    expect(await getActiveEntries("conv-1")).toEqual([
      {
        slug: "topics/page-a",
        key: "Notes",
        bytes: 250,
        injectedAt: 1_000,
        lastSelectedAt: 1_000,
      },
    ]);
    expect(await getPrunedSections("conv-1")).toEqual(
      new Map([
        ["topics/page-a", new Set([""])],
        ["topics/page-b", new Set([""])],
      ]),
    );
    expect(await residentBytes("conv-1")).toBe(250);
    // Rows are never deleted — the record stays auditable.
    expect(await getInjected("conv-1")).toHaveLength(3);
  });

  test("tombstones a plan far larger than one batch (and SQLite's expression depth) in one call", async () => {
    const refs = Array.from({ length: 1_100 }, (_, i) => ({
      slug: `topics/page-${i}`,
      key: i % 2 === 0 ? "" : "Notes",
    }));
    await recordInjected(
      "conv-1",
      refs.map((ref) => ({ ...ref, bytes: 1 })),
      1_000,
    );
    await recordInjected(
      "conv-1",
      [{ slug: "survivor", key: "", bytes: 7 }],
      1_000,
    );
    expect(await residentBytes("conv-1")).toBe(1_107);

    await markPruned("conv-1", refs, 2_000);

    expect(await residentBytes("conv-1")).toBe(7);
    expect(await getActiveSections("conv-1")).toEqual(
      new Map([["survivor", new Set([""])]]),
    );
    expect((await getPrunedSections("conv-1")).size).toBe(1_100);
    expect(
      (await getInjected("conv-1")).filter((row) => row.prunedAt === 2_000),
    ).toHaveLength(1_100);
  });

  test("empty ref list is a no-op and residentBytes is 0 for unknown conversations", async () => {
    await recordInjected(
      "conv-1",
      [{ slug: "topics/page-a", key: "", bytes: 100 }],
      1_000,
    );
    await markPruned("conv-1", [], 2_000);
    expect(await residentBytes("conv-1")).toBe(100);
    expect(await residentBytes("conv-unknown")).toBe(0);
  });
});

describePg("touchSelected", () => {
  /** Each row's selection stamp, by `(slug, key)`. */
  async function stamps(conversationId: string) {
    return (await getInjected(conversationId)).map(
      ({ slug, key, lastSelectedAt }) => [slug, key, lastSelectedAt],
    );
  }

  test("stamps exactly the named rows, leaving injected_at and other conversations alone; an unknown ref is a no-op", async () => {
    await recordInjected(
      "conv-1",
      [
        { slug: "topics/page-a", key: "", bytes: 100 },
        { slug: "topics/page-a", key: "Notes", bytes: 80 },
        { slug: "topics/page-b", key: "", bytes: 50 },
      ],
      1_000,
    );
    await recordInjected(
      "conv-2",
      [{ slug: "topics/page-a", key: "Notes", bytes: 80 }],
      1_000,
    );

    await touchSelected(
      "conv-1",
      [
        { slug: "topics/page-a", key: "Notes" },
        { slug: "topics/page-b", key: "" },
        { slug: "topics/page-c", key: "" },
      ],
      2_000,
    );

    expect(await stamps("conv-1")).toEqual([
      ["topics/page-a", "", 1_000],
      ["topics/page-a", "Notes", 2_000],
      ["topics/page-b", "", 2_000],
    ]);
    expect(await stamps("conv-2")).toEqual([["topics/page-a", "Notes", 1_000]]);
    expect(
      (await getInjected("conv-1")).every((row) => row.injectedAt === 1_000),
    ).toBe(true);
  });

  test("stamps a ref list far larger than one batch (and SQLite's expression depth) in one call", async () => {
    const refs = Array.from({ length: 1_100 }, (_, i) => ({
      slug: `topics/page-${i}`,
      key: i % 2 === 0 ? "" : "Notes",
    }));
    await recordInjected(
      "conv-1",
      refs.map((ref) => ({ ...ref, bytes: 1 })),
      1_000,
    );

    await touchSelected("conv-1", refs, 2_000);

    expect(
      (await getInjected("conv-1")).filter(
        (row) => row.lastSelectedAt === 2_000,
      ),
    ).toHaveLength(1_100);
  });

  test("empty ref list is a no-op", async () => {
    await recordInjected(
      "conv-1",
      [{ slug: "topics/page-a", key: "", bytes: 100 }],
      1_000,
    );
    await touchSelected("conv-1", [], 2_000);
    expect(await stamps("conv-1")).toEqual([["topics/page-a", "", 1_000]]);
  });
});

describePg("clearConversation", () => {
  test("deletes all rows for the conversation only", async () => {
    await recordInjected(
      "conv-1",
      [{ slug: "topics/page-a", key: "", bytes: 100 }],
      1_000,
    );
    await recordInjected(
      "conv-2",
      [{ slug: "topics/page-b", key: "", bytes: 200 }],
      1_000,
    );

    await clearConversation("conv-1");

    expect(await getInjected("conv-1")).toEqual([]);
    expect(await getInjected("conv-2")).toHaveLength(1);
  });

  test("deletes the conversation's legacy card rows too, so a copy that runs after the reset re-imports nothing for it", async () => {
    const db = requireMainDb();
    await db.run(
      `INSERT INTO memory_v3_ever_injected
         (conversation_id, slug, injected_at, bytes, pruned_at)
       VALUES
         ('conv-1', 'topics/page-a', 1000, 120, NULL),
         ('conv-1', 'topics/page-b', 2000, 340, NULL),
         ('conv-2', 'topics/page-a', 3000, 100, NULL)`,
    );
    // The store's first use of this connection copies the legacy rows in.
    // The copy is async behind the main checkpoint ledger; flush it before
    // asserting the result.
    await summary("conv-1");
    await ensureMemoryV3InjectedSectionsSchema(db);
    expect(await summary("conv-1")).toEqual([
      { slug: "topics/page-a", key: "", bytes: 0, prunedAt: null },
      { slug: "topics/page-b", key: "", bytes: 0, prunedAt: null },
    ]);
    expect(await legacyCopyRecorded()).toBe(true);

    await clearConversation("conv-1");

    expect(await getInjected("conv-1")).toEqual([]);
    expect(await legacySlugs("conv-1")).toEqual([]);
    expect(await legacySlugs("conv-2")).toEqual(["topics/page-a"]);
    expect(await getInjected("conv-2")).toHaveLength(1);

    // A copy that runs again, its record lost, as a fresh connection's
    // ensure would: nothing of conv-1 is left to bring back.
    await requireMainDb().run(`DELETE FROM memory_checkpoints WHERE key = ?`, [
      SECTIONS_LEGACY_COPY_DONE_KEY,
    ]);
    await ensureMemoryV3InjectedSectionsSchema(requireMainDb());

    expect(await getInjected("conv-1")).toEqual([]);
    expect(await summary("conv-2")).toEqual([
      { slug: "topics/page-a", key: "", bytes: 0, prunedAt: null },
    ]);
    expect(await legacyCopyRecorded()).toBe(true);
  });
});

describePg("forkEverInjected", () => {
  test("copies the parent's full record, pruned state and selection stamps included", async () => {
    await recordInjected(
      "conv-parent",
      [
        { slug: "topics/page-a", key: "", bytes: 100 },
        { slug: "topics/page-a", key: "Notes", bytes: 250 },
      ],
      1_000,
    );
    await markPruned(
      "conv-parent",
      [{ slug: "topics/page-a", key: "Notes" }],
      2_000,
    );
    await touchSelected(
      "conv-parent",
      [{ slug: "topics/page-a", key: "" }],
      3_000,
    );

    await forkEverInjected("conv-parent", "conv-child");

    expect(await getInjected("conv-child")).toEqual([
      {
        slug: "topics/page-a",
        key: "",
        bytes: 100,
        injectedAt: 1_000,
        lastSelectedAt: 3_000,
        prunedAt: null,
      },
      {
        slug: "topics/page-a",
        key: "Notes",
        bytes: 250,
        injectedAt: 1_000,
        lastSelectedAt: 1_000,
        prunedAt: 2_000,
      },
    ]);
    expect(await residentBytes("conv-child")).toBe(100);
    // Parent record is untouched.
    expect(await getInjected("conv-parent")).toHaveLength(2);
  });

  test("is a no-op when the parent has no rows", async () => {
    await forkEverInjected("conv-empty", "conv-child");
    expect(await getInjected("conv-child")).toEqual([]);
  });
});

/** An inherited block with the format its row's metadata recorded. */
const current = (inner: string): InjectedBlock => ({
  inner,
  format: "current",
});
const legacy = (inner: string): InjectedBlock => ({ inner, format: "legacy" });

describePg("seedEverInjectedFromBlocks", () => {
  const leadA = `${injectedSectionHeader("topics/page-a", "")}\nLead A`;
  const notesA = `${injectedSectionHeader("topics/page-a", "Notes")}\nNotes A`;
  const blockA = `${leadA}\n\n${notesA}`;
  const designB = `${injectedSectionHeader("topics/page-b", "Design#1")}\nDesign B`;

  test("seeds a row per inherited section, stamped at the given time with no selection stamp, with the bytes of its inherited span", async () => {
    await seedEverInjectedFromBlocks(
      "conv-parent",
      "conv-child",
      [current(blockA), current(wrapMemoryBlock(designB))],
      5_000,
    );

    expect(await getInjected("conv-child")).toEqual([
      {
        slug: "topics/page-a",
        key: "",
        bytes: renderedBytes(leadA),
        injectedAt: 5_000,
        lastSelectedAt: null,
        prunedAt: null,
      },
      {
        slug: "topics/page-a",
        key: "Notes",
        bytes: renderedBytes(notesA),
        injectedAt: 5_000,
        lastSelectedAt: null,
        prunedAt: null,
      },
      {
        slug: "topics/page-b",
        key: "Design#1",
        bytes: renderedBytes(designB),
        injectedAt: 5_000,
        lastSelectedAt: null,
        prunedAt: null,
      },
    ]);
    // The child's resident accounting starts at what it inherited.
    expect(await residentBytes("conv-child")).toBe(
      renderedBytes(leadA) + renderedBytes(notesA) + renderedBytes(designB),
    );
  });

  test("a section inherited from several blocks takes its latest span; an escaped forged header seeds no phantom row", async () => {
    const notesAgain = `${injectedSectionHeader("topics/page-a", "Notes")}\nNotes A, re-injected after a prune\n\\# memory/concepts/phantom.md`;
    await seedEverInjectedFromBlocks(
      "conv-parent",
      "conv-child",
      [current(blockA), current(notesAgain)],
      5_000,
    );

    expect(await summary("conv-child")).toEqual([
      {
        slug: "topics/page-a",
        key: "",
        bytes: renderedBytes(leadA),
        prunedAt: null,
      },
      {
        slug: "topics/page-a",
        key: "Notes",
        bytes: renderedBytes(notesAgain),
        prunedAt: null,
      },
    ]);
  });

  test("seeds inherited capability chunks at zero bytes under the empty key, as the injector records them", async () => {
    const block = [
      leadA,
      "",
      "# Skills",
      "hint",
      "",
      "# Skill: meet-join",
      "Join a meeting.",
      "",
      "# CLI command: export",
      "Export a conversation.",
    ].join("\n");
    await seedEverInjectedFromBlocks(
      "conv-parent",
      "conv-child",
      [current(block)],
      5_000,
    );

    expect(await summary("conv-child")).toEqual([
      { slug: "cli-commands/export", key: "", bytes: 0, prunedAt: null },
      { slug: "skills/meet-join", key: "", bytes: 0, prunedAt: null },
      {
        slug: "topics/page-a",
        key: "",
        bytes: renderedBytes(leadA),
        prunedAt: null,
      },
    ]);
    expect(await getActiveSections("conv-child")).toEqual(
      new Map([
        ["cli-commands/export", new Set([""])],
        ["skills/meet-join", new Set([""])],
        ["topics/page-a", new Set([""])],
      ]),
    );
    expect(await residentBytes("conv-child")).toBe(renderedBytes(leadA));
  });

  test("a legacy block (a pre-stamp row's) seeds nothing; the current blocks beside it seed as usual", async () => {
    const card = [
      injectedSectionHeader("topics/page-a", ""),
      "# Page A",
      "lead prose",
      "",
      "# memory/concepts/example.md",
      "more lead prose",
      "",
      "[sections: §Notes · §Design]",
    ].join("\n");
    await seedEverInjectedFromBlocks(
      "conv-parent",
      "conv-child",
      [legacy(`preamble\n\n${card}`), current(designB)],
      5_000,
    );

    expect(await summary("conv-child")).toEqual([
      {
        slug: "topics/page-b",
        key: "Design#1",
        bytes: renderedBytes(designB),
        prunedAt: null,
      },
    ]);

    // Legacy blocks alone: a no-op.
    await seedEverInjectedFromBlocks(
      "conv-parent",
      "conv-child-legacy-only",
      [legacy(`preamble\n\n${card}`)],
      5_000,
    );
    expect(await getInjected("conv-child-legacy-only")).toEqual([]);
  });

  test("carries the parent's pruned_at tombstones for inherited sections", async () => {
    // Parent injected both sections of page-a, then pruned Notes: the
    // metadata block the child inherits still contains the Notes section,
    // so the scan seeds both, but Notes must arrive tombstoned, not active,
    // or the child's rehydration would resurrect a section the parent's live
    // view lost.
    await recordInjected(
      "conv-parent",
      [
        { slug: "topics/page-a", key: "", bytes: 100 },
        { slug: "topics/page-a", key: "Notes", bytes: 200 },
      ],
      1_000,
    );
    await markPruned(
      "conv-parent",
      [{ slug: "topics/page-a", key: "Notes" }],
      2_000,
    );

    await seedEverInjectedFromBlocks(
      "conv-parent",
      "conv-child",
      [current(blockA)],
      5_000,
    );

    expect(await summary("conv-child")).toEqual([
      {
        slug: "topics/page-a",
        key: "",
        bytes: renderedBytes(leadA),
        prunedAt: null,
      },
      {
        slug: "topics/page-a",
        key: "Notes",
        bytes: renderedBytes(notesA),
        prunedAt: 2_000,
      },
    ]);
    expect(await getActiveSections("conv-child")).toEqual(
      new Map([["topics/page-a", new Set([""])]]),
    );
    // A tombstoned seed carries its bytes but stays out of the resident sum.
    expect(await residentBytes("conv-child")).toBe(renderedBytes(leadA));

    // Re-selection clears the inherited tombstone, same as in the parent.
    await recordInjected(
      "conv-child",
      [{ slug: "topics/page-a", key: "Notes", bytes: 50 }],
      6_000,
    );
    expect(await getActiveSections("conv-child")).toEqual(
      new Map([["topics/page-a", new Set(["", "Notes"])]]),
    );
  });

  test("is a no-op for blocks with no headers and never overwrites existing rows", async () => {
    await seedEverInjectedFromBlocks(
      "conv-parent",
      "conv-child",
      [current("no headers")],
      5_000,
    );
    expect(await getInjected("conv-child")).toEqual([]);

    await recordInjected(
      "conv-child",
      [{ slug: "topics/page-a", key: "", bytes: 100 }],
      1_000,
    );
    await seedEverInjectedFromBlocks(
      "conv-parent",
      "conv-child",
      [current(blockA)],
      5_000,
    );
    expect(await summary("conv-child")).toEqual([
      { slug: "topics/page-a", key: "", bytes: 100, prunedAt: null },
      {
        slug: "topics/page-a",
        key: "Notes",
        bytes: renderedBytes(notesA),
        prunedAt: null,
      },
    ]);
  });
});

describePg("memory-side schema", () => {
  test("a store call on a fresh memory connection creates the table itself (the lazy per-connection ensure)", async () => {
    await requireMainDb().exec(
      "DROP TABLE IF EXISTS memory_v3_injected_sections",
    );

    await recordInjected(
      "conv-1",
      [{ slug: "topics/page-a", key: "", bytes: 100 }],
      1_000,
    );

    expect(await getActiveSections("conv-1")).toEqual(
      new Map([["topics/page-a", new Set([""])]]),
    );
  });

  test("the plugin-init ensure creates the table and no-ops when the memory database is unavailable", async () => {
    await requireMainDb().exec(
      "DROP TABLE IF EXISTS memory_v3_injected_sections",
    );

    await ensureMemoryV3PluginSchema();
    const row = await requireMainDb().get<{ table_name: string }>(
      `SELECT table_name FROM information_schema.tables
        WHERE table_schema = current_schema()
          AND table_name = 'memory_v3_injected_sections'`,
    );
    expect(row).not.toBeNull();

    delete process.env.VELLUM_DATABASE_URL;
    await expect(ensureMemoryV3PluginSchema()).resolves.toBeUndefined();
  });

  test("ensure is idempotent, running twice leaves a usable table", async () => {
    await ensureMemoryV3InjectedSectionsSchema(requireMainDb());
    await ensureMemoryV3InjectedSectionsSchema(requireMainDb());

    await recordInjected(
      "conv-1",
      [{ slug: "topics/page-a", key: "", bytes: 100 }],
      1_000,
    );
    expect(await getActiveSections("conv-1")).toEqual(
      new Map([["topics/page-a", new Set([""])]]),
    );
  });

  test("the lazy per-connection ensure copies the legacy card rows once, recording the copy in the checkpoint ledger, and a later ensure skips it", async () => {
    await requireMainDb().run(
      `INSERT INTO memory_v3_ever_injected
         (conversation_id, slug, injected_at, bytes, pruned_at)
       VALUES ('conv-1', 'topics/page-a', 1000, 120, NULL)`,
    );
    expect(await legacyCopyRecorded()).toBe(false);

    await summary("conv-1");
    await ensureMemoryV3InjectedSectionsSchema(requireMainDb());
    expect(await summary("conv-1")).toEqual([
      { slug: "topics/page-a", key: "", bytes: 0, prunedAt: null },
    ]);
    expect(await legacyCopyRecorded()).toBe(true);

    // The record, not the legacy rows, is what a later ensure consults.
    await recordInjected(
      "conv-1",
      [{ slug: "topics/page-a", key: "", bytes: 90 }],
      2_000,
    );
    await requireMainDb().run(`DELETE FROM memory_v3_injected_sections`);
    await ensureMemoryV3InjectedSectionsSchema(requireMainDb());
    expect(await getInjected("conv-1")).toEqual([]);
  });
});

describePg("fail-soft without a memory database", () => {
  test("reads return empty and writes no-op when the memory DB is unavailable", async () => {
    delete process.env.VELLUM_DATABASE_URL;
    await expect(
      recordInjected(
        "conv-1",
        [{ slug: "topics/page-a", key: "", bytes: 100 }],
        1_000,
      ),
    ).resolves.toBeUndefined();
    expect((await getActiveSections("conv-1")).size).toBe(0);
    expect((await getPrunedSections("conv-1")).size).toBe(0);
    expect(await getInjected("conv-1")).toEqual([]);
    expect(await residentBytes("conv-1")).toBe(0);
    await expect(
      touchSelected("conv-1", [{ slug: "topics/page-a", key: "" }], 2_000),
    ).resolves.toBeUndefined();
    await clearConversation("conv-1");
  });
});

describePg("fail-soft when the underlying statement fails", () => {
  // The memory connection is present, but the table is gone (a corrupt or
  // dropped table, I/O error, or a busy database). Every write must degrade
  // like the null-connection case — log a warning and no-op — rather than
  // throwing out of the turn.
  test("read paths return empty when the target table is missing (memory stays on, dedup off)", async () => {
    await requireMainDb().exec(
      "DROP TABLE IF EXISTS memory_v3_injected_sections",
    );

    expect((await getActiveSections("conv-1")).size).toBe(0);
    expect((await getPrunedSections("conv-1")).size).toBe(0);
    expect(await getActiveEntries("conv-1")).toEqual([]);
    expect(await getInjected("conv-1")).toEqual([]);
    expect(await residentBytes("conv-1")).toBe(0);
  });

  test("write paths no-op when the target table is missing", async () => {
    await requireMainDb().exec(
      "DROP TABLE IF EXISTS memory_v3_injected_sections",
    );

    await expect(
      recordInjected(
        "conv-1",
        [{ slug: "topics/page-a", key: "", bytes: 100 }],
        1_000,
      ),
    ).resolves.toBeUndefined();
    await expect(
      markPruned("conv-1", [{ slug: "topics/page-a", key: "" }], 2_000),
    ).resolves.toBeUndefined();
    await expect(
      touchSelected("conv-1", [{ slug: "topics/page-a", key: "" }], 2_000),
    ).resolves.toBeUndefined();
    await clearConversation("conv-1");
    await expect(
      forkEverInjected("conv-parent", "conv-child"),
    ).resolves.toBeUndefined();
    await expect(
      seedEverInjectedFromBlocks(
        "conv-parent",
        "conv-child",
        [current(injectedSectionHeader("topics/page-a", ""))],
        5_000,
      ),
    ).resolves.toBeUndefined();
  });
});
