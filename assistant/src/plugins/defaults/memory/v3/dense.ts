// ---------------------------------------------------------------------------
// Memory v3 — dense retrieval lane (section-grain)
// ---------------------------------------------------------------------------
//
// Read counterpart to `section-dense-store.ts`. Embeds the turn query and runs
// a single cosine search against the `memory_v3_sections` collection, then
// dedupes the matched section points down to the top-`k` distinct articles —
// each carrying its best-scoring section ordinal. This is the dense lane of the
// section-grain retrieval design: where the v2 dense lane matches whole pages,
// this one matches the single most relevant section of a long article and hands
// the orchestrator both the article and which section matched (so the selector
// can show the matched section as the descriptor).
//
// Degrades safely: any embedding or Qdrant failure logs a warning and returns
// `[]`. The orchestrator unions the other lanes (needle, edge) plus carry-
// forward regardless, so a dense outage narrows recall but never breaks a turn.

import type { AssistantConfig } from "../../../../config/types.js";
import { isEmbeddingDimensionAvailable } from "../../../../persistence/embeddings/embedding-backend.js";
import { embedWithBackend } from "../embeddings.js";
import { getLogger } from "../logging.js";
import { projectScopeFilter } from "../substrate/project-scope.js";
import {
  getSectionDenseClient,
  SECTION_COLLECTION,
  sectionDenseReadsHeld,
  sectionStoreOf,
  settleSectionDenseReadHold,
} from "./section-dense-store.js";
import { searchSectionsPg } from "./section-pg-store.js";
import type { Slug } from "./types.js";

const log = getLogger("memory-v3-dense-lane");

/**
 * Multiplier applied to `k` when fetching section points from Qdrant. Several
 * sections can belong to the same article, so we oversample the section hits to
 * leave room for the article-level dedupe to still yield `k` distinct articles.
 */
export const OVERSAMPLE = 6;

/** A single dense-lane hit: an article plus the section ordinal that matched. */
export interface DenseHit {
  article: Slug;
  section: number;
}

/** A dense-lane hit plus the raw cosine similarity Qdrant returned. */
export interface DenseHitScored {
  article: Slug;
  section: number;
  score: number;
}

/**
 * Run the dense lane and keep each hit's raw cosine score: embed `query`, search
 * the section collection for the top `k * OVERSAMPLE` section points, then dedupe
 * to the top-`k` distinct articles — each with its best-scoring section ordinal
 * and that section's cosine score. Section points are returned by Qdrant in
 * descending score order, so the first time an article is seen is its best
 * section; subsequent sections of the same article are ignored. A point that
 * arrives without a `score` is recorded as `0`.
 *
 * Returns `[]` on any embedding or Qdrant failure (logged at warn level), and
 * short-circuits to `[]` when the reachable backend cannot produce vectors of
 * the committed collection dimension (degraded backend or dimension mismatch) —
 * so a 3072-dim collection committed while only a 384-dim backend is reachable
 * narrows recall cleanly rather than failing the dimension assertion every turn.
 * Also `[]` while the section store awaits its chunker rebuild, or while the
 * version check that decides it has not completed (`sectionDenseReadsHeld`;
 * a held read retries that check, `settleSectionDenseReadHold`): the stored
 * points' ordinals can name the wrong section of the current index, and no
 * hit beats a stale one.
 */
export async function denseLaneScored(
  config: AssistantConfig,
  query: string,
  k: number,
  visibleProjects?: ReadonlySet<string>,
): Promise<DenseHitScored[]> {
  if (k <= 0) {
    return [];
  }
  // The chunker-version hold guards the ordinals stored in the Qdrant points.
  // The pgvector table is written through the same upsert path, so a hold is
  // equally valid there, but the check itself probes the collection: skip it
  // when the configured store does not read Qdrant.
  const store = sectionStoreOf(config);
  if (store !== "pgvector") {
    if (
      (await sectionDenseReadsHeld()) &&
      (await settleSectionDenseReadHold())
    ) {
      return [];
    }
  }

  let points: Array<{ payload?: unknown; score?: number }>;
  try {
    // Inside the try so a rejecting probe (e.g. a transient credential-store
    // error surfacing through getProviderKeyAsync) degrades to `[]` instead of
    // throwing — the orchestrator calls this lane in an unguarded Promise.all
    // that relies on the `[]` contract, so one throw would discard the sibling
    // lanes too. The check itself skips the embed on a dimension mismatch.
    if (!(await isEmbeddingDimensionAvailable(config))) {
      return [];
    }

    const { vectors } = await embedWithBackend(config, [query]);
    const vector = vectors[0];
    if (!vector || vector.length === 0) {
      return [];
    }

    if (store === "pgvector" || store === "dual") {
      // Postgres reads the same query vector; the project predicate is part of
      // the SQL, so an exclusive section outside the visible projects never
      // competes for the top-k.
      const rows = await searchSectionsPg(
        config,
        vector,
        k * OVERSAMPLE,
        visibleProjects,
      );
      return dedupeToArticles(rows, k);
    }

    const result = await getSectionDenseClient().query(SECTION_COLLECTION, {
      query: vector,
      limit: k * OVERSAMPLE,
      with_payload: true,
      // Project scope is applied INSIDE the query: an exclusive page outside
      // the turn's visible projects never competes for the top-k, so it can
      // not crowd out visible candidates before the post-filter runs.
      ...(visibleProjects
        ? { filter: projectScopeFilter(visibleProjects) }
        : {}),
    });
    points = result.points;
  } catch (err) {
    log.warn({ err }, "memory v3 dense lane failed; degrading to no hits");
    return [];
  }

  // Walk hits in score order, keeping the first (best) section per article and
  // stopping once we have `k` distinct articles.
  const seen = new Set<Slug>();
  const hits: DenseHitScored[] = [];
  for (const point of points) {
    const payload = point.payload as
      | { article?: unknown; ordinal?: unknown }
      | null
      | undefined;
    const article = payload?.article;
    const ordinal = payload?.ordinal;
    if (typeof article !== "string" || typeof ordinal !== "number") {
      continue;
    }
    if (seen.has(article)) {
      continue;
    }
    seen.add(article);
    hits.push({ article, section: ordinal, score: point.score ?? 0 });
    if (hits.length >= k) {
      break;
    }
  }

  return hits;
}

/**
 * Collapse section-grain hits to the top-`k` distinct articles, keeping each
 * article's best (highest-scoring) section. Both stores return hits in
 * descending score order, so the first hit an article appears in is its best
 * one.
 */
function dedupeToArticles(
  hits: ReadonlyArray<{ article: Slug; ordinal: number; score: number }>,
  k: number,
): DenseHitScored[] {
  const seen = new Set<Slug>();
  const out: DenseHitScored[] = [];
  for (const hit of hits) {
    if (seen.has(hit.article)) {
      continue;
    }
    seen.add(hit.article);
    out.push({ article: hit.article, section: hit.ordinal, score: hit.score });
    if (out.length >= k) {
      break;
    }
  }
  return out;
}

/**
 * Run the dense lane: embed `query`, search the section collection for the top
 * `k * OVERSAMPLE` section points, then dedupe to the top-`k` distinct articles
 * — each with its best-scoring section ordinal. Section points are returned by
 * Qdrant in descending score order, so the first time an article is seen is its
 * best section; subsequent sections of the same article are ignored.
 *
 * Returns `[]` on any embedding or Qdrant failure (logged at warn level), and
 * short-circuits to `[]` when the reachable backend cannot produce vectors of
 * the committed collection dimension (degraded backend or dimension mismatch) —
 * so a 3072-dim collection committed while only a 384-dim backend is reachable
 * narrows recall cleanly rather than failing the dimension assertion every turn.
 *
 * Thin wrapper over {@link denseLaneScored} that drops the raw cosine score for
 * callers that only need the matched article and section.
 */
export async function denseLane(
  config: AssistantConfig,
  query: string,
  k: number,
): Promise<DenseHit[]> {
  return (await denseLaneScored(config, query, k)).map(
    ({ article, section }) => ({ article, section }),
  );
}
