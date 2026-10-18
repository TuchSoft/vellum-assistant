/**
 * The memory-v3 plugin's own schema on the memory connection
 * (`v3/plugin-schema.ts`): `memory_v3_injected_sections` is created
 * idempotently, its `last_selected_at` column added to a table created
 * without it, and seeded once per database from the card-grain
 * `memory_v3_ever_injected`, one zero-byte lead entry per legacy row, with
 * the copy recorded in the checkpoint ledger; `deleteLegacyCardRows` clears
 * a conversation's legacy rows for the compaction reset; `memory_v3_pools`
 * is created idempotently; the selection log's `section_key` column is added
 * to the `memory_v3_selections` table migration 338 creates. Every ensure
 * takes the async facade, and the sections ensure its ledger, so these tests
 * run on the Postgres test database with the once-per-connection wrapper the
 * stores share exercised on stable facade handles.
 */

import { beforeEach, expect, setDefaultTimeout, test } from "bun:test";

setDefaultTimeout(30_000);

import { describePg } from "../../../../../__tests__/pg-test-db.js";
import type { AsyncDb } from "../../../../../persistence/db-facade.js";
import { requireMainDb } from "../../../../../persistence/db-facade.js";
import {
  deleteLegacyCardRows,
  ensureMemoryV3InjectedSectionsSchema,
  ensureMemoryV3PoolInputsSchema,
  ensureMemoryV3PoolsSchema,
  ensureMemoryV3SelectionsSectionKeyOnce,
  ensureOncePerConnection,
  SECTIONS_LEGACY_COPY_DONE_KEY,
} from "../plugin-schema.js";

interface Row {
  conversation_id: string;
  slug: string;
  section_key: string;
  injected_at: number;
  bytes: number;
  pruned_at: number | null;
}

async function rows(db: AsyncDb): Promise<Row[]> {
  return await db.all<Row>(
    `SELECT conversation_id, slug, section_key, injected_at, bytes, pruned_at
     FROM memory_v3_injected_sections ORDER BY conversation_id, slug, section_key`,
  );
}

async function legacyRows(
  db: AsyncDb,
): Promise<Array<{ conversation_id: string; slug: string }>> {
  return await db.all<{ conversation_id: string; slug: string }>(
    `SELECT conversation_id, slug FROM memory_v3_ever_injected
     ORDER BY conversation_id, slug`,
  );
}

async function objectNames(
  db: AsyncDb,
  type: "table" | "index",
): Promise<string[]> {
  if (type === "table") {
    const result = await db.all<{ name: string }>(
      `SELECT table_name AS name FROM information_schema.tables
        WHERE table_schema = current_schema()`,
    );
    return result.map((row) => row.name);
  }
  const result = await db.all<{ name: string }>(
    `SELECT indexname AS name FROM pg_indexes
      WHERE schemaname = current_schema()`,
  );
  return result.map((row) => row.name);
}

async function columnNames(db: AsyncDb, table: string): Promise<string[]> {
  const result = await db.all<{ name: string }>(
    `SELECT column_name AS name FROM information_schema.columns
      WHERE table_schema = current_schema() AND table_name = ?`,
    [table],
  );
  return result.map((column) => column.name);
}

/** A map-backed checkpoint ledger whose reads or writes can be made to
 *  fail, as a main database the process cannot reach makes the real one. */
function ledger() {
  const values = new Map<string, string>();
  const fails = { reads: false, writes: false };
  const api = {
    get: async (key: string): Promise<string | null> => {
      if (fails.reads) {
        throw new Error("no such table: memory_checkpoints");
      }
      return values.get(key) ?? null;
    },
    set: async (key: string, value: string): Promise<void> => {
      if (fails.writes) {
        throw new Error("database is locked");
      }
      values.set(key, value);
    },
  };
  return { ...api, values, fails };
}

let db: AsyncDb;

/** The superseded card-grain table exactly as migration 345 leaves it on
 *  the memory connection (frozen; nothing writes it), the copy's source. */
async function createLegacyCardsTable(raw: AsyncDb): Promise<void> {
  await raw.exec(/*sql*/ `
    CREATE TABLE IF NOT EXISTS memory_v3_ever_injected (
      conversation_id TEXT NOT NULL,
      slug TEXT NOT NULL,
      injected_at BIGINT NOT NULL,
      bytes BIGINT NOT NULL DEFAULT 0,
      pruned_at BIGINT,
      PRIMARY KEY (conversation_id, slug)
    )
  `);
}

/** The selection log table migration 338 creates, without the `section_key`
 *  column this build adds. */
async function createSelectionsTableWithoutSectionKey(
  raw: AsyncDb,
): Promise<void> {
  await raw.exec(/*sql*/ `
    CREATE TABLE memory_v3_selections (
      conversation_id TEXT NOT NULL,
      turn BIGINT NOT NULL,
      slug TEXT NOT NULL,
      source TEXT NOT NULL,
      pinned BIGINT NOT NULL DEFAULT 0,
      created_at BIGINT NOT NULL,
      message_id TEXT,
      section_ordinal BIGINT,
      section_title TEXT,
      PRIMARY KEY (conversation_id, turn, slug)
    )
  `);
}

beforeEach(async () => {
  db = requireMainDb();
  await db.exec("DROP TABLE IF EXISTS memory_v3_injected_sections");
  await db.exec("DROP TABLE IF EXISTS memory_v3_pools");
  await db.exec("DROP TABLE IF EXISTS memory_v3_pool_inputs");
  await db.exec("DROP TABLE IF EXISTS memory_v3_pool_texts");
  await db.exec("DROP TABLE IF EXISTS memory_v3_ever_injected");
  await db.exec("DROP TABLE IF EXISTS memory_v3_selections");
});

describePg("ensureMemoryV3InjectedSectionsSchema", () => {
  test("creates the table and its conversation index when no legacy table exists, recording nothing", async () => {
    const checkpoints = ledger();

    await ensureMemoryV3InjectedSectionsSchema(db, checkpoints);

    expect(await objectNames(db, "table")).toContain(
      "memory_v3_injected_sections",
    );
    expect(await objectNames(db, "index")).toContain(
      "idx_memory_v3_injected_sections_conv",
    );
    expect(await rows(db)).toEqual([]);
    expect(checkpoints.values.size).toBe(0);
  });

  test("copies every legacy card row as that page's lead entry at zero bytes, injected_at and pruned_at preserved, and records the copy", async () => {
    await createLegacyCardsTable(db);
    await db.run(/*sql*/ `
      INSERT INTO memory_v3_ever_injected
        (conversation_id, slug, injected_at, bytes, pruned_at)
      VALUES
        ('conv-1', 'topics/page-a', 1000, 120, NULL),
        ('conv-1', 'topics/page-b', 2000, 340, 3000),
        ('conv-2', 'topics/page-a', 4000, 0, NULL)
    `);
    const checkpoints = ledger();

    await ensureMemoryV3InjectedSectionsSchema(db, checkpoints);

    expect(await rows(db)).toEqual([
      {
        conversation_id: "conv-1",
        slug: "topics/page-a",
        section_key: "",
        injected_at: 1000,
        bytes: 0,
        pruned_at: null,
      },
      {
        conversation_id: "conv-1",
        slug: "topics/page-b",
        section_key: "",
        injected_at: 2000,
        bytes: 0,
        pruned_at: 3000,
      },
      {
        conversation_id: "conv-2",
        slug: "topics/page-a",
        section_key: "",
        injected_at: 4000,
        bytes: 0,
        pruned_at: null,
      },
    ]);
    expect(checkpoints.values.get(SECTIONS_LEGACY_COPY_DONE_KEY)).toBe("1");
    // The legacy table is left in place, its rows untouched.
    expect(await legacyRows(db)).toHaveLength(3);
  });

  test("copies once per database: a second connection's ensure finds the copy on record and re-imports nothing", async () => {
    const checkpoints = ledger();
    const first = requireMainDb();
    await createLegacyCardsTable(first);
    await first.run(/*sql*/ `
      INSERT INTO memory_v3_ever_injected
        (conversation_id, slug, injected_at, bytes, pruned_at)
      VALUES
        ('conv-1', 'topics/page-a', 1000, 120, NULL),
        ('conv-2', 'topics/page-a', 2000, 120, NULL)
    `);
    await ensureMemoryV3InjectedSectionsSchema(first, checkpoints);
    expect((await rows(first)).map((row) => row.conversation_id)).toEqual([
      "conv-1",
      "conv-2",
    ]);
    // Compaction cleared conv-1's record. Its legacy rows stay here on
    // purpose: the record alone must keep the copy from bringing them back.
    await first.run(/*sql*/ `
      DELETE FROM memory_v3_injected_sections WHERE conversation_id = 'conv-1'
    `);

    const second = requireMainDb();
    await ensureMemoryV3InjectedSectionsSchema(second, checkpoints);

    expect((await rows(second)).map((row) => row.conversation_id)).toEqual([
      "conv-2",
    ]);
  });

  test("an unreadable ledger skips the copy rather than repeating it; a later ensure copies once the ledger reads", async () => {
    await createLegacyCardsTable(db);
    await db.run(/*sql*/ `
      INSERT INTO memory_v3_ever_injected
        (conversation_id, slug, injected_at, bytes, pruned_at)
      VALUES ('conv-1', 'topics/page-a', 1000, 120, NULL)
    `);
    const checkpoints = ledger();
    checkpoints.fails.reads = true;

    await expect(
      ensureMemoryV3InjectedSectionsSchema(db, checkpoints),
    ).resolves.toBeUndefined();

    // The table is usable; the copy waits.
    expect(await objectNames(db, "table")).toContain(
      "memory_v3_injected_sections",
    );
    expect(await rows(db)).toEqual([]);
    expect(checkpoints.values.size).toBe(0);

    checkpoints.fails.reads = false;
    await ensureMemoryV3InjectedSectionsSchema(db, checkpoints);

    expect((await rows(db)).map((row) => row.slug)).toEqual(["topics/page-a"]);
    expect(checkpoints.values.get(SECTIONS_LEGACY_COPY_DONE_KEY)).toBe("1");
  });

  test("a copy whose record cannot be written stays in place and is repeated until the record lands, neither duplicating rows nor overwriting entries refreshed since", async () => {
    await createLegacyCardsTable(db);
    await db.run(/*sql*/ `
      INSERT INTO memory_v3_ever_injected
        (conversation_id, slug, injected_at, bytes, pruned_at)
      VALUES ('conv-1', 'topics/page-a', 1000, 120, 5000)
    `);
    const checkpoints = ledger();
    checkpoints.fails.writes = true;

    await expect(
      ensureMemoryV3InjectedSectionsSchema(db, checkpoints),
    ).resolves.toBeUndefined();
    expect((await rows(db)).map((row) => row.slug)).toEqual(["topics/page-a"]);
    expect(checkpoints.values.size).toBe(0);
    // The section store re-injects the lead after the copy: pruned_at clears.
    await db.run(/*sql*/ `
      UPDATE memory_v3_injected_sections
      SET injected_at = 9000, bytes = 150, pruned_at = NULL
      WHERE conversation_id = 'conv-1' AND slug = 'topics/page-a'
    `);

    checkpoints.fails.writes = false;
    await ensureMemoryV3InjectedSectionsSchema(db, checkpoints);

    expect(await rows(db)).toEqual([
      {
        conversation_id: "conv-1",
        slug: "topics/page-a",
        section_key: "",
        injected_at: 9000,
        bytes: 150,
        pruned_at: null,
      },
    ]);
    expect(checkpoints.values.get(SECTIONS_LEGACY_COPY_DONE_KEY)).toBe("1");
  });

  test("creates a fresh table with last_selected_at, and adds it to a table created without it, keeping its rows", async () => {
    await ensureMemoryV3InjectedSectionsSchema(db, ledger());
    expect(await columnNames(db, "memory_v3_injected_sections")).toContain(
      "last_selected_at",
    );

    // A table an earlier build created, carrying a row.
    const older = requireMainDb();
    await older.exec("DROP TABLE IF EXISTS memory_v3_injected_sections");
    await older.exec(/*sql*/ `
      CREATE TABLE memory_v3_injected_sections (
        conversation_id TEXT NOT NULL,
        slug TEXT NOT NULL,
        section_key TEXT NOT NULL,
        injected_at BIGINT NOT NULL,
        bytes BIGINT NOT NULL DEFAULT 0,
        pruned_at BIGINT,
        PRIMARY KEY (conversation_id, slug, section_key)
      )
    `);
    await older.run(/*sql*/ `
      INSERT INTO memory_v3_injected_sections
        (conversation_id, slug, section_key, injected_at, bytes, pruned_at)
      VALUES ('conv-1', 'topics/page-a', 'Notes', 1000, 120, NULL)
    `);

    await ensureMemoryV3InjectedSectionsSchema(older, ledger());

    expect(await columnNames(older, "memory_v3_injected_sections")).toContain(
      "last_selected_at",
    );
    expect(
      await older.all(
        `SELECT slug, section_key, bytes, last_selected_at
           FROM memory_v3_injected_sections`,
      ),
    ).toEqual([
      {
        slug: "topics/page-a",
        section_key: "Notes",
        bytes: 120,
        last_selected_at: null,
      },
    ]);
    // A second ensure adds nothing.
    const columns = await columnNames(older, "memory_v3_injected_sections");
    await ensureMemoryV3InjectedSectionsSchema(older, ledger());
    expect(await columnNames(older, "memory_v3_injected_sections")).toEqual(
      columns,
    );
  });

  test("a table carrying an extra nullable column is left as is and still takes the copy", async () => {
    await db.exec(/*sql*/ `
      CREATE TABLE memory_v3_injected_sections (
        conversation_id TEXT NOT NULL,
        slug TEXT NOT NULL,
        section_key TEXT NOT NULL,
        injected_at BIGINT NOT NULL,
        bytes BIGINT NOT NULL DEFAULT 0,
        pruned_at BIGINT,
        frozen_card_bytes BIGINT,
        PRIMARY KEY (conversation_id, slug, section_key)
      )
    `);
    await createLegacyCardsTable(db);
    await db.run(/*sql*/ `
      INSERT INTO memory_v3_ever_injected
        (conversation_id, slug, injected_at, bytes, pruned_at)
      VALUES ('conv-1', 'topics/page-a', 1000, 120, NULL)
    `);

    await ensureMemoryV3InjectedSectionsSchema(db, ledger());

    expect((await rows(db)).map((row) => [row.slug, row.bytes])).toEqual([
      ["topics/page-a", 0],
    ]);
  });

  test("a legacy table that appears after the first ensure is copied by the next one", async () => {
    const checkpoints = ledger();
    await ensureMemoryV3InjectedSectionsSchema(db, checkpoints);
    expect(await rows(db)).toEqual([]);
    expect(checkpoints.values.size).toBe(0);
    await createLegacyCardsTable(db);
    await db.run(/*sql*/ `
      INSERT INTO memory_v3_ever_injected
        (conversation_id, slug, injected_at, bytes, pruned_at)
      VALUES ('conv-1', 'topics/page-a', 1000, 120, NULL)
    `);

    await ensureMemoryV3InjectedSectionsSchema(db, checkpoints);

    expect((await rows(db)).map((row) => [row.slug, row.bytes])).toEqual([
      ["topics/page-a", 0],
    ]);
    expect(checkpoints.values.get(SECTIONS_LEGACY_COPY_DONE_KEY)).toBe("1");
  });
});

describePg("deleteLegacyCardRows", () => {
  test("deletes only the conversation's legacy rows, and no-ops without the table", async () => {
    await expect(deleteLegacyCardRows(db, "conv-1")).resolves.toBeUndefined();

    await createLegacyCardsTable(db);
    await db.run(/*sql*/ `
      INSERT INTO memory_v3_ever_injected
        (conversation_id, slug, injected_at, bytes, pruned_at)
      VALUES
        ('conv-1', 'topics/page-a', 1000, 120, NULL),
        ('conv-1', 'topics/page-b', 2000, 340, 3000),
        ('conv-2', 'topics/page-a', 4000, 0, NULL)
    `);

    await deleteLegacyCardRows(db, "conv-1");

    expect(await legacyRows(db)).toEqual([
      { conversation_id: "conv-2", slug: "topics/page-a" },
    ]);
  });

  test("keeps a compacted conversation's leads out of a copy that runs after the reset", async () => {
    await createLegacyCardsTable(db);
    await db.run(/*sql*/ `
      INSERT INTO memory_v3_ever_injected
        (conversation_id, slug, injected_at, bytes, pruned_at)
      VALUES
        ('conv-1', 'topics/page-a', 1000, 120, NULL),
        ('conv-2', 'topics/page-a', 2000, 120, NULL)
    `);
    await ensureMemoryV3InjectedSectionsSchema(db, ledger());
    // The compaction reset: the section record and the legacy rows go
    // together.
    await db.run(/*sql*/ `
      DELETE FROM memory_v3_injected_sections WHERE conversation_id = 'conv-1'
    `);
    await deleteLegacyCardRows(db, "conv-1");

    // A copy with no record of the first (a fresh ledger) finds nothing of
    // conv-1 to bring back.
    await ensureMemoryV3InjectedSectionsSchema(db, ledger());

    expect((await rows(db)).map((row) => row.conversation_id)).toEqual([
      "conv-2",
    ]);
  });
});

describePg("ensureMemoryV3PoolsSchema", () => {
  test("creates the table and its indexes, idempotently", async () => {
    await ensureMemoryV3PoolsSchema(db);
    await ensureMemoryV3PoolsSchema(db);

    expect(await objectNames(db, "table")).toContain("memory_v3_pools");
    expect(await objectNames(db, "index")).toEqual(
      expect.arrayContaining([
        "idx_memory_v3_pools_message",
        "idx_memory_v3_pools_conv",
      ]),
    );
  });
});

describePg("ensureMemoryV3PoolInputsSchema", () => {
  test("creates the input and text tables, idempotently", async () => {
    await ensureMemoryV3PoolInputsSchema(db);
    await ensureMemoryV3PoolInputsSchema(db);

    expect(await objectNames(db, "table")).toEqual(
      expect.arrayContaining(["memory_v3_pool_inputs", "memory_v3_pool_texts"]),
    );
  });
});

describePg("ensureMemoryV3SelectionsSectionKeyOnce", () => {
  test("adds section_key to the table migration 338 creates, keeping its rows", async () => {
    await createSelectionsTableWithoutSectionKey(db);
    await db.run(/*sql*/ `
      INSERT INTO memory_v3_selections
        (conversation_id, turn, slug, source, created_at, section_ordinal,
         section_title)
      VALUES ('conv-1', 0, 'topics/page-a', 'needle', 1000, 2, 'Notes')
    `);

    await ensureMemoryV3SelectionsSectionKeyOnce(db);

    expect(await columnNames(db, "memory_v3_selections")).toContain(
      "section_key",
    );
    expect(
      await db.all(
        `SELECT slug, section_title, section_key FROM memory_v3_selections`,
      ),
    ).toEqual([
      { slug: "topics/page-a", section_title: "Notes", section_key: null },
    ]);
  });

  test("is a no-op on a table that already has the column (another process's connection to the same database)", async () => {
    await createSelectionsTableWithoutSectionKey(db);
    const first = requireMainDb();
    const second = requireMainDb();
    await ensureMemoryV3SelectionsSectionKeyOnce(first);
    const columns = await columnNames(first, "memory_v3_selections");

    await ensureMemoryV3SelectionsSectionKeyOnce(second);

    expect(await columnNames(second, "memory_v3_selections")).toEqual(columns);
    expect(columns.filter((name) => name === "section_key")).toHaveLength(1);
  });

  test("fails open on a connection without the table and retries once the table is there", async () => {
    await expect(
      ensureMemoryV3SelectionsSectionKeyOnce(db),
    ).resolves.toBeUndefined();
    expect(await objectNames(db, "table")).not.toContain(
      "memory_v3_selections",
    );

    await createSelectionsTableWithoutSectionKey(db);
    await ensureMemoryV3SelectionsSectionKeyOnce(db);

    expect(await columnNames(db, "memory_v3_selections")).toContain(
      "section_key",
    );
  });
});

describePg("ensureOncePerConnection", () => {
  test("runs the ensure once per connection, again for a new connection, and retries a connection whose ensure failed", async () => {
    const runs: unknown[] = [];
    let failing = true;
    const ensureOnce = ensureOncePerConnection((raw) => {
      runs.push(raw);
      if (failing) {
        throw new Error("no such table");
      }
    }, "degraded");

    const first = requireMainDb();
    await ensureOnce(first);
    await ensureOnce(first);
    expect(runs).toHaveLength(2);

    failing = false;
    await ensureOnce(first);
    await ensureOnce(first);
    expect(runs).toHaveLength(3);

    const reopened = requireMainDb();
    await ensureOnce(reopened);
    await ensureOnce(reopened);
    expect(runs).toHaveLength(4);
  });
});
