import { beforeEach, describe, expect, test } from "bun:test";

import { APP_VERSION } from "../../version.js";
import { recordWatchdogEvent } from "../watchdog-events-store.js";
import {
  pendingOutboxPayloads,
  pendingOutboxRows,
  resetOutboxTable,
  setShareAnalytics,
} from "./outbox-test-harness.js";

describe("watchdog-events-store", () => {
  beforeEach(async () => {
    setShareAnalytics(true);
    await resetOutboxTable();
  });

  test("honors the share_analytics opt-out (records nothing)", async () => {
    setShareAnalytics(false);
    await recordWatchdogEvent({
      checkName: "event_loop_blocked",
      value: 60000,
    });
    expect(await pendingOutboxRows("watchdog", 10)).toHaveLength(0);
  });

  test("records the full wire event, with detail as a nested object", async () => {
    await recordWatchdogEvent({
      checkName: "event_loop_blocked",
      value: 12345,
      detail: { reason: "no_bytes_60s", threshold_ms: 5000 },
    });

    const rows = await pendingOutboxRows("watchdog", 10);
    expect(rows).toHaveLength(1);
    const row = rows[0]!;
    expect(row.id).toBeString();
    expect(row.createdAt).toBeGreaterThan(0);
    expect(JSON.parse(row.payload)).toEqual({
      type: "watchdog",
      daemon_event_id: row.id,
      recorded_at: row.createdAt,
      check_name: "event_loop_blocked",
      value: 12345,
      detail: { reason: "no_bytes_60s", threshold_ms: 5000 },
      assistant_version: APP_VERSION,
    });
  });

  test("omitted value and detail persist as null", async () => {
    await recordWatchdogEvent({ checkName: "stream_idle" });

    const payloads = await pendingOutboxPayloads("watchdog");
    expect(payloads).toHaveLength(1);
    expect(payloads[0]).toMatchObject({
      check_name: "stream_idle",
      value: null,
      detail: null,
    });
  });

  test("explicit null value and detail persist as null", async () => {
    await recordWatchdogEvent({
      checkName: "restart",
      value: null,
      detail: null,
    });

    const payloads = await pendingOutboxPayloads("watchdog");
    expect(payloads).toHaveLength(1);
    expect(payloads[0]?.value).toBeNull();
    expect(payloads[0]?.detail).toBeNull();
  });
});
