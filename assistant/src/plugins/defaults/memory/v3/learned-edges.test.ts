/**
 * Tests for the learned-edge lane (`learned-edges.ts`).
 *
 * `computeLearnedEdgeGraph` reads `memory_v3_selections` over the dedicated
 * memory connection: each test seeds the Postgres test database with
 * selection rows and asserts the NPMI association graph. Rows sharing a
 * `(conversation_id, created_at)` form one selector call.
 */

import { beforeEach, expect, test } from "bun:test";

import { describePg } from "../../../../__tests__/pg-test-db.js";
import { requireMainDb } from "../../../../persistence/db-facade.js";
import { initializeDb } from "../../../../persistence/db-init.js";
import {
  computeLearnedEdgeGraph,
  type LearnedEdgesOptions,
} from "./learned-edges.js";

const HALF_LIFE_MS = 1_000_000;
const NOW = 100_000;

await initializeDb();

let nextTurn = 0;

async function resetTables(): Promise<void> {
  await requireMainDb().run(`DELETE FROM memory_v3_selections`);
}

/** Insert one selector call: every slug shares the same (conv, created_at). */
async function seedCall(
  slugs: string[],
  createdAt = NOW,
  conv = "conv-1",
): Promise<void> {
  const db = requireMainDb();
  const turn = nextTurn++;
  for (const slug of slugs) {
    await db.run(
      `INSERT INTO memory_v3_selections (conversation_id, turn, slug, source, created_at) VALUES (?, ?, ?, ?, ?)`,
      [conv, turn, slug, "needle", createdAt],
    );
  }
}

async function graphOf(overrides: Partial<LearnedEdgesOptions> = {}) {
  return computeLearnedEdgeGraph({
    halfLifeMs: HALF_LIFE_MS,
    minCount: 2,
    npmiFloor: 0.2,
    maxPerPage: 6,
    now: NOW,
    windowMs: NOW,
    knownSlugs: new Set([
      "page-a",
      "page-b",
      "page-c",
      "page-d",
      "skills/widget",
    ]),
    ...overrides,
  });
}

const peersOf = (
  graph: Awaited<ReturnType<typeof computeLearnedEdgeGraph>>,
  slug: string,
): string[] => [...(graph.adjacency.get(slug)?.keys() ?? [])];

describePg("computeLearnedEdgeGraph", () => {
  beforeEach(async () => {
    await resetTables();
  });
  test("pages selected together (and rarely apart) form a symmetric edge", async () => {
    // a+b co-select twice; c selects alone twice (so a/b are not ubiquitous).
    await seedCall(["page-a", "page-b"], NOW, "conv-1");
    await seedCall(["page-a", "page-b"], NOW, "conv-2");
    await seedCall(["page-c"], NOW, "conv-3");
    await seedCall(["page-c"], NOW, "conv-4");

    const graph = await graphOf();
    expect(peersOf(graph, "page-a")).toEqual(["page-b"]);
    expect(peersOf(graph, "page-b")).toEqual(["page-a"]);
    expect(graph.hubs.size).toBe(0);
  });

  test("a page selected in every call forms no edges (NPMI → 0)", async () => {
    // page-a rides every call; page-b/page-c each appear half the time.
    await seedCall(["page-a", "page-b"], NOW, "conv-1");
    await seedCall(["page-a", "page-b"], NOW, "conv-2");
    await seedCall(["page-a", "page-c"], NOW, "conv-3");
    await seedCall(["page-a", "page-c"], NOW, "conv-4");

    const graph = await graphOf();
    // p(a) = 1 ⇒ p(a,b) = p(b) ⇒ npmi = 0, floored out — for every pairing.
    expect(peersOf(graph, "page-a")).toEqual([]);
    expect(peersOf(graph, "page-b")).toEqual([]);
  });

  test("a pair co-selected in every call forms no edge (NPMI is undefined)", async () => {
    // Every in-window call selects exactly {a, b}: pab = pa = pb = 1, so the
    // NPMI normalizer -log(pab) is -0 and the score is NaN. NaN must not slip
    // past the floor into the adjacency (it would also corrupt the
    // strongest-first neighbor ordering).
    await seedCall(["page-a", "page-b"], NOW, "conv-1");
    await seedCall(["page-a", "page-b"], NOW, "conv-2");
    await seedCall(["page-a", "page-b"], NOW, "conv-3");

    const graph = await graphOf();
    expect(peersOf(graph, "page-a")).toEqual([]);
    expect(peersOf(graph, "page-b")).toEqual([]);
  });

  test("pairs below the co-occurrence mass floor form no edge", async () => {
    await seedCall(["page-a", "page-b"], NOW, "conv-1"); // mass ≈ 1 < minCount 2
    await seedCall(["page-c"], NOW, "conv-2");
    await seedCall(["page-d"], NOW, "conv-3");

    const graph = await graphOf();
    expect(peersOf(graph, "page-a")).toEqual([]);
  });

  test("decay pushes old co-selections below the mass floor", async () => {
    // Two co-selections ten half-lives ago: decayed mass ≈ 0.002 < 2.
    await seedCall(["page-a", "page-b"], NOW - 10 * HALF_LIFE_MS, "conv-1");
    await seedCall(["page-a", "page-b"], NOW - 10 * HALF_LIFE_MS, "conv-2");
    await seedCall(["page-c"], NOW, "conv-3");

    const graph = await graphOf({ windowMs: 20 * HALF_LIFE_MS });
    expect(peersOf(graph, "page-a")).toEqual([]);
  });

  test("maxPerPage keeps the strongest associations first", async () => {
    // page-a co-selects with b twice and with c once alongside others, making
    // a↔b the stronger association; cap page-a to one edge.
    await seedCall(["page-a", "page-b"], NOW, "conv-1");
    await seedCall(["page-a", "page-b"], NOW, "conv-2");
    await seedCall(["page-a", "page-c", "page-d"], NOW, "conv-3");
    await seedCall(["page-a", "page-c", "page-d"], NOW, "conv-4");
    await seedCall(["page-d"], NOW, "conv-5");
    await seedCall(["page-d"], NOW, "conv-6");

    const graph = await graphOf({ maxPerPage: 1 });
    expect(peersOf(graph, "page-a")).toEqual(["page-b"]);
  });

  test("capability slugs participate like any page", async () => {
    await seedCall(["skills/widget", "page-a"], NOW, "conv-1");
    await seedCall(["skills/widget", "page-a"], NOW, "conv-2");
    await seedCall(["page-b"], NOW, "conv-3");
    await seedCall(["page-b"], NOW, "conv-4");

    const graph = await graphOf();
    expect(peersOf(graph, "skills/widget")).toEqual(["page-a"]);
    expect(peersOf(graph, "page-a")).toEqual(["skills/widget"]);
  });

  test("slugs outside knownSlugs never form edges", async () => {
    await seedCall(["page-a", "deleted-page"], NOW, "conv-1");
    await seedCall(["page-a", "deleted-page"], NOW, "conv-2");
    await seedCall(["page-b"], NOW, "conv-3");

    const graph = await graphOf();
    expect(peersOf(graph, "page-a")).toEqual([]);
    expect(graph.adjacency.has("deleted-page")).toBe(false);
  });

  test("maxPerPage = 0 disables the lane", async () => {
    await seedCall(["page-a", "page-b"], NOW, "conv-1");
    await seedCall(["page-a", "page-b"], NOW, "conv-2");

    const graph = await graphOf({ maxPerPage: 0 });
    expect(graph.adjacency.size).toBe(0);
  });

  test("rows outside the scan window are ignored", async () => {
    await seedCall(["page-a", "page-b"], NOW - 50_000, "conv-1");
    await seedCall(["page-a", "page-b"], NOW - 60_000, "conv-2");

    const graph = await graphOf({ windowMs: 10_000 });
    expect(graph.adjacency.size).toBe(0);
  });

  test("degrades to an empty graph when the memory database is unavailable", async () => {
    // Simulate unavailability by blanking the connection URL, the contract
    // computeLearnedEdgeGraph sees when the dedicated open fails.
    const url = process.env.VELLUM_DATABASE_URL;
    delete process.env.VELLUM_DATABASE_URL;
    try {
      const graph = await graphOf();
      expect(graph.adjacency.size).toBe(0);
      expect(graph.hubs.size).toBe(0);
    } finally {
      if (url !== undefined) {
        process.env.VELLUM_DATABASE_URL = url;
      }
    }
  });
});
