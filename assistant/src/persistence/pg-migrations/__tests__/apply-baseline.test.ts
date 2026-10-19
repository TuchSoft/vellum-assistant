import { describe, expect, test } from "bun:test";

import type { AsyncDb } from "../../db-facade.js";
import {
  APPLICATION_SCHEMA_PROBE_SQL,
  applyBaselineIfNeeded,
} from "../apply-baseline.js";

interface FakeState {
  schemaPresent: boolean | null;
  executed: string[];
}

function fakeDb(state: FakeState): AsyncDb {
  return {
    get: async (sqlText: string) => {
      if (sqlText !== APPLICATION_SCHEMA_PROBE_SQL) {
        return null;
      }
      return state.schemaPresent == null
        ? null
        : { present: state.schemaPresent };
    },
    exec: async (sqlText: string) => {
      state.executed.push(sqlText);
    },
  } as unknown as AsyncDb;
}

const BASELINE = [
  'CREATE TABLE IF NOT EXISTS "conversations" ("id" text PRIMARY KEY)',
  'CREATE INDEX IF NOT EXISTS "idx_conversations_inference_profile_expires_at" ON "conversations" ("inference_profile_expires_at")',
];

describe("applyBaselineIfNeeded", () => {
  test("applies the baseline on an empty database", async () => {
    const state: FakeState = { schemaPresent: false, executed: [] };

    expect(await applyBaselineIfNeeded(fakeDb(state), BASELINE)).toBe(true);
    expect(state.executed).toEqual(BASELINE);
  });

  test("treats an unreadable probe as an empty database", async () => {
    const state: FakeState = { schemaPresent: null, executed: [] };

    expect(await applyBaselineIfNeeded(fakeDb(state), BASELINE)).toBe(true);
    expect(state.executed).toEqual(BASELINE);
  });

  test("second boot: the baseline is skipped after 0002 dropped retired columns", async () => {
    // First boot on an empty database: baseline runs.
    const state: FakeState = { schemaPresent: false, executed: [] };
    const db = fakeDb(state);
    expect(await applyBaselineIfNeeded(db, BASELINE)).toBe(true);
    expect(state.executed).toHaveLength(2);

    // 0002_alias_model_columns drops `inference_profile_expires_at`, so the
    // baseline's index statement would fail if replayed. The schema exists.
    state.schemaPresent = true;
    state.executed.length = 0;

    // Second boot on the same evolved database: nothing runs, nothing throws.
    expect(await applyBaselineIfNeeded(db, BASELINE)).toBe(false);
    expect(state.executed).toEqual([]);
  });
});
