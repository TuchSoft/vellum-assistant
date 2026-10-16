import { mock, spyOn } from "bun:test";

import type { ConsentState } from "../../platform/consent-cache.js";

let shareAnalytics: ConsentState = true;
// Owner's `share_diagnostics` consent + accepted version — a second,
// independent gate some outbox event types layer on top of
// `share_analytics` (their payload carries content richer than metadata).
// Default permissive/far-future so tests that only care about the analytics
// gate are unaffected; the diagnostics-specific cases override via
// `setShareDiagnostics`.
let shareDiagnostics = true;
let shareDiagnosticsVersion = "2999-01-01";

// Installed when this harness is imported. bun's mock.module patches
// retroactively (live bindings), so importers need no special import order.
// This harness is imported by *.test.ts files only — never by the test
// preload — so it runs after the per-test workspace override, where src/
// imports are as safe as in the test files themselves (AGENTS.md "Test
// machinery isolation" scopes its no-src/ rule to preload-time machinery).
mock.module("../../platform/consent-cache.js", () => ({
  getRawShareAnalytics: () => shareAnalytics,
  getCachedShareDiagnostics: () => shareDiagnostics,
  getCachedShareDiagnosticsVersion: () => shareDiagnosticsVersion,
}));

import * as dbConnection from "../../persistence/db-connection.js";
import { getTelemetryAsyncDb } from "../../persistence/db-facade.js";
import { initializeDb } from "../../persistence/db-init.js";
import { queryTelemetryOutboxBatch } from "../telemetry-events-outbox.js";

await initializeDb();

/** Flip the mocked share_analytics consent; call with true in beforeEach. */
export function setShareAnalytics(value: ConsentState): void {
  shareAnalytics = value;
}

/**
 * Flip the mocked share_diagnostics consent and, optionally, its accepted
 * version (defaults far-future/unconditionally eligible). Call with `true`
 * in `beforeEach` for stores that gate on it.
 */
export function setShareDiagnostics(
  value: boolean,
  version = "2999-01-01",
): void {
  shareDiagnostics = value;
  shareDiagnosticsVersion = version;
}

/** Delete every telemetry_events row. */
export async function resetOutboxTable(): Promise<void> {
  const db = getTelemetryAsyncDb();
  if (!db) {
    throw new Error("telemetry DB unavailable in test");
  }
  await db.label("test:outbox:reset").run("DELETE FROM telemetry_events");
}

/** Pending rows for one event name in (created_at, id) order. */
export async function pendingOutboxRows(
  name: string,
  limit = 100,
): Promise<Array<{ id: string; createdAt: number; payload: string }>> {
  return queryTelemetryOutboxBatch(name, limit);
}

/** Pending payloads for one event name, JSON-parsed, in flush order. */
export async function pendingOutboxPayloads<T = Record<string, unknown>>(
  name: string,
  limit = 100,
): Promise<T[]> {
  const rows = await pendingOutboxRows(name, limit);
  return rows.map((row) => JSON.parse(row.payload) as T);
}

/** Run `fn` with the telemetry connection reported as unavailable. */
export async function withTelemetryDbUnavailable(
  fn: () => Promise<void>,
): Promise<void> {
  // The async facade resolves its backend at call time. Under SQLite it reads
  // `dbConnection.getTelemetrySqlite()`; under Postgres it reads the slot's
  // connection URL. Blank both the SQLite accessors and the URL env so the
  // facade reports the slot unavailable regardless of backend.
  const savedSlotUrl = process.env.VELLUM_TELEMETRY_DATABASE_URL;
  const savedGenericUrl = process.env.VELLUM_DATABASE_URL;
  process.env.VELLUM_TELEMETRY_DATABASE_URL = "";
  process.env.VELLUM_DATABASE_URL = "";
  const spySqlite = spyOn(dbConnection, "getTelemetrySqlite").mockReturnValue(
    null,
  );
  const spyDb = spyOn(dbConnection, "getTelemetryDb").mockReturnValue(null);
  try {
    await fn();
  } finally {
    spySqlite.mockRestore();
    spyDb.mockRestore();
    if (savedSlotUrl === undefined) {
      delete process.env.VELLUM_TELEMETRY_DATABASE_URL;
    } else {
      process.env.VELLUM_TELEMETRY_DATABASE_URL = savedSlotUrl;
    }
    if (savedGenericUrl === undefined) {
      delete process.env.VELLUM_DATABASE_URL;
    } else {
      process.env.VELLUM_DATABASE_URL = savedGenericUrl;
    }
  }
}
