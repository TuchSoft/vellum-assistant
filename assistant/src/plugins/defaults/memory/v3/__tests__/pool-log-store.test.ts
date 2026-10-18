/**
 * Tests for `pool-log-store.ts`, memory-v3's per-turn selector pool audit:
 *   - `buildPoolRecord` lays the pool out in cache order (core, hot, fresh,
 *     always-candidate cards, then the finder tail), tags each entry with its
 *     lane and the slug's matched section, and marks `chosen` by membership in
 *     the selection set (a finder hit on a stable-prefix page appears twice);
 *   - a turn whose selector never judged a pool (a closed-gate hard skip, an
 *     empty pool) records an empty pool with `selector_ran` false, while the
 *     disabled-selector passthrough keeps its pool;
 *   - `writePool` / `readPoolForTurn` round-trip the record, a re-observed
 *     turn replaces its row, and an absent turn reads `null`;
 *   - `writePool` writes on the connection it is handed and throws on a failed
 *     statement (the transaction and the best-effort boundary live in
 *     `shadow-plugin.ts`'s `writeTurnLog`, with the selection rows);
 *   - `readPoolForMessageIds` finds the row by its stamped message id and
 *     ignores unstamped rows;
 *   - reads degrade to `null` when the memory connection is unavailable, and
 *     an unreadable `candidates_json` reads `null`;
 *   - `ensureMemoryV3PoolsSchema` is idempotent.
 *
 * These tests run against the Postgres test database, with the store
 * resolving the memory-slot facade. Mirrors `selection-log-store.test.ts`.
 */

import { afterEach, beforeEach, expect, test } from "bun:test";

import { describePg } from "../../../../../__tests__/pg-test-db.js";
import type { AsyncDb } from "../../../../../persistence/db-facade.js";
import { requireMainDb } from "../../../../../persistence/db-facade.js";
import type { OrchestrateResult } from "../orchestrate.js";
import {
  ensureMemoryV3PoolInputsSchema,
  ensureMemoryV3PoolsSchema,
} from "../plugin-schema.js";
import type {
  PoolCandidateRecord,
  PoolLane,
  PoolRecord,
} from "../pool-log-store.js";
import { renderFinderLine } from "../pool-select.js";
import type { MemoryRoutingTurn, Section, Slug } from "../types.js";

let previousDatabaseUrl: string | undefined;
let db: AsyncDb;

async function makeDb(): Promise<void> {
  await requireMainDb().exec("DROP TABLE IF EXISTS memory_v3_pools");
  await requireMainDb().exec("DROP TABLE IF EXISTS memory_v3_pool_inputs");
  await requireMainDb().exec("DROP TABLE IF EXISTS memory_v3_pool_texts");
  await requireMainDb().exec("DROP FUNCTION IF EXISTS refuse_pool_writes()");
  await ensureMemoryV3PoolsSchema(requireMainDb());
  await ensureMemoryV3PoolInputsSchema(requireMainDb());
}

const {
  buildPoolInput,
  buildPoolRecord,
  hashPoolText,
  readPoolForMessageIds,
  readPoolForTurn,
  readPoolInputForTurn,
  readPoolText,
  writePool,
  writePoolInput,
} = await import("../pool-log-store.js");

beforeEach(async () => {
  previousDatabaseUrl = process.env.VELLUM_DATABASE_URL;
  await makeDb();
  db = requireMainDb();
});

afterEach(() => {
  if (previousDatabaseUrl === undefined) {
    delete process.env.VELLUM_DATABASE_URL;
  } else {
    process.env.VELLUM_DATABASE_URL = previousDatabaseUrl;
  }
});

function section(article: Slug, title: string, ordinal: number): Section {
  return { article, title, text: `${title} body`, ordinal };
}

/**
 * A turn whose pool spans every lane kind: a core card the dense lane ALSO hit
 * (so it appears twice), unchosen hot / fresh / always cards, a needle hit on
 * the page lead, an unchosen entity hit with a heading, and an edge hit with
 * no matched section.
 */
function orchestrated(): OrchestrateResult {
  const recent = section("core/page", "Recent", 3);
  const lead = section("topic/a", "", 0);
  const finder = [
    { slug: "topic/a", section: lead, descriptor: "", lane: "needle" as const },
    {
      slug: "core/page",
      section: recent,
      descriptor: "",
      lane: "dense" as const,
    },
    {
      slug: "topic/b",
      section: section("topic/b", "Details", 2),
      descriptor: "",
      lane: "entity" as const,
    },
    { slug: "topic/c", descriptor: "", lane: "edge" as const },
  ];
  return {
    selections: [
      { slug: "core/page", sections: [recent] },
      { slug: "topic/a", sections: [lead] },
      { slug: "topic/c", sections: [] },
    ],
    lanes: {
      core: ["core/page"],
      hot: ["hot/page"],
      fresh: ["fresh/page"],
      always: ["skills/example"],
      finder,
    },
    selectorRan: true,
    pool: {
      stable: [
        { slug: "core/page", card: "core card", lane: "core" },
        { slug: "hot/page", card: "hot card", lane: "hot" },
        { slug: "fresh/page", card: "fresh card", lane: "fresh" },
        { slug: "skills/example", card: "skill card", lane: "always" },
      ],
      finder: finder.map((line) => ({
        slug: line.slug,
        lane: line.lane,
        section: line.section,
        descriptor: line.descriptor || `${line.slug} lead`,
      })),
    },
  };
}

/** {@link orchestrated} plus the gate and keep-all facts captured beside it. */
function orchestratedWithPool(): OrchestrateResult {
  return {
    ...orchestrated(),
    keptAll: false,
    gateReason: "dense_pass",
  };
}

/**
 * A turn the injection gate hard-skipped: the selector was never consulted,
 * so there are no selections, but the result's lanes still carry the stable
 * prefix as computed.
 */
function hardSkipped(): OrchestrateResult {
  return {
    selections: [],
    lanes: {
      core: ["core/page"],
      hot: ["hot/page"],
      fresh: ["fresh/page"],
      always: [],
      finder: [],
    },
    selectorRan: false,
  };
}

/** Stamp the turn's pool row with its assistant message id, as the turn-end
 *  backfill does. */
async function stamp(
  conversationId: string,
  turn: number,
  messageId: string,
): Promise<void> {
  await requireMainDb().run(
    `UPDATE memory_v3_pools SET message_id = ?
     WHERE conversation_id = ? AND turn = ?`,
    [messageId, conversationId, turn],
  );
}

const card = (
  slug: string,
  lane: PoolLane,
  chosen: boolean,
): PoolCandidateRecord => ({
  slug,
  lane,
  section_title: null,
  section_key: null,
  chosen,
});

describePg("buildPoolRecord", () => {
  test("lays the pool out in cache order with lanes, sections, and verdicts", async () => {
    const record = buildPoolRecord(orchestrated());

    expect(record.candidates).toEqual([
      card("core/page", "core", true),
      card("hot/page", "hot", false),
      card("fresh/page", "fresh", false),
      card("skills/example", "always", false),
      {
        slug: "topic/a",
        lane: "needle",
        section_title: "",
        section_key: "",
        chosen: true,
      },
      // The dense lane also hit the core page: it is listed again as a finder
      // line carrying its matched section, and reads chosen like the card.
      {
        slug: "core/page",
        lane: "dense",
        section_title: "Recent",
        section_key: "Recent",
        chosen: true,
      },
      {
        slug: "topic/b",
        lane: "entity",
        section_title: "Details",
        section_key: "Details",
        chosen: false,
      },
      card("topic/c", "edge", true),
    ]);
    expect(record.pool_size).toBe(8);
    // Distinct pages kept (core/page counts once), not chosen entries.
    expect(record.selected_count).toBe(3);
    expect(record.selector_ran).toBe(true);
  });

  test("an empty pool records zero candidates with the selector not run", async () => {
    expect(
      buildPoolRecord({
        selections: [],
        lanes: { core: [], hot: [], fresh: [], always: [], finder: [] },
        selectorRan: false,
      }),
    ).toEqual({
      candidates: [],
      pool_size: 0,
      selected_count: 0,
      selector_ran: false,
    });
  });

  test("a closed-gate hard skip records an empty pool, not the stable prefix as rejected", async () => {
    // The selector never saw core/hot/fresh; listing them unchosen would read
    // as a verdict it never gave.
    expect(buildPoolRecord(hardSkipped())).toEqual({
      candidates: [],
      pool_size: 0,
      selected_count: 0,
      selector_ran: false,
    });
  });

  test("verdicts are per line: only the selected section's line reads chosen, and the card reads chosen when the page was kept", async () => {
    const first = section("topic/a", "One", 1);
    const second = section("topic/a", "Two", 2);
    const record = buildPoolRecord({
      selections: [{ slug: "topic/a", sections: [second] }],
      lanes: {
        core: ["topic/a"],
        hot: [],
        fresh: [],
        always: [],
        finder: [
          { slug: "topic/a", section: first, descriptor: "", lane: "needle" },
          { slug: "topic/a", section: second, descriptor: "", lane: "span" },
        ],
      },
      selectorRan: true,
      pool: {
        stable: [{ slug: "topic/a", card: "topic a card", lane: "core" }],
        finder: [
          {
            slug: "topic/a",
            section: first,
            descriptor: "",
            lane: "needle",
          },
          {
            slug: "topic/a",
            section: second,
            descriptor: "",
            lane: "span",
          },
        ],
      },
    });

    expect(
      record.candidates.map((c) => [c.lane, c.section_title, c.chosen]),
    ).toEqual([
      ["core", null, true],
      ["needle", "One", false],
      ["span", "Two", true],
    ]);
    expect(record.pool_size).toBe(3);
    expect(record.selected_count).toBe(1);
  });

  test("a pool the selector rejected wholesale keeps every candidate, unchosen", async () => {
    const record = buildPoolRecord({ ...orchestrated(), selections: [] });

    expect(record.selector_ran).toBe(true);
    expect(record.pool_size).toBe(8);
    expect(record.selected_count).toBe(0);
    expect(record.candidates.every((c) => !c.chosen)).toBe(true);
  });

  test("the disabled-selector passthrough keeps its pool with every candidate chosen", async () => {
    // `selectAllPoolCandidates` turns the whole pool into selections without
    // a selector judgment: the pool was real, so it is recorded.
    const record = buildPoolRecord({
      selections: [
        { slug: "core/page", sections: [] },
        { slug: "hot/page", sections: [] },
        { slug: "fresh/page", sections: [] },
      ],
      lanes: {
        core: ["core/page"],
        hot: ["hot/page"],
        fresh: ["fresh/page"],
        always: [],
        finder: [],
      },
      selectorRan: false,
      pool: {
        stable: [
          { slug: "core/page", card: "core card", lane: "core" },
          { slug: "hot/page", card: "hot card", lane: "hot" },
          { slug: "fresh/page", card: "fresh card", lane: "fresh" },
        ],
        finder: [],
      },
    });

    expect(record).toEqual({
      candidates: [
        card("core/page", "core", true),
        card("hot/page", "hot", true),
        card("fresh/page", "fresh", true),
      ],
      pool_size: 3,
      selected_count: 3,
      selector_ran: false,
    });
  });
});

describePg("writePool / readPoolForTurn", () => {
  test("round-trips the record for the exact (conversation, turn)", async () => {
    const record = buildPoolRecord(orchestrated());
    await writePool(db, "conv-1", 4, record);

    expect(await readPoolForTurn("conv-1", 4)).toEqual(record);
    expect(await readPoolForTurn("conv-1", 3)).toBeNull();
    expect(await readPoolForTurn("conv-2", 4)).toBeNull();
  });

  test("writes message_id NULL for the turn-end backfill to stamp", async () => {
    await writePool(db, "conv-1", 4, buildPoolRecord(orchestrated()));

    const row = await db.get(
      `SELECT message_id, pool_size, selected_count, selector_ran
       FROM memory_v3_pools
       WHERE conversation_id = 'conv-1' AND turn = 4`,
    );
    expect(row).toEqual({
      message_id: null,
      pool_size: 8,
      selected_count: 3,
      selector_ran: 1,
    });
  });

  test("a closed-gate turn persists selector_ran = 0 with an empty pool and reads back as such", async () => {
    await writePool(db, "conv-1", 4, buildPoolRecord(hardSkipped()));

    const row = await db.get(
      `SELECT pool_size, selected_count, selector_ran, candidates_json
       FROM memory_v3_pools
       WHERE conversation_id = 'conv-1' AND turn = 4`,
    );
    expect(row).toEqual({
      pool_size: 0,
      selected_count: 0,
      selector_ran: 0,
      candidates_json: "[]",
    });
    expect(await readPoolForTurn("conv-1", 4)).toEqual({
      candidates: [],
      pool_size: 0,
      selected_count: 0,
      selector_ran: false,
    });
  });

  test("a re-observed turn replaces its row", async () => {
    await writePool(db, "conv-1", 4, buildPoolRecord(orchestrated()));
    const smaller: PoolRecord = {
      candidates: [card("only/page", "core", true)],
      pool_size: 1,
      selected_count: 1,
      selector_ran: true,
    };
    await writePool(db, "conv-1", 4, smaller);

    expect(await readPoolForTurn("conv-1", 4)).toEqual(smaller);
    const count = await db.get<{ n: number }>(
      `SELECT COUNT(*) AS n FROM memory_v3_pools`,
    );
    expect(count).toEqual({ n: 1 });
  });

  test("throws on a failed statement so the caller's transaction can roll back", async () => {
    await db.exec(`
      CREATE OR REPLACE FUNCTION refuse_pool_writes() RETURNS trigger AS $$
      BEGIN
        RAISE EXCEPTION 'pool write refused';
      END;
      $$ LANGUAGE plpgsql
    `);
    await db.exec(`
      CREATE TRIGGER refuse_pool_writes BEFORE INSERT ON memory_v3_pools
      FOR EACH ROW EXECUTE FUNCTION refuse_pool_writes()
    `);

    await expect(
      writePool(db, "conv-1", 4, buildPoolRecord(orchestrated())),
    ).rejects.toThrow("pool write refused");
    expect(await readPoolForTurn("conv-1", 4)).toBeNull();
  });

  test("degrades to a null read when the memory database is unavailable", async () => {
    await writePool(db, "conv-1", 4, buildPoolRecord(orchestrated()));
    delete process.env.VELLUM_DATABASE_URL;

    expect(await readPoolForTurn("conv-1", 4)).toBeNull();
  });

  test("an unreadable candidates_json reads null instead of throwing", async () => {
    await db.run(
      `INSERT INTO memory_v3_pools
         (conversation_id, turn, message_id, created_at,
          pool_size, selected_count, candidates_json)
       VALUES ('conv-1', 4, NULL, 1, 2, 1, 'not json')`,
    );
    expect(await readPoolForTurn("conv-1", 4)).toBeNull();
  });
});

describePg("readPoolForMessageIds", () => {
  test("finds the turn's pool by its stamped message id", async () => {
    const record = buildPoolRecord(orchestrated());
    await writePool(db, "conv-1", 4, record);
    await writePool(db, "conv-1", 5, buildPoolRecord(hardSkipped()));
    await stamp("conv-1", 4, "msg-4");
    await stamp("conv-1", 5, "msg-5");

    expect(await readPoolForMessageIds(["msg-4"])).toEqual({ turn: 4, record });
    // Any of the turn's ids resolves it; a neighbouring turn never bleeds in.
    expect(await readPoolForMessageIds(["other", "msg-5"])).toEqual({
      turn: 5,
      record: buildPoolRecord(hardSkipped()),
    });
  });

  test("returns null for empty ids, an unmatched id, and an unstamped row", async () => {
    await writePool(db, "conv-1", 4, buildPoolRecord(orchestrated())); // message_id NULL

    expect(await readPoolForMessageIds([])).toBeNull();
    expect(await readPoolForMessageIds(["nope"])).toBeNull();
  });

  test("degrades to null when the memory database is unavailable", async () => {
    await writePool(db, "conv-1", 4, buildPoolRecord(orchestrated()));
    await stamp("conv-1", 4, "msg-4");
    delete process.env.VELLUM_DATABASE_URL;

    expect(await readPoolForMessageIds(["msg-4"])).toBeNull();
  });
});

describePg("ensureMemoryV3PoolsSchema", () => {
  test("is idempotent and creates both indexes", async () => {
    await expect(ensureMemoryV3PoolsSchema(db)).resolves.toBeUndefined();

    const indexes = await db.all<{ name: string }>(
      `SELECT indexname AS name FROM pg_indexes
        WHERE schemaname = current_schema() AND tablename = 'memory_v3_pools'`,
    );
    const names = new Set(indexes.map((i) => i.name));
    expect(names.has("idx_memory_v3_pools_message")).toBe(true);
    expect(names.has("idx_memory_v3_pools_conv")).toBe(true);
  });

  test("selector_ran defaults to 1 so a row written without it reads as a judged pool", async () => {
    const column = (
      await db.all<{
        name: string;
        dflt_value: string | null;
      }>(
        `SELECT column_name AS name, column_default AS dflt_value
         FROM information_schema.columns
         WHERE table_schema = current_schema()
           AND table_name = 'memory_v3_pools'`,
      )
    ).find((c) => c.name === "selector_ran");
    expect(column?.dflt_value).toBe("1");
  });
});

describePg("pool input capture", () => {
  const turn: MemoryRoutingTurn = {
    conversationId: "conv-1",
    turnNumber: 4,
    currentMessage: "what did we decide about the garden?",
    recentContext: "user: hi\nassistant: hello",
    situationalContext: "Today is 2026-01-01.",
    previousAssistantMessage: "hello",
  };

  test("buildPoolInput captures each candidate's rendered text in pool order, aligned with the pool record", async () => {
    const result = orchestratedWithPool();
    const { input, texts } = buildPoolInput(result, turn, "select wisely");
    const record = buildPoolRecord(result);

    expect(input.candidate_text_hashes).toHaveLength(record.candidates.length);
    const rendered = [
      ...result.pool!.stable.map((candidate) => candidate.card),
      ...result.pool!.finder.map((candidate) => renderFinderLine(candidate)),
    ];
    expect(input.candidate_text_hashes.map((hash) => texts.get(hash))).toEqual(
      rendered,
    );
    expect(input.candidate_text_hashes[0]).toBe(hashPoolText("core card"));
    expect(input).toMatchObject({
      situational_context: "Today is 2026-01-01.",
      recent_context: "user: hi\nassistant: hello",
      current_message: "what did we decide about the garden?",
      previous_assistant_message: "hello",
      selector_prompt_hash: hashPoolText("select wisely"),
      kept_all: false,
      gate_reason: "dense_pass",
    });
  });

  test("persists only the exact budgeted pool and context rendered to the selector", async () => {
    const selected = orchestratedWithPool();
    const result: OrchestrateResult = {
      ...selected,
      selections: [{ slug: "core/page", sections: [] }],
      pool: {
        stable: [
          { slug: "core/page", card: "retained core card", lane: "core" },
        ],
        finder: [
          {
            slug: "topic/a",
            descriptor: "retained direct hit",
            lane: "needle",
          },
        ],
      },
      selectorTurn: {
        ...turn,
        situationalContext: undefined,
        recentContext: "trimmed recent suffix",
        currentMessage: "trimmed current message",
      },
    };

    const record = buildPoolRecord(result);
    const { input, texts } = buildPoolInput(result, turn, "select wisely");

    expect(record.candidates.map((candidate) => candidate.slug)).toEqual([
      "core/page",
      "topic/a",
    ]);
    expect(record.candidates.map((candidate) => candidate.lane)).toEqual([
      "core",
      "needle",
    ]);
    expect(input).toMatchObject({
      situational_context: null,
      recent_context: "trimmed recent suffix",
      current_message: "trimmed current message",
    });
    expect(input.candidate_text_hashes.map((hash) => texts.get(hash))).toEqual([
      "retained core card",
      "(needle) topic/a \u2014 retained direct hit",
    ]);
  });

  test("persists a failed selector's exact attempted pool with stable cards chosen and finder lines unchosen", async () => {
    const result: OrchestrateResult = {
      selections: [{ slug: "core/page", sections: [] }],
      lanes: {
        core: ["core/page"],
        hot: ["hot/page"],
        fresh: [],
        always: [],
        finder: [
          {
            slug: "topic/a",
            descriptor: "direct hit",
            lane: "needle",
          },
          {
            slug: "topic/c",
            descriptor: "weak association",
            lane: "learned",
          },
        ],
      },
      selectorRan: false,
      selectorFailure: new Error("selector failed") as never,
      pool: {
        stable: [
          { slug: "core/page", card: "retained core card", lane: "core" },
        ],
        finder: [
          {
            slug: "topic/a",
            descriptor: "direct hit",
            lane: "needle",
          },
        ],
      },
      selectorTurn: {
        ...turn,
        recentContext: "attempted recent suffix",
      },
      keptAll: false,
    };

    const record = buildPoolRecord(result);
    const { input, texts } = buildPoolInput(result, turn, "select wisely");

    expect(
      record.candidates.map((candidate) => [
        candidate.slug,
        candidate.lane,
        candidate.chosen,
      ]),
    ).toEqual([
      ["core/page", "core", true],
      ["topic/a", "needle", false],
    ]);
    expect(record.selector_ran).toBe(false);
    expect(input.recent_context).toBe("attempted recent suffix");
    expect(input.candidate_text_hashes.map((hash) => texts.get(hash))).toEqual([
      "retained core card",
      "(needle) topic/a \u2014 direct hit",
    ]);
  });

  test("a turn whose selector never judged a pool captures the context and no candidate texts", async () => {
    const { input, texts } = buildPoolInput(
      hardSkipped(),
      {
        ...turn,
        situationalContext: undefined,
        previousAssistantMessage: undefined,
      },
      "select wisely",
    );

    expect(input.candidate_text_hashes).toEqual([]);
    expect(texts.size).toBe(0);
    expect(input).toMatchObject({
      situational_context: null,
      previous_assistant_message: null,
      selector_prompt_hash: null,
      gate_reason: null,
    });
  });

  test("a result without the selector's pool captures no candidate texts rather than misaligned ones", async () => {
    const { input, texts } = buildPoolInput(
      { ...orchestrated(), pool: undefined },
      turn,
      "select wisely",
    );

    expect(input.candidate_text_hashes).toEqual([]);
    expect(texts.size).toBe(0);
  });

  test("writePoolInput and readPoolInputForTurn round-trip; a re-observed turn replaces its row; texts are stored once", async () => {
    const capture = buildPoolInput(
      orchestratedWithPool(),
      turn,
      "select wisely",
    );
    await writePoolInput(db, "conv-1", 4, capture);

    expect(await readPoolInputForTurn("conv-1", 4)).toEqual(capture.input);
    expect(await readPoolText(capture.input.candidate_text_hashes[0]!)).toBe(
      "core card",
    );

    // The next turn pools the same candidates: its input row is its own, the
    // texts are shared by hash.
    await writePoolInput(
      db,
      "conv-1",
      5,
      buildPoolInput(
        orchestratedWithPool(),
        { ...turn, turnNumber: 5, currentMessage: "and the fence?" },
        "select wisely",
      ),
    );
    const textCount = async () =>
      (
        (await db.get<{ n: number }>(
          `SELECT COUNT(*) AS n FROM memory_v3_pool_texts`,
        )) as { n: number }
      ).n;
    expect(await textCount()).toBe(
      new Set(capture.input.candidate_text_hashes).size,
    );
    expect((await readPoolInputForTurn("conv-1", 5))?.current_message).toBe(
      "and the fence?",
    );

    await writePoolInput(
      db,
      "conv-1",
      4,
      buildPoolInput(
        orchestratedWithPool(),
        { ...turn, currentMessage: "again" },
        "select wisely",
      ),
    );
    expect((await readPoolInputForTurn("conv-1", 4))?.current_message).toBe(
      "again",
    );
    expect(
      (
        (await db.get<{ n: number }>(
          `SELECT COUNT(*) AS n FROM memory_v3_pool_inputs`,
        )) as { n: number }
      ).n,
    ).toBe(2);
  });

  test("an absent turn or text reads null, and reads degrade to null when the memory connection is unavailable", async () => {
    expect(await readPoolInputForTurn("conv-1", 9)).toBeNull();
    expect(await readPoolText("missing")).toBeNull();

    await writePoolInput(
      db,
      "conv-1",
      4,
      buildPoolInput(orchestratedWithPool(), turn, "select wisely"),
    );
    delete process.env.VELLUM_DATABASE_URL;
    expect(await readPoolInputForTurn("conv-1", 4)).toBeNull();
    expect(await readPoolText(hashPoolText("core card"))).toBeNull();
  });
});
