import {
  bigint,
  boolean,
  index,
  integer,
  pgTable,
  primaryKey,
  text,
} from "drizzle-orm/pg-core";

import { vector } from "./custom-types.js";

/**
 * Embedding dimension of the section vectors, and therefore of the
 * `embedding` column. `pgvector` takes the dimension as part of the column
 * type, so it cannot be deferred to the config the way the Qdrant collection's
 * size can: a deployment whose `memory.qdrant.vectorSize` differs cannot use
 * this store (the store refuses writes and the migration's column is the
 * authority). Kept as one exported constant so the schema, the migration and
 * the store cannot drift.
 */
export const MEMORY_SECTION_EMBEDDING_DIM = 1024;

/**
 * The Postgres section-grain dense index for memory v3: the `pgvector`
 * counterpart of the Qdrant `memory_v3_sections` collection.
 *
 * One row per page section, keyed on `(article, ordinal)` — the same identity
 * the Qdrant point id is derived from, so a re-upsert replaces in place and a
 * backfill is idempotent. The payload columns mirror the Qdrant point payload
 * (`article`, `ordinal`, `title`, plus the project scope) so the dense lane
 * reads the same fields from either store.
 *
 * The HNSW cosine index over `embedding` is created by the
 * `0006_memory_sections` migration, not here: Drizzle cannot express an HNSW
 * opclass index, and the migration is the single place that must also fail
 * explicitly when the `vector` extension is missing.
 *
 * No foreign keys: sections are derived data, repopulated by the maintain pass,
 * and the article slug is not a table key anywhere.
 */
export const memorySections = pgTable(
  "memory_sections",
  {
    article: text("article").notNull(),
    ordinal: integer("ordinal").notNull(),
    title: text("title").notNull(),
    projects: text("projects").array().notNull(),
    exclusive: boolean("exclusive").notNull(),
    embedding: vector(MEMORY_SECTION_EMBEDDING_DIM).notNull(),
    updatedAt: bigint("updated_at", { mode: "number" }).notNull(),
  },
  (table) => [
    primaryKey({ columns: [table.article, table.ordinal] }),
    index("idx_memory_sections_projects").using("gin", table.projects),
    index("idx_memory_sections_exclusive").on(table.exclusive),
  ],
);
