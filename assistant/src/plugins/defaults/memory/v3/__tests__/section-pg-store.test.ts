/**
 * DB-backed tests for the pgvector section store (`memory_sections`).
 *
 * Gated on `VELLUM_PG_TEST_URL` with the `vector` extension installed (the
 * same image the deployment uses). The store's writes and reads are exercised
 * against a real table: upsert idempotence, cosine ordering, the project-scope
 * predicate inside the query, and the delete/list/scope helpers.
 */
import { beforeAll, expect, test } from "bun:test";

import { describePg } from "../../../../../__tests__/pg-test-db.js";
import type { AssistantConfig } from "../../../../../config/types.js";
import { requireMainDb } from "../../../../../persistence/db-facade.js";
import { PG_STEPS } from "../../../../../persistence/pg-migrations/pg-steps.js";
import {
  countSectionsForArticlePg,
  deleteSectionsForArticlePg,
  listSectionArticlesPg,
  type PgSectionRow,
  searchSectionsPg,
  setSectionProjectScopePg,
  upsertSectionsPg,
} from "../section-pg-store.js";

const DIM = 1024;

/** A unit vector with `1` at `axis` (so cosine similarity is 0 across axes). */
function axisVector(axis: number): number[] {
  const vector = new Array<number>(DIM).fill(0);
  vector[axis] = 1;
  return vector;
}

const CONFIG = {
  memory: {
    qdrant: { vectorSize: DIM, onDisk: false },
    v3: { sectionsStore: "pgvector" },
  },
} as unknown as AssistantConfig;

function row(
  article: string,
  ordinal: number,
  axis: number,
  overrides: Partial<PgSectionRow> = {},
): PgSectionRow {
  return {
    article,
    ordinal,
    title: `${article} section ${ordinal}`,
    projects: [],
    exclusive: false,
    embedding: axisVector(axis),
    ...overrides,
  };
}

describePg("memory_sections (pgvector store)", () => {
  let available = false;

  beforeAll(async () => {
    const step = PG_STEPS.find((s) => s.name === "0006_memory_sections");
    const db = requireMainDb();
    const ext = await db.get<{ present: boolean }>(
      `SELECT EXISTS (
         SELECT 1 FROM pg_extension WHERE extname = 'vector'
       ) AS present`,
    );
    available = ext?.present === true;
    if (available && step) {
      await db.exec(`DROP TABLE IF EXISTS memory_sections`);
      await step.up(db);
    }
  }, 180_000);

  test("upsert is keyed on (article, ordinal) and idempotent", async () => {
    if (!available) {
      return;
    }
    await upsertSectionsPg(CONFIG, [row("people/alice", 0, 0)]);
    await upsertSectionsPg(CONFIG, [
      row("people/alice", 0, 0, { title: "rewritten" }),
    ]);
    const db = requireMainDb();
    const rows = await db.all<{ title: string }>(
      `SELECT title FROM memory_sections WHERE article = ? AND ordinal = ?`,
      ["people/alice", 0],
    );
    expect(rows.map((r) => r.title)).toEqual(["rewritten"]);
    expect(await countSectionsForArticlePg("people/alice")).toBe(1);
  }, 60_000);

  test("search returns hits in cosine order with similarity scores", async () => {
    if (!available) {
      return;
    }
    const db = requireMainDb();
    await db.run(`DELETE FROM memory_sections`);
    await upsertSectionsPg(CONFIG, [
      row("a/far", 0, 5),
      row("a/close", 0, 0),
      row("a/middle", 0, 1),
    ]);

    // Query on axis 0: exact match (1.0), orthogonal (0.0), orthogonal (0.0).
    const hits = await searchSectionsPg(CONFIG, axisVector(0), 3);
    expect(hits[0]?.article).toBe("a/close");
    expect(hits[0]?.score).toBeCloseTo(1, 5);
    expect(hits).toHaveLength(3);
  }, 60_000);

  test("the project predicate applies inside the query", async () => {
    if (!available) {
      return;
    }
    const db = requireMainDb();
    await db.run(`DELETE FROM memory_sections`);
    await upsertSectionsPg(CONFIG, [
      row("global", 0, 0),
      row("visible-exclusive", 0, 1, {
        projects: ["p-visible"],
        exclusive: true,
      }),
      row("hidden-exclusive", 0, 2, {
        projects: ["p-hidden"],
        exclusive: true,
      }),
      row("other-project-non-exclusive", 0, 3, { projects: ["p-hidden"] }),
    ]);

    const visible = new Set(["p-visible"]);
    const hits = await searchSectionsPg(CONFIG, axisVector(0), 10, visible);
    const articles = hits.map((hit) => hit.article).sort();
    expect(articles).toEqual([
      "global",
      "other-project-non-exclusive",
      "visible-exclusive",
    ]);

    // No visible projects: only non-exclusive rows, same as the Qdrant filter
    // that omits the `projects` condition.
    const none = await searchSectionsPg(CONFIG, axisVector(0), 10, new Set());
    expect(none.map((hit) => hit.article).sort()).toEqual([
      "global",
      "other-project-non-exclusive",
    ]);
  }, 60_000);

  test("delete, list and scope rewrite touch only their article", async () => {
    if (!available) {
      return;
    }
    const db = requireMainDb();
    await db.run(`DELETE FROM memory_sections`);
    await upsertSectionsPg(CONFIG, [
      row("people/alice", 0, 0),
      row("people/alice", 1, 1),
      row("people/bob", 0, 2),
    ]);

    await setSectionProjectScopePg("people/alice", {
      projects: ["p1"],
      exclusive: true,
    });
    const scoped = await db.all<{ projects: string[]; exclusive: boolean }>(
      `SELECT projects, exclusive FROM memory_sections WHERE article = ?`,
      ["people/alice"],
    );
    expect(scoped).toHaveLength(2);
    for (const section of scoped) {
      expect(section.projects).toEqual(["p1"]);
      expect(section.exclusive).toBe(true);
    }

    expect((await listSectionArticlesPg()).sort()).toEqual([
      "people/alice",
      "people/bob",
    ]);

    await deleteSectionsForArticlePg("people/alice");
    expect(await listSectionArticlesPg()).toEqual(["people/bob"]);
  }, 60_000);

  test("a vector of the wrong dimension is refused with a readable error", async () => {
    if (!available) {
      return;
    }
    await expect(
      upsertSectionsPg(CONFIG, [
        row("people/short", 0, 0, { embedding: [1, 0] }),
      ]),
    ).rejects.toThrow(/dimensions/);
  }, 60_000);
});
