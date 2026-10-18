/**
 * Unit tests for the Postgres baseline builder and the committed baseline.
 *
 * These need no database: they exercise the model -> DDL translation on a small
 * synthetic model, and assert invariants of the committed
 * `baseline.generated.ts` (log tables absent; every statement idempotent).
 */

import { describe, expect, test } from "bun:test";

import { BASELINE_STATEMENTS, BASELINE_TABLES } from "../baseline.generated.js";
import {
  buildBaselineStatements,
  pgDefaultFor,
  pgTypeFor,
} from "../baseline.js";
import { PG_MIGRATION_LEDGER } from "../run-pg-migrations.js";
import type { SqliteSchema } from "../sqlite-model.js";

const model: SqliteSchema = {
  tables: [
    {
      name: "parent",
      columns: [
        {
          name: "id",
          declaredType: "TEXT",
          notNull: false,
          defaultValue: null,
          pkOrdinal: 1,
        },
        {
          name: "flag",
          declaredType: "INTEGER",
          notNull: true,
          defaultValue: "0",
          pkOrdinal: 0,
        },
      ],
      indexes: [],
      foreignKeys: [],
    },
    {
      name: "child",
      columns: [
        {
          name: "id",
          declaredType: "TEXT",
          notNull: false,
          defaultValue: null,
          pkOrdinal: 1,
        },
        {
          name: "parent_id",
          declaredType: "TEXT",
          notNull: true,
          defaultValue: null,
          pkOrdinal: 0,
        },
        {
          name: "blob_data",
          declaredType: "BLOB",
          notNull: false,
          defaultValue: null,
          pkOrdinal: 0,
        },
        {
          name: "created_at",
          declaredType: "INTEGER",
          notNull: true,
          defaultValue: null,
          pkOrdinal: 0,
        },
      ],
      indexes: [
        { name: "idx_child_parent", unique: false, columns: ["parent_id"] },
      ],
      foreignKeys: [
        {
          columns: ["parent_id"],
          refTable: "parent",
          refColumns: ["id"],
          onDelete: "CASCADE",
        },
      ],
    },
    {
      name: "llm_request_logs",
      columns: [
        {
          name: "id",
          declaredType: "TEXT",
          notNull: false,
          defaultValue: null,
          pkOrdinal: 1,
        },
      ],
      indexes: [],
      foreignKeys: [],
    },
  ],
};

const statements = buildBaselineStatements(model, {
  pgTypeOverrides: new Map([["parent.flag", "boolean"]]),
});
const joined = statements.join("\n");

describe("pgTypeFor", () => {
  test("maps the SQLite type families", () => {
    expect(pgTypeFor("INTEGER")).toBe("bigint");
    expect(pgTypeFor("TEXT")).toBe("text");
    expect(pgTypeFor("VARCHAR(32)")).toBe("text");
    expect(pgTypeFor("BLOB")).toBe("bytea");
    expect(pgTypeFor("REAL")).toBe("double precision");
    expect(pgTypeFor("NUMERIC")).toBe("numeric");
    expect(pgTypeFor("BOOLEAN")).toBe("boolean");
    expect(pgTypeFor("")).toBe("text");
  });
});

describe("pgDefaultFor", () => {
  test("passes literals through and rewrites SQLite time functions", () => {
    expect(pgDefaultFor("0")).toBe("0");
    expect(pgDefaultFor("'active'")).toBe("'active'");
    expect(pgDefaultFor("CURRENT_TIMESTAMP")).toBe("CURRENT_TIMESTAMP");
    expect(pgDefaultFor("strftime('%s','now')")).toBe("now()");
  });
});

describe("buildBaselineStatements", () => {
  test("includes the LLM log table (the consolidated database reads it)", () => {
    expect(joined).toContain("llm_request_logs");
  });

  test("maps column types, honouring the schema-file overrides", () => {
    expect(joined).toContain('"flag" boolean NOT NULL DEFAULT false');
    expect(joined).toContain('"created_at" bigint NOT NULL');
    expect(joined).toContain('"blob_data" bytea');
  });

  test("emits primary keys inline", () => {
    expect(joined).toContain('"id" text PRIMARY KEY');
  });

  test("emits foreign keys as idempotent DO-block ALTERs", () => {
    expect(joined).toContain('ALTER TABLE "child" ADD CONSTRAINT');
    expect(joined).toContain('REFERENCES "parent" ("id") ON DELETE CASCADE');
    expect(joined).toContain("EXCEPTION WHEN duplicate_object THEN NULL");
  });

  test("emits indexes with IF NOT EXISTS", () => {
    expect(joined).toContain(
      'CREATE INDEX IF NOT EXISTS "idx_child_parent" ON "child" ("parent_id")',
    );
  });
});

describe("committed baseline", () => {
  test("covers a substantial schema", () => {
    expect(BASELINE_TABLES.length).toBeGreaterThan(50);
    expect(BASELINE_STATEMENTS.length).toBeGreaterThan(BASELINE_TABLES.length);
  });

  test("does not contain the log tables or the migration ledger", () => {
    // The consolidated Postgres database also carries `llm_request_logs`
    // (the conversation store reads it directly), so it stays in the baseline.
    expect(BASELINE_TABLES).toContain("llm_request_logs");
    expect(BASELINE_TABLES).not.toContain("memory_v2_activation_logs");
    expect(BASELINE_TABLES).not.toContain("memory_v2_injection_events");
    expect(BASELINE_TABLES).not.toContain("activation_state");
    expect(BASELINE_TABLES).not.toContain(PG_MIGRATION_LEDGER);
    expect(BASELINE_TABLES.some((t) => /compaction_log/.test(t))).toBe(false);
  });

  test("every statement is idempotent", () => {
    const nonIdempotent = BASELINE_STATEMENTS.filter(
      (statement) =>
        !statement.includes("IF NOT EXISTS") &&
        !statement.includes("duplicate_object"),
    );
    expect(nonIdempotent).toEqual([]);
  });

  test("every baseline table gets a CREATE TABLE", () => {
    for (const table of BASELINE_TABLES) {
      expect(
        BASELINE_STATEMENTS.some((s) =>
          s.startsWith(`CREATE TABLE IF NOT EXISTS "${table}"`),
        ),
      ).toBe(true);
    }
  });
});
