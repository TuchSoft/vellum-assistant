/**
 * Message-content search configuration.
 *
 * `lexicalStore` selects where the message lexical index is written and read
 * during the Qdrant -> Postgres cutover:
 *
 * - `qdrant` (default): the shipped behavior. Every job writes the Qdrant
 *   collection and every read goes through it; Postgres is untouched.
 * - `dual`: the jobs write both stores; reads come from Postgres.
 * - `postgres`: the jobs write Postgres only; reads come from Postgres.
 *
 * The flag exists for the cutover, not as a permanent second backend: the
 * Qdrant branch is removed once the switch is complete.
 *
 * `thinkingIndexMaxChars` controls how much reasoning text enters the index. A
 * message's readable text (text blocks, tool results, extracted file text) is
 * always indexed; the `thinking` blocks are appended only when that text is
 * empty or shorter than this threshold. Set it to `0` to index reasoning only
 * for rows that carry no readable text at all.
 *
 * `languages` and `queryMinRelativeDistance` configure the per-language lane.
 * Every message is always indexed in the language-agnostic index; a message
 * whose detected language has its own index is additionally searchable there,
 * with stemming. `languages` is the set of languages the instance cares about
 * (empty = no restriction, every compiled language) and is handed to the
 * detector as its CANDIDATE SET, so a message or query can never be classified
 * as a language outside the list. `queryMinRelativeDistance` is the confidence
 * floor under which a query's language is not trusted and only the agnostic
 * lane runs.
 */
import { z } from "zod";

/** Where the message lexical index is written and read. */
export const LEXICAL_STORES = ["qdrant", "dual", "postgres"] as const;

/** Default for {@link SearchConfigSchema.shape.thinkingIndexMaxChars}. */
export const DEFAULT_THINKING_INDEX_MAX_CHARS = 200;

/**
 * Default for {@link SearchConfigSchema.shape.queryMinRelativeDistance}. Higher
 * than the document-side value (0.0) on purpose: a wrong language on a document
 * costs nothing (the agnostic index is always there), while a wrong language on
 * a query adds a noisy lane to the fusion.
 */
export const DEFAULT_QUERY_MIN_RELATIVE_DISTANCE = 0.1;

export const SearchConfigSchema = z
  .object({
    lexicalStore: z
      .enum(LEXICAL_STORES, {
        error: "search.lexicalStore must be one of: qdrant, dual, postgres",
      })
      .default("qdrant")
      .describe(
        "Where the message lexical index is written and read. `qdrant` is the shipped behavior; `dual` writes both and reads Postgres; `postgres` writes and reads Postgres only.",
      ),
    thinkingIndexMaxChars: z
      .number({
        error: "search.thinkingIndexMaxChars must be a number",
      })
      .int("search.thinkingIndexMaxChars must be an integer")
      .min(0, "search.thinkingIndexMaxChars must be >= 0")
      .default(DEFAULT_THINKING_INDEX_MAX_CHARS)
      .describe(
        "Append a message's thinking blocks to its indexed text only when the readable text is empty or shorter than this many characters. 0 means reasoning is indexed only when there is no readable text.",
      ),
    languages: z
      .array(
        z.string({
          error: "search.languages must be an array of ISO 639-1 codes",
        }),
      )
      .default([])
      .describe(
        "ISO 639-1 codes of the languages this instance searches in. Empty means no restriction (every language the detector was compiled with). The list is the detector's candidate set, so nothing outside it is ever detected; a code the detector cannot detect is a startup error, not a silent fallback.",
      ),
    queryMinRelativeDistance: z
      .number({
        error: "search.queryMinRelativeDistance must be a number",
      })
      .min(0, "search.queryMinRelativeDistance must be >= 0")
      .max(1, "search.queryMinRelativeDistance must be <= 1")
      .default(DEFAULT_QUERY_MIN_RELATIVE_DISTANCE)
      .describe(
        "Minimum relative confidence for a query's detected language to be trusted. Below it only the language-agnostic index is searched.",
      ),
  })
  .describe(
    "Message-content search: index store selection, the reasoning-indexing threshold, and the language lane",
  );

export type SearchConfig = z.infer<typeof SearchConfigSchema>;
