import { beforeEach, describe, expect, test } from "bun:test";

import {
  type AuthFallbackCount,
  recordAuthFallbackCounts,
} from "../security/auth-fallback-events-store.js";
import {
  pendingOutboxRows,
  resetOutboxTable,
  setShareAnalytics,
  withTelemetryDbUnavailable,
} from "../telemetry/__tests__/outbox-test-harness.js";
import type { AuthFallbackTelemetryEvent } from "../telemetry/types.js";
import { APP_VERSION } from "../version.js";

const SAMPLE: AuthFallbackCount[] = [
  {
    guard: "edge",
    path: "/v1/messages",
    failureKind: "missing_authorization",
    count: 7,
  },
  {
    guard: "edge-scoped",
    path: "/v1/files",
    failureKind: "insufficient_scope",
    count: 2,
  },
];

describe("auth-fallback-events-store", () => {
  beforeEach(async () => {
    setShareAnalytics(true);
    await resetOutboxTable();
  });

  test("records one outbox row per count entry with the full wire payload", async () => {
    const recorded = await recordAuthFallbackCounts(1000, 2000, SAMPLE);
    expect(recorded).toBe(2);

    const rows = await pendingOutboxRows("auth_fallback");
    expect(rows.length).toBe(2);
    const payloads = rows.map(
      (row) => JSON.parse(row.payload) as AuthFallbackTelemetryEvent,
    );
    const byGuard = Object.fromEntries(
      payloads.map((payload) => [payload.guard, payload]),
    );
    expect(byGuard["edge"]).toEqual({
      type: "auth_fallback",
      daemon_event_id: expect.any(String),
      recorded_at: expect.any(Number),
      guard: "edge",
      path: "/v1/messages",
      failure_kind: "missing_authorization",
      count: 7,
      window_start: 1000,
      window_end: 2000,
      assistant_version: APP_VERSION,
    });
    expect(byGuard["edge-scoped"]).toMatchObject({
      path: "/v1/files",
      failure_kind: "insufficient_scope",
      count: 2,
    });
    // The wire daemon_event_id matches the outbox row id, and recorded_at
    // matches the row's created_at (record-time stamping).
    rows.forEach((row, idx) => {
      expect(payloads[idx].daemon_event_id).toBe(row.id);
      expect(payloads[idx].recorded_at).toBe(row.createdAt);
    });
  });

  test("honors a confirmed share_analytics opt-out (records nothing)", async () => {
    setShareAnalytics(false);
    const recorded = await recordAuthFallbackCounts(1000, 2000, SAMPLE);
    expect(recorded).toBe(0);
    expect((await pendingOutboxRows("auth_fallback")).length).toBe(0);
  });

  test("records while consent is unknown (a cold cache never drops data)", async () => {
    setShareAnalytics("unknown");
    const recorded = await recordAuthFallbackCounts(1000, 2000, SAMPLE);
    expect(recorded).toBe(2);
    expect((await pendingOutboxRows("auth_fallback")).length).toBe(2);
  });

  test("empty counts batch is a no-op", async () => {
    expect(await recordAuthFallbackCounts(1000, 2000, [])).toBe(0);
    expect((await pendingOutboxRows("auth_fallback")).length).toBe(0);
  });

  test("records all-or-nothing: db unavailable returns 0 with no rows", async () => {
    await withTelemetryDbUnavailable(async () => {
      const result = await recordAuthFallbackCounts(1000, 2000, SAMPLE);
      expect(result).toBe(0);
    });
    // No partial batch: the gateway's `recorded === 0` retry contract means
    // any committed remnant would later double-count.
    expect((await pendingOutboxRows("auth_fallback")).length).toBe(0);
  });
});
