/**
 * Tests for the frecency hot-set lane (`hot-set.ts`) and its config schema.
 *
 * `computeHotSet` reads `memory_v3_selections` over the memory-slot facade:
 * each test seeds selection rows in the Postgres test database and asserts
 * the decayed-frequency ranking.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";

import { describePg } from "../../../../__tests__/pg-test-db.js";
import { MemoryV3ConfigSchema } from "../../../../config/schemas/memory-v3.js";
import { requireMainDb } from "../../../../persistence/db-facade.js";
import { computeHotSet, type HotSetOptions } from "./hot-set.js";
import { ensureMemoryV3SelectionsSectionKeyOnce } from "./plugin-schema.js";

const HALF_LIFE_MS = 1000;
const NOW = 100_000;

let previousDatabaseUrl: string | undefined;

beforeEach(async () => {
  previousDatabaseUrl = process.env.VELLUM_DATABASE_URL;
  const db = requireMainDb();
  await db.run(`DELETE FROM memory_v3_selections`);
  await ensureMemoryV3SelectionsSectionKeyOnce(db);
});

afterEach(() => {
  if (previousDatabaseUrl === undefined) {
    delete process.env.VELLUM_DATABASE_URL;
  } else {
    process.env.VELLUM_DATABASE_URL = previousDatabaseUrl;
  }
});

let nextTurn = 0;
/** Insert one selection row per createdAt (distinct turns keep the PK unique). */
async function seed(slug: string, createdAts: number[]): Promise<void> {
  const db = requireMainDb();
  for (const createdAt of createdAts) {
    await db.run(
      `INSERT INTO memory_v3_selections (conversation_id, turn, slug, source, created_at) VALUES (?, ?, ?, ?, ?)`,
      ["conv-1", nextTurn++, slug, "needle", createdAt],
    );
  }
}

async function hotSet(
  overrides: Partial<HotSetOptions> = {},
): Promise<Awaited<ReturnType<typeof computeHotSet>>> {
  return await computeHotSet({
    k: 10,
    halfLifeMs: HALF_LIFE_MS,
    now: NOW,
    excludeSlugs: new Set<string>(),
    ...overrides,
  });
}

describePg("computeHotSet", () => {
  test("empty table yields empty result", async () => {
    expect(await hotSet()).toEqual([]);
  });

  test("newer selections outweigh older ones at the same count", async () => {
    await seed("page-old", [NOW - 10 * HALF_LIFE_MS, NOW - 10 * HALF_LIFE_MS]);
    await seed("page-new", [NOW, NOW]);
    const result = await hotSet();
    expect(result.map((e) => e.slug)).toEqual(["page-new", "page-old"]);
    expect(result[0]!.score).toBeGreaterThan(result[1]!.score);
  });

  test("decay halves at exactly one half-life", async () => {
    await seed("page-a", [NOW]);
    await seed("page-b", [NOW - HALF_LIFE_MS]);
    const result = await hotSet();
    const bySlug = new Map(result.map((e) => [e.slug, e.score]));
    expect(bySlug.get("page-a")).toBeCloseTo(1, 10);
    expect(bySlug.get("page-b")).toBeCloseTo(0.5, 10);
  });

  test("scores sum across a slug's selections", async () => {
    await seed("page-a", [NOW, NOW - HALF_LIFE_MS]);
    expect((await hotSet())[0]!.score).toBeCloseTo(1.5, 10);
  });

  test("k cut keeps only the top-k", async () => {
    await seed("page-a", [NOW, NOW, NOW]);
    await seed("page-b", [NOW, NOW]);
    await seed("page-c", [NOW]);
    expect((await hotSet({ k: 2 })).map((e) => e.slug)).toEqual([
      "page-a",
      "page-b",
    ]);
  });

  test("excludeSlugs filters before the k cut", async () => {
    await seed("page-a", [NOW, NOW, NOW]);
    await seed("page-b", [NOW, NOW]);
    await seed("page-c", [NOW]);
    const result = await hotSet({ k: 2, excludeSlugs: new Set(["page-a"]) });
    expect(result.map((e) => e.slug)).toEqual(["page-b", "page-c"]);
  });

  test("ties break deterministically by slug ascending", async () => {
    await seed("page-b", [NOW]);
    await seed("page-a", [NOW]);
    await seed("page-c", [NOW]);
    expect((await hotSet()).map((e) => e.slug)).toEqual([
      "page-a",
      "page-b",
      "page-c",
    ]);
  });

  test("deterministic for fixed inputs", async () => {
    await seed("page-a", [NOW, NOW - 3 * HALF_LIFE_MS]);
    await seed("page-b", [NOW - HALF_LIFE_MS]);
    expect(await hotSet()).toEqual(await hotSet());
  });

  test("future-dated rows are clamped to weight 1", async () => {
    await seed("page-a", [NOW + 50 * HALF_LIFE_MS]);
    expect((await hotSet())[0]!.score).toBeCloseTo(1, 10);
  });

  test("degrades to an empty hot set when the memory database is unavailable", async () => {
    await seed("page-a", [NOW]);
    // Removing the configured URL makes the memory-slot facade resolve to
    // null, the same contract computeHotSet sees when the dedicated open
    // fails.
    delete process.env.VELLUM_DATABASE_URL;
    expect(await hotSet()).toEqual([]);
  });
});

describe("MemoryV3ConfigSchema hotSet", () => {
  test("defaults apply when omitted", () => {
    const config = MemoryV3ConfigSchema.parse({});
    expect(config.hotSet).toEqual({ k: 40, halfLifeDays: 14 });
  });

  test("explicit values parse", () => {
    const config = MemoryV3ConfigSchema.parse({
      hotSet: { k: 5, halfLifeDays: 7 },
    });
    expect(config.hotSet).toEqual({ k: 5, halfLifeDays: 7 });
  });

  test("zero k disables the lane", () => {
    const config = MemoryV3ConfigSchema.parse({ hotSet: { k: 0 } });
    expect(config.hotSet.k).toBe(0);
  });

  test("rejects negative k", () => {
    expect(() => MemoryV3ConfigSchema.parse({ hotSet: { k: -1 } })).toThrow();
  });

  test("rejects negative halfLifeDays", () => {
    expect(() =>
      MemoryV3ConfigSchema.parse({ hotSet: { halfLifeDays: -1 } }),
    ).toThrow();
  });
});
