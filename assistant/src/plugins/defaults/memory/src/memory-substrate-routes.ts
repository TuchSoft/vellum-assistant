/**
 * Concept-page substrate routes: validate, read/list pages, reembed, and
 * reembed-skills.
 *
 * These are the operations that read or maintain the shared concept-page
 * workspace. They keep the `memory/v2/*` endpoint spellings, operation ids, and
 * `MEMORY_V2_DISABLED` error code because those are frozen wire surface clients
 * already match on.
 */
import { stat } from "node:fs/promises";
import { join } from "node:path";

import { z } from "zod";

import { loadConfig } from "../../../../config/loader.js";
import { usesConceptPageMemory } from "../../../../config/memory-v3-gate.js";
import { enqueueMemoryJob } from "../../../../persistence/jobs-store.js";
import { ACTOR_PRINCIPALS } from "../../../../runtime/auth/route-policy.js";
import { RouteError } from "../../../../runtime/routes/errors.js";
import type {
  RouteDefinition,
  RouteHandlerArgs,
} from "../../../../runtime/routes/types.js";
import { getLogger } from "../logging.js";
import { getWorkspaceDir } from "../paths.js";
import { getEdgeIndex, totalEdgeCount } from "../substrate/edge-index.js";
import { getPageIndex } from "../substrate/page-index.js";
import type { DanglingLink } from "../substrate/page-links.js";
import {
  getConceptsDir,
  listPages,
  readPage,
  renderPageContent,
} from "../substrate/page-store.js";
import { seedV2SkillEntries } from "../substrate/skill-store.js";
import { resolveSubstrateTuning } from "../substrate/tuning.js";

const log = getLogger("memory-substrate-routes");

/**
 * Wire-format error code emitted when concept-page routes reject a request
 * because concept-page memory is not active. Exported so tests and the macOS
 * client can reference the same string without drift; the literal keeps its
 * historical `MEMORY_V2` spelling because clients match on it.
 */
export const MEMORY_V2_DISABLED_CODE = "MEMORY_V2_DISABLED";

/**
 * Reject the request when concept-page memory is not active. Returning 409
 * (rather than serving a partial response) keeps clients honest — the desktop
 * Memories panel reads this code to render an explicit "disabled in
 * config" empty state.
 */
function requireConceptPageMemory(): void {
  if (!usesConceptPageMemory(loadConfig().memory)) {
    throw new RouteError(
      "Concept-page memory is not active — enable memory.v3.live to use this command.",
      MEMORY_V2_DISABLED_CODE,
      409,
    );
  }
}

// ── Backfill ────────────────────────────────────────────────────────────

const MemoryV2BackfillParams = z
  .object({
    op: z.enum(["reembed"]),
    force: z.boolean().optional(),
  })
  .strict();

export type MemoryV2BackfillOp = z.infer<typeof MemoryV2BackfillParams>["op"];

export type MemoryV2BackfillResult = {
  jobId: string;
};

async function handleBackfill({
  body = {},
}: RouteHandlerArgs): Promise<MemoryV2BackfillResult> {
  requireConceptPageMemory();
  MemoryV2BackfillParams.parse(body);
  const jobId = await enqueueMemoryJob("memory_v2_reembed", {});
  return { jobId };
}

// ── Validate ────────────────────────────────────────────────────────────

const MemoryV2ValidateParams = z.object({}).strict();

type OversizedPage = { slug: string; chars: number };
type ParseFailure = { slug: string; error: string };

export type MemoryV2ValidateResult = {
  pageCount: number;
  edgeCount: number;
  /**
   * `links:`, `[[wikilink]]`, and `edges:` references whose target has no
   * page (`PageIndex.danglingLinks`).
   */
  danglingLinks: DanglingLink[];
  oversizedPages: OversizedPage[];
  parseFailures: ParseFailure[];
};

async function handleValidate({
  body = {},
}: RouteHandlerArgs): Promise<MemoryV2ValidateResult> {
  // Intentionally NOT gated on the memory tier: validate is a read-only
  // diagnostic walk over the on-disk concept-page workspace and must stay
  // runnable before memory is switched on.
  MemoryV2ValidateParams.parse(body);

  const workspaceDir = getWorkspaceDir();
  const maxPageChars = resolveSubstrateTuning(
    loadConfig().memory,
  ).max_page_chars;

  const slugs = await listPages(workspaceDir);
  const knownSlugs = new Set<string>();
  const oversizedPages: OversizedPage[] = [];
  const parseFailures: ParseFailure[] = [];

  for (const slug of slugs) {
    try {
      const page = await readPage(workspaceDir, slug);
      if (!page) {
        continue;
      }
      knownSlugs.add(slug);
      const chars = page.body.length;
      if (chars > maxPageChars) {
        oversizedPages.push({ slug, chars });
      }
    } catch (err) {
      parseFailures.push({
        slug,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }

  const [edgeIndex, pageIndex] = await Promise.all([
    getEdgeIndex(workspaceDir),
    getPageIndex(workspaceDir),
  ]);

  return {
    pageCount: knownSlugs.size,
    edgeCount: totalEdgeCount(edgeIndex),
    danglingLinks: pageIndex.danglingLinks,
    oversizedPages,
    parseFailures,
  };
}

// ── Get concept page ────────────────────────────────────────────────────

const MemoryV2GetConceptPageParams = z
  .object({
    slug: z.string().min(1),
  })
  .strict();

export type MemoryV2GetConceptPageResult = {
  slug: string;
  /** Frontmatter + body, as produced by `renderPageContent`. */
  rendered: string;
};

async function handleGetConceptPage({
  body = {},
}: RouteHandlerArgs): Promise<MemoryV2GetConceptPageResult> {
  requireConceptPageMemory();
  const { slug } = MemoryV2GetConceptPageParams.parse(body);
  const workspaceDir = getWorkspaceDir();
  let page;
  try {
    page = await readPage(workspaceDir, slug);
  } catch (err) {
    throw new RouteError(
      `Failed to read concept page '${slug}': ${err instanceof Error ? err.message : String(err)}`,
      "MEMORY_V2_PAGE_READ_FAILED",
      400,
    );
  }
  if (!page) {
    throw new RouteError(
      `Concept page '${slug}' not found on disk`,
      "MEMORY_V2_PAGE_NOT_FOUND",
      404,
    );
  }
  return { slug, rendered: renderPageContent(page) };
}

// ── List concept pages ──────────────────────────────────────────────────

const MemoryV2ListConceptPagesParams = z.object({}).strict();

export const MemoryV2ListConceptPagesResultSchema = z.object({
  pages: z.array(
    z.object({
      slug: z.string(),
      bodyBytes: z.number(),
      edgeCount: z.number(),
      updatedAtMs: z.number(),
    }),
  ),
});

export type MemoryV2ListConceptPagesResult = z.infer<
  typeof MemoryV2ListConceptPagesResultSchema
>;

async function handleListConceptPages({
  body = {},
}: RouteHandlerArgs): Promise<MemoryV2ListConceptPagesResult> {
  requireConceptPageMemory();
  MemoryV2ListConceptPagesParams.parse(body);

  const workspaceDir = getWorkspaceDir();
  const conceptsDir = getConceptsDir(workspaceDir);
  const slugs = await listPages(workspaceDir);

  const settled = await Promise.all(
    slugs.map(async (slug) => {
      try {
        const page = await readPage(workspaceDir, slug);
        if (!page) {
          return null;
        }
        const stats = await stat(join(conceptsDir, `${slug}.md`));
        return {
          slug,
          bodyBytes: Buffer.byteLength(page.body, "utf8"),
          edgeCount: page.frontmatter.edges.length,
          updatedAtMs: Math.floor(stats.mtimeMs),
        };
      } catch (err) {
        // A single corrupt page (bad YAML, schema mismatch, etc.) shouldn't
        // poison the whole listing — the validate route is the place to
        // surface those; this one is read-only and best-effort.
        log.warn(
          `Skipping concept page '${slug}' in list-concept-pages: ${err instanceof Error ? err.message : String(err)}`,
        );
        return null;
      }
    }),
  );
  const pages = settled.filter(
    (p): p is MemoryV2ListConceptPagesResult["pages"][number] => p !== null,
  );

  return { pages };
}

// ── Reembed skills ──────────────────────────────────────────────────────

const MemoryV2ReembedSkillsParams = z.object({}).strict();

export type MemoryV2ReembedSkillsResult = {
  success: true;
};

async function handleReembedSkills({
  body = {},
}: RouteHandlerArgs): Promise<MemoryV2ReembedSkillsResult> {
  requireConceptPageMemory();
  MemoryV2ReembedSkillsParams.parse(body);

  // Unlike the queued reembed job, this is a CLI-driven sync request: the
  // operator wants the cache replaced before the next prompt assembly, so we
  // await the seed inline rather than enqueueing it. Pass `throwOnError` so
  // embedding/Qdrant failures surface to the CLI instead of being swallowed by
  // the default best-effort behavior.
  await seedV2SkillEntries({ throwOnError: true });

  return { success: true };
}

// ── Route definitions ───────────────────────────────────────────────────

export const ROUTES: RouteDefinition[] = [
  {
    operationId: "memory_v2_backfill",
    method: "POST",
    policy: {
      requiredScopes: ["settings.write"],
      allowedPrincipalTypes: ACTOR_PRINCIPALS,
    },
    endpoint: "memory/v2/backfill",
    handler: handleBackfill,
    summary: "Enqueue a concept-page reembed job",
    description:
      "Enqueues the operator-triggered concept-page reembed job against the memory jobs queue.",
    tags: ["memory"],
    requestBody: MemoryV2BackfillParams,
  },
  {
    operationId: "memory_v2_validate",
    method: "POST",
    policy: {
      requiredScopes: ["settings.read"],
      allowedPrincipalTypes: ACTOR_PRINCIPALS,
    },
    endpoint: "memory/v2/validate",
    handler: handleValidate,
    summary: "Validate the concept-page workspace state",
    description:
      "Read-only structural validation of the concept-page workspace — reports orphan edges, oversized pages, and parse failures. Runnable regardless of the memory tier so operators can dry-run validation before enabling memory.",
    tags: ["memory"],
    requestBody: MemoryV2ValidateParams,
  },
  {
    operationId: "memory_v2_get_concept_page",
    method: "POST",
    policy: {
      requiredScopes: ["settings.read"],
      allowedPrincipalTypes: ACTOR_PRINCIPALS,
    },
    endpoint: "memory/v2/concept-page",
    handler: handleGetConceptPage,
    summary: "Read a single concept page",
    description:
      "Returns the rendered (frontmatter + body) markdown for a slug. 404 when the slug has no on-disk page.",
    tags: ["memory"],
    requestBody: MemoryV2GetConceptPageParams,
  },
  {
    operationId: "memory_v2_list_concept_pages",
    method: "POST",
    policy: {
      requiredScopes: ["settings.read"],
      allowedPrincipalTypes: ACTOR_PRINCIPALS,
    },
    endpoint: "memory/v2/list-concept-pages",
    handler: handleListConceptPages,
    summary: "List all concept pages with metadata",
    description:
      "Returns slugs, body sizes, edge counts, and last-modified timestamps for every concept page on disk. Read-only; used by the desktop About → Memories surface to render a browse-able list.",
    tags: ["memory"],
    requestBody: MemoryV2ListConceptPagesParams,
    responseBody: MemoryV2ListConceptPagesResultSchema,
  },
  {
    operationId: "memory_v2_reembed_skills",
    method: "POST",
    policy: {
      requiredScopes: ["settings.write"],
      allowedPrincipalTypes: ACTOR_PRINCIPALS,
    },
    endpoint: "memory/v2/reembed-skills",
    handler: handleReembedSkills,
    summary:
      "Re-seed concept-page skill entries from the current skill catalog",
    description:
      "Synchronously re-runs seedV2SkillEntries against the current skill catalog. Gated on concept-page memory being active.",
    tags: ["memory"],
    requestBody: MemoryV2ReembedSkillsParams,
  },
];
