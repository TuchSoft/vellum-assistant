/**
 * Tests for the `call_site` column on `llm_request_logs`. The column is
 * stamped by `recordRequestLog` at insertion time and surfaces in
 * `LogRow.callSite`. Historical rows (pre-migration 264) stay NULL —
 * "we don't know" rather than guessing `mainAgent`.
 */
import { Database } from "bun:sqlite";
import { beforeEach, describe, expect, test } from "bun:test";

import { drizzle } from "drizzle-orm/bun-sqlite";

import type { DrizzleDb } from "../persistence/db-connection.js";
import { requireMainDb } from "../persistence/db-facade.js";
import {
  getRequestLogById,
  recordRequestLog,
} from "../persistence/llm-request-log-store.js";
import { migrateLlmRequestLogCallSite } from "../persistence/migrations/264-llm-request-log-call-site.js";
import { describePg } from "./pg-test-db.js";

async function resetLogs(): Promise<void> {
  await requireMainDb().run("DELETE FROM llm_request_logs");
}

describePg("recordRequestLog call_site stamping", () => {
  beforeEach(async () => {
    await resetLogs();
  });

  test("stamps callSite when provided", async () => {
    const id = await recordRequestLog(
      "conv-1",
      '{"req":1}',
      '{"res":1}',
      undefined,
      "anthropic",
      "mainAgent",
    );
    const row = await getRequestLogById(id!);
    expect(row).not.toBeNull();
    expect(row!.callSite).toBe("mainAgent");
  });

  test("leaves callSite NULL when omitted (backward compat)", async () => {
    const id = await recordRequestLog("conv-1", '{"req":1}', '{"res":1}');
    const row = await getRequestLogById(id!);
    expect(row).not.toBeNull();
    expect(row!.callSite).toBeNull();
  });

  test("supports the compactionAgent value", async () => {
    const id = await recordRequestLog(
      "conv-1",
      '{"req":1}',
      '{"res":1}',
      undefined,
      "anthropic",
      "compactionAgent",
    );
    expect((await getRequestLogById(id!))?.callSite).toBe("compactionAgent");
  });

  test("two rows in the same conversation can carry different callSites", async () => {
    const mainId = await recordRequestLog(
      "conv-1",
      '{"req":1}',
      '{"res":1}',
      undefined,
      "anthropic",
      "mainAgent",
    );
    const compactId = await recordRequestLog(
      "conv-1",
      '{"req":2}',
      '{"res":2}',
      undefined,
      "anthropic",
      "compactionAgent",
    );
    expect((await getRequestLogById(mainId!))?.callSite).toBe("mainAgent");
    expect((await getRequestLogById(compactId!))?.callSite).toBe(
      "compactionAgent",
    );
  });
});

/** A standalone SQLite handle for exercising the SQLite-only migration. */
function createMigrationDb(): { db: DrizzleDb; raw: Database } {
  const raw = new Database(":memory:");
  raw.exec("CREATE TABLE llm_request_logs (id TEXT PRIMARY KEY)");
  const db = drizzle(raw) as unknown as DrizzleDb;
  return { db, raw };
}

describe("migrateLlmRequestLogCallSite", () => {
  test("adds the call_site column when missing", () => {
    const { db, raw } = createMigrationDb();
    const before = raw
      .query(`PRAGMA table_info(llm_request_logs)`)
      .all() as Array<{ name: string }>;
    expect(before.some((c) => c.name === "call_site")).toBe(false);

    migrateLlmRequestLogCallSite(db);

    const after = raw
      .query(`PRAGMA table_info(llm_request_logs)`)
      .all() as Array<{ name: string }>;
    expect(after.some((c) => c.name === "call_site")).toBe(true);
    raw.close();
  });

  test("is idempotent — second run is a no-op", () => {
    const { db, raw } = createMigrationDb();
    migrateLlmRequestLogCallSite(db);
    expect(() => migrateLlmRequestLogCallSite(db)).not.toThrow();
    raw.close();
  });
});
