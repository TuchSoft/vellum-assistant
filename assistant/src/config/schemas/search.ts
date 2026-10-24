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
 */
import { z } from "zod";

/** Where the message lexical index is written and read. */
export const LEXICAL_STORES = ["qdrant", "dual", "postgres"] as const;

/** Default for {@link SearchConfigSchema.shape.thinkingIndexMaxChars}. */
export const DEFAULT_THINKING_INDEX_MAX_CHARS = 200;

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
  })
  .describe(
    "Message-content search: index store selection and the reasoning-indexing threshold",
  );

export type SearchConfig = z.infer<typeof SearchConfigSchema>;
