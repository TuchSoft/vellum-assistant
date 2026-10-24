/**
 * Postgres (`pgvector`) section-grain dense index for memory v3.
 *
 * The `pgvector` counterpart of the Qdrant `memory_v3_sections` collection:
 * one row per page section, keyed on `(article, ordinal)`, with the section's
 * embedding and the same payload fields the Qdrant point carries. This module
 * performs the reads and writes and knows nothing about
 * `memory.v3.sectionsStore`; the callers gate on the flag.
 *
 * Every write is idempotent: the primary key is `(article, ordinal)`, so
 * re-indexing a section overwrites it, and deletes are keyed the same way.
 *
 * The project predicate is applied INSIDE the search query, not after it: an
 * exclusive section outside the turn's visible projects must not compete for
 * the top-k. It is the same rule the Qdrant filter expresses
 * (`not exclusive OR projects intersects visible`), read from the single
 * definition in `substrate/project-scope.ts`.
 */

import type { AssistantConfig } from "../../../../config/types.js";
import { requireMainDb } from "../../../../persistence/db-facade.js";
import { MEMORY_SECTION_EMBEDDING_DIM } from "../../../../persistence/pg-schema/memory-sections.js";
import { getLogger } from "../logging.js";
import type { PageProjectScope } from "../substrate/project-scope.js";

const log = getLogger("memory-v3-section-pg-store");

/** Rows per multi-row INSERT. Keeps the statement well under the parameter cap. */
const UPSERT_BATCH_SIZE = 200;

/** Whether the empty-table warning has already fired in this process. */
let _emptyWarned = false;

/** A section row ready to be written. `embedding` is the raw dense vector. */
export interface PgSectionRow {
  article: string;
  ordinal: number;
  title: string;
  projects: string[];
  exclusive: boolean;
  embedding: number[];
}

/** One dense-lane hit read from the table. */
export interface PgSectionHit {
  article: string;
  ordinal: number;
  score: number;
}

/**
 * The pgvector text literal for a dense vector: `[v0,v1,...]`. Values keep
 * JavaScript's shortest round-trip representation, which is exact enough for
 * float4 storage (the column's precision is the binding constraint).
 */
export function toVectorLiteral(vector: readonly number[]): string {
  return `[${vector.join(",")}]`;
}

/**
 * The Postgres array literal for a `text[]` parameter: `{a,b}` with every
 * element double-quoted, so ids containing commas, braces or backslashes stay
 * a single element. An empty list is `{}`.
 */
export function toTextArrayLiteral(values: readonly string[]): string {
  if (values.length === 0) {
    return "{}";
  }
  const quoted = values.map(
    (value) => `"${value.replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"`,
  );
  return `{${quoted.join(",")}}`;
}

/**
 * Refuse to write vectors of the wrong dimension. The column is typed
 * `vector(1024)` from the migration, so a mismatch would fail at the driver
 * with an opaque cast error mid-batch; naming the setting here makes a
 * misconfigured embedder a readable failure at the call site instead.
 */
function assertDimension(
  config: AssistantConfig,
  vector: readonly number[],
): void {
  const expected = config.memory.qdrant.vectorSize;
  if (expected !== MEMORY_SECTION_EMBEDDING_DIM) {
    throw new Error(
      `memory.v3.sectionsStore requires memory.qdrant.vectorSize = ${MEMORY_SECTION_EMBEDDING_DIM} ` +
        `(the memory_sections column dimension); configured value is ${expected}`,
    );
  }
  if (vector.length !== MEMORY_SECTION_EMBEDDING_DIM) {
    throw new Error(
      `section embedding has ${vector.length} dimensions; memory_sections expects ${MEMORY_SECTION_EMBEDDING_DIM}`,
    );
  }
}

/**
 * Upsert section rows in multi-row INSERT statements, chunked to
 * {@link UPSERT_BATCH_SIZE} rows. Idempotent via `ON CONFLICT (article,
 * ordinal)`.
 */
export async function upsertSectionsPg(
  config: AssistantConfig,
  rows: readonly PgSectionRow[],
): Promise<void> {
  if (rows.length === 0) {
    return;
  }
  const db = requireMainDb();
  const now = Date.now();
  for (let start = 0; start < rows.length; start += UPSERT_BATCH_SIZE) {
    const chunk = rows.slice(start, start + UPSERT_BATCH_SIZE);
    const placeholders = chunk
      .map(() => "(?, ?, ?, ?::text[], ?, ?::vector, ?)")
      .join(", ");
    const params: Array<string | number | boolean> = [];
    for (const row of chunk) {
      assertDimension(config, row.embedding);
      params.push(
        row.article,
        row.ordinal,
        row.title,
        toTextArrayLiteral(row.projects),
        row.exclusive,
        toVectorLiteral(row.embedding),
        now,
      );
    }
    await db.run(
      `INSERT INTO "memory_sections"
         ("article", "ordinal", "title", "projects", "exclusive", "embedding", "updated_at")
       VALUES ${placeholders}
       ON CONFLICT ("article", "ordinal") DO UPDATE SET
         "title" = EXCLUDED."title",
         "projects" = EXCLUDED."projects",
         "exclusive" = EXCLUDED."exclusive",
         "embedding" = EXCLUDED."embedding",
         "updated_at" = EXCLUDED."updated_at"`,
      params,
    );
  }
}

/** Remove every section row belonging to an article. */
export async function deleteSectionsForArticlePg(
  article: string,
): Promise<void> {
  const db = requireMainDb();
  await db.run(`DELETE FROM "memory_sections" WHERE "article" = ?`, [article]);
}

/** Return every distinct `article` slug that has at least one section row. */
export async function listSectionArticlesPg(): Promise<string[]> {
  const db = requireMainDb();
  const rows = await db.all<{ article: string }>(
    `SELECT DISTINCT "article" FROM "memory_sections" ORDER BY "article"`,
  );
  return rows.map((row) => row.article);
}

/** Count the section rows belonging to one article. */
export async function countSectionsForArticlePg(
  article: string,
): Promise<number> {
  const db = requireMainDb();
  const row = await db.get<{ count: number | string }>(
    `SELECT count(*) AS count FROM "memory_sections" WHERE "article" = ?`,
    [article],
  );
  return Number(row?.count ?? 0);
}

/**
 * Rewrite the project scope of every existing section row for one article,
 * without touching embeddings. Idempotent: setting the same scope twice is a
 * no-op.
 */
export async function setSectionProjectScopePg(
  article: string,
  scope: PageProjectScope,
): Promise<void> {
  const db = requireMainDb();
  await db.run(
    `UPDATE "memory_sections"
        SET "projects" = ?::text[], "exclusive" = ?
      WHERE "article" = ?`,
    [toTextArrayLiteral(scope.projects), scope.exclusive, article],
  );
}

/**
 * Search the section index for the `limit` nearest sections to `vector`.
 *
 * Rows are returned in ascending cosine distance (descending score) with the
 * score converted to the cosine similarity Qdrant reports, so a caller can
 * rank and compare hits from either store without translating the scale. The
 * project predicate is part of the WHERE clause: an empty visible set therefore
 * matches only non-exclusive sections, which is the same semantics as the
 * Qdrant filter's omitted `projects` condition.
 */
export async function searchSectionsPg(
  config: AssistantConfig,
  vector: readonly number[],
  limit: number,
  visibleProjects?: ReadonlySet<string>,
): Promise<PgSectionHit[]> {
  if (limit <= 0) {
    return [];
  }
  assertDimension(config, vector);
  const db = requireMainDb();
  const literal = toVectorLiteral(vector);
  const projects = toTextArrayLiteral(
    visibleProjects ? [...visibleProjects] : [],
  );
  const rows = await db.all<{
    article: string;
    ordinal: number | string;
    score: number | string;
  }>(
    `SELECT "article",
            "ordinal",
            1 - ("embedding" <=> ?::vector) AS "score"
       FROM "memory_sections"
      WHERE "exclusive" = false OR "projects" && ?::text[]
      ORDER BY "embedding" <=> ?::vector
      LIMIT ?`,
    [literal, projects, literal, limit],
  );
  if (rows.length === 0 && !_emptyWarned) {
    // A flag pointing at an un-backfilled table is a silent-recall-loss trap:
    // the lane degrades to no hits with no other symptom. Report it once.
    _emptyWarned = true;
    void warnIfSectionsPgEmpty();
  }
  return rows.map((row) => ({
    article: row.article,
    ordinal: Number(row.ordinal),
    score: Number(row.score),
  }));
}

/**
 * Total section rows, for the backfill's and the report's sanity checks.
 */
export async function countSectionsPg(): Promise<number> {
  const db = requireMainDb();
  const row = await db.get<{ count: number | string }>(
    `SELECT count(*) AS count FROM "memory_sections"`,
  );
  return Number(row?.count ?? 0);
}

/** Log once when the store behind the flag holds no rows. */
async function warnIfSectionsPgEmpty(): Promise<void> {
  try {
    const count = await countSectionsPg();
    if (count === 0) {
      log.warn(
        "memory.v3.sectionsStore selects pgvector but memory_sections is empty; the dense lane returns no hits until the backfill runs",
      );
    }
  } catch (err) {
    log.warn({ err }, "failed to count memory_sections");
  }
}

/** @internal Test-only: reset the module-level warning latch. */
export function _resetSectionPgStoreForTests(): void {
  _emptyWarned = false;
}
