/**
 * Integration tests for the `0006_memory_sections` migration step.
 *
 * Gated on a Postgres test database (`VELLUM_PG_TEST_URL`) that also carries
 * the `vector` extension. Without the extension the step is expected to fail,
 * so the suite reports "unavailable" and skips its assertions instead of
 * failing on a plain Postgres.
 */
import { beforeAll, expect, test } from "bun:test";

import { describePg } from "../../../__tests__/pg-test-db.js";
import { requireMainDb } from "../../db-facade.js";
import { PG_STEPS } from "../pg-steps.js";

const STEP = PG_STEPS.find((step) => step.name === "0006_memory_sections");

describePg("0006_memory_sections", () => {
  let available = false;

  beforeAll(async () => {
    if (!STEP) {
      throw new Error("0006_memory_sections step not found");
    }
    const db = requireMainDb();
    const row = await db.get<{ present: boolean }>(
      `SELECT EXISTS (
         SELECT 1 FROM pg_extension WHERE extname = 'vector'
       ) AS present`,
    );
    available = row?.present === true;
    if (available) {
      await db.exec(`DROP TABLE IF EXISTS memory_sections`);
      await STEP.up(db);
    }
  }, 180_000);

  test("creates the table and its indexes", async () => {
    if (!available) {
      return;
    }
    const db = requireMainDb();
    const table = await db.get<{ present: boolean }>(
      `SELECT to_regclass('memory_sections') IS NOT NULL AS present`,
    );
    expect(table?.present).toBe(true);
    const indexes = await db.all<{ indexname: string }>(
      `SELECT indexname FROM pg_indexes
       WHERE schemaname = current_schema() AND tablename = 'memory_sections'
       ORDER BY indexname`,
    );
    expect(indexes.map((index) => index.indexname)).toEqual([
      "idx_memory_sections_exclusive",
      "idx_memory_sections_projects",
      "memory_sections_embedding_hnsw",
      "memory_sections_pkey",
    ]);
  }, 60_000);

  test("is idempotent: a second apply does not throw", async () => {
    if (!available || !STEP) {
      return;
    }
    const db = requireMainDb();
    await STEP.up(db);
    await STEP.up(db);
    expect(true).toBe(true);
  }, 60_000);

  test("the embedding column is typed vector(1024)", async () => {
    if (!available) {
      return;
    }
    const db = requireMainDb();
    const column = await db.get<{ type: string }>(
      `SELECT format_type(a.atttypid, a.atttypmod) AS type
         FROM pg_attribute a
         JOIN pg_class c ON c.oid = a.attrelid
        WHERE c.relname = 'memory_sections' AND a.attname = 'embedding'`,
    );
    expect(column?.type).toBe("vector(1024)");
  }, 60_000);
});
