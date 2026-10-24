/**
 * One-time backfill of `memory_sections` from the existing section corpus.
 *
 * Source of truth for the SET of sections is the Qdrant collection's payload
 * (`article`, `ordinal`, `title`, `projects`, `exclusive`), and the VECTOR of
 * each section comes from the `memory_embeddings` cache (rows tagged
 * `v3_section`, keyed `article#ordinal`). Nothing is re-embedded: the whole
 * point of the cache is that the vectors already exist, so a backfill costs
 * one scroll and a few batched INSERTs.
 *
 * Resumable: a durable checkpoint holds the last article processed, so an
 * interrupted pass continues where it stopped. Every write is an upsert keyed
 * on `(article, ordinal)`, so re-running the pass (or resuming it) never
 * duplicates a row.
 *
 * A section whose vector is missing from the cache is SKIPPED and counted, not
 * embedded: the caller decides whether to force a rebuild (the maintain pass
 * re-embeds and will then populate this store through the normal write path).
 */

import type { AssistantConfig } from "../../../../config/types.js";
import {
  deleteMemoryCheckpoint,
  getMemoryCheckpoint,
  setMemoryCheckpoint,
} from "../../../../persistence/checkpoints.js";
import type { AsyncDb } from "../../../../persistence/db-facade.js";
import { getMemoryBackendStatus } from "../../../../persistence/embeddings/embedding-backend.js";
import { blobToVector } from "../../../../persistence/job-utils.js";
import { getLogger } from "../logging.js";
import { memoryDbOrNull } from "../memory-db.js";
import {
  getSectionDenseClient,
  SECTION_COLLECTION,
} from "./section-dense-store.js";
import {
  type PgSectionRow,
  toTextArrayLiteral,
  upsertSectionsPg,
} from "./section-pg-store.js";

const log = getLogger("memory-v3-section-pg-backfill");

/** Durable checkpoint key holding the last article the backfill completed. */
export const SECTIONS_PG_BACKFILL_CURSOR_KEY =
  "memory_v3:sections_pg_backfill_cursor";

/** Sections per upsert statement batch. */
const DEFAULT_BATCH_SIZE = 200;

/** Qdrant scroll page size while collecting the section payloads. */
const SCROLL_BATCH_SIZE = 256;

/** One section's payload as the Qdrant point carries it. */
interface SectionPoint {
  article: string;
  ordinal: number;
  title: string;
  projects: string[];
  exclusive: boolean;
}

/** Outcome of {@link backfillSectionsPg}. */
export interface SectionPgBackfillResult {
  /** Articles whose sections were written this pass. */
  articles: number;
  /** Section rows upserted. */
  sections: number;
  /** Sections whose vector is absent from the embedding cache. */
  skipped: number;
  /** Articles whose write threw (logged, non-fatal). */
  failures: number;
  /** Article the pass resumed from, when a checkpoint was present. */
  resumedFrom: string | null;
}

/** Read every section point payload from the Qdrant collection. */
async function readSectionPoints(): Promise<SectionPoint[]> {
  const client = getSectionDenseClient();
  const points: SectionPoint[] = [];
  let offset: string | number | undefined;
  for (let i = 0; i < 10_000; i++) {
    const result = await client.scroll(SECTION_COLLECTION, {
      limit: SCROLL_BATCH_SIZE,
      with_payload: true,
      with_vector: false,
      ...(offset !== undefined ? { offset } : {}),
    });
    for (const point of result.points) {
      const payload = point.payload as
        | {
            article?: unknown;
            ordinal?: unknown;
            title?: unknown;
            projects?: unknown;
            exclusive?: unknown;
          }
        | null
        | undefined;
      const article = payload?.article;
      const ordinal = payload?.ordinal;
      if (typeof article !== "string" || typeof ordinal !== "number") {
        continue;
      }
      points.push({
        article,
        ordinal,
        title: typeof payload?.title === "string" ? payload.title : "",
        projects: Array.isArray(payload?.projects)
          ? payload.projects.filter(
              (value): value is string => typeof value === "string",
            )
          : [],
        exclusive: payload?.exclusive === true,
      });
    }
    const next = result.next_page_offset;
    if (next == null) {
      break;
    }
    offset = typeof next === "string" ? next : (next as number);
  }
  return points;
}

/**
 * Load the cached dense vectors for a set of `article#ordinal` ids.
 *
 * A section can have cache rows from more than one backend (a provider or
 * model change leaves the old rows in place), so the rows are ordered newest
 * first and the first one per id wins, preferring the currently selected
 * backend's `provider`/`model` when it is present.
 */
async function readCachedVectors(
  db: AsyncDb,
  ids: readonly string[],
  preferred: { provider: string | null; model: string | null },
): Promise<Map<string, number[]>> {
  const vectors = new Map<string, number[]>();
  if (ids.length === 0) {
    return vectors;
  }
  const rows = await db.all<{
    targetId: string;
    provider: string;
    model: string;
    vectorBlob: Buffer | Uint8Array | null;
    vectorJson: string | null;
  }>(
    `SELECT "target_id" AS "targetId",
            "provider",
            "model",
            "vector_blob" AS "vectorBlob",
            "vector_json" AS "vectorJson"
       FROM "memory_embeddings"
      WHERE "target_type" = 'v3_section'
        AND "target_id" = ANY(?::text[])
      ORDER BY "updated_at" DESC`,
    [toTextArrayLiteral(ids)],
  );
  const newest = new Map<string, number[]>();
  const preferredRows = new Map<string, number[]>();
  for (const row of rows) {
    const isPreferred =
      preferred.provider !== null &&
      preferred.model !== null &&
      row.provider === preferred.provider &&
      row.model === preferred.model;
    if (
      !newest.has(row.targetId) ||
      (isPreferred && !preferredRows.has(row.targetId))
    ) {
      const vector = decodeVector(row);
      if (!vector) {
        continue;
      }
      if (!newest.has(row.targetId)) {
        newest.set(row.targetId, vector);
      }
      if (isPreferred) {
        preferredRows.set(row.targetId, vector);
      }
    }
  }
  // The preferred backend wins over a newer row from another backend only when
  // both exist; otherwise the newest row is already in `newest`.
  for (const [id, vector] of preferredRows) {
    newest.set(id, vector);
  }
  return newest;
}

/** Decode one cache row's vector, tolerating a blob or a JSON payload. */
function decodeVector(row: {
  vectorBlob: Buffer | Uint8Array | null;
  vectorJson: string | null;
}): number[] | null {
  if (row.vectorBlob) {
    return blobToVector(row.vectorBlob);
  }
  if (row.vectorJson) {
    try {
      const parsed = JSON.parse(row.vectorJson) as unknown;
      if (Array.isArray(parsed) && parsed.every((v) => typeof v === "number")) {
        return parsed as number[];
      }
    } catch {
      return null;
    }
  }
  return null;
}

/**
 * Backfill `memory_sections` from the Qdrant payloads plus the cached vectors.
 *
 * `batchSize` bounds the sections per INSERT statement. `restart` ignores (and
 * clears) the resume checkpoint and starts from the first article.
 */
export async function backfillSectionsPg(
  config: AssistantConfig,
  options: { batchSize?: number; restart?: boolean } = {},
): Promise<SectionPgBackfillResult> {
  const batchSize = Math.max(1, options.batchSize ?? DEFAULT_BATCH_SIZE);
  const db = memoryDbOrNull("memory-v3 sections pg backfill");
  if (!db) {
    throw new Error(
      "memory database unavailable; cannot backfill memory_sections",
    );
  }

  const cursor = options.restart
    ? null
    : await getMemoryCheckpoint(SECTIONS_PG_BACKFILL_CURSOR_KEY);
  if (options.restart) {
    await deleteMemoryCheckpoint(SECTIONS_PG_BACKFILL_CURSOR_KEY);
  }

  const points = await readSectionPoints();
  const byArticle = new Map<string, SectionPoint[]>();
  for (const point of points) {
    const bucket = byArticle.get(point.article);
    if (bucket) {
      bucket.push(point);
    } else {
      byArticle.set(point.article, [point]);
    }
  }

  const articles = [...byArticle.keys()].sort();
  // The backfill never embeds, so a degraded or unreachable embedder must not
  // block it: the preferred identity only decides which cached row wins when a
  // section has rows from more than one backend.
  let preferred: { provider: string | null; model: string | null } = {
    provider: null,
    model: null,
  };
  try {
    const status = await getMemoryBackendStatus(config);
    preferred = {
      provider: status.provider ?? null,
      model: status.model ?? null,
    };
  } catch (err) {
    log.warn(
      { err },
      "memory-v3 sections pg backfill: embedding backend status unavailable; using the newest cached vector per section",
    );
  }

  const result: SectionPgBackfillResult = {
    articles: 0,
    sections: 0,
    skipped: 0,
    failures: 0,
    resumedFrom: cursor,
  };

  let pending: PgSectionRow[] = [];
  const flush = async (): Promise<void> => {
    if (pending.length === 0) {
      return;
    }
    const batch = pending;
    pending = [];
    await upsertSectionsPg(config, batch);
    result.sections += batch.length;
  };

  for (const article of articles) {
    if (cursor !== null && article <= cursor) {
      continue;
    }
    try {
      const sections = byArticle.get(article) ?? [];
      const ids = sections.map(
        (section) => `${section.article}#${section.ordinal}`,
      );
      const vectors = await readCachedVectors(db, ids, preferred);
      for (const section of sections) {
        const vector = vectors.get(`${section.article}#${section.ordinal}`);
        if (!vector) {
          result.skipped += 1;
          continue;
        }
        pending.push({
          article: section.article,
          ordinal: section.ordinal,
          title: section.title,
          projects: section.projects,
          exclusive: section.exclusive,
          embedding: vector,
        });
        if (pending.length >= batchSize) {
          await flush();
        }
      }
      result.articles += 1;
      await setMemoryCheckpoint(SECTIONS_PG_BACKFILL_CURSOR_KEY, article);
    } catch (err) {
      result.failures += 1;
      log.warn(
        { article, err: err instanceof Error ? err.message : String(err) },
        "memory-v3 sections pg backfill: article failed (non-fatal)",
      );
    }
  }
  await flush();

  log.info(result, "memory-v3 sections pg backfill complete");
  return result;
}
