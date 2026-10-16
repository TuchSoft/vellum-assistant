import { beforeEach, describe, expect, test } from "bun:test";

import { getTelemetryAsyncDb } from "../persistence/db-facade.js";
import { APP_VERSION } from "../version.js";
import {
  resetOutboxTable,
  setShareAnalytics,
  withTelemetryDbUnavailable,
} from "./__tests__/outbox-test-harness.js";
import {
  deleteTelemetryOutboxEvents,
  deleteTelemetryOutboxEventsBefore,
  discardPendingTelemetryOutboxEvents,
  insertTelemetryOutboxEvent,
  insertTelemetryOutboxEvents,
  queryTelemetryOutboxBatch,
  recordTelemetryEvent,
} from "./telemetry-events-outbox.js";
import type { LifecycleTelemetryEvent } from "./types.js";

function lifecycleEvent(
  id: string,
  createdAt: number,
): LifecycleTelemetryEvent {
  return {
    type: "lifecycle",
    daemon_event_id: id,
    event_name: "app_open",
    recorded_at: createdAt,
    assistant_version: "1.2.3",
  };
}

function insert(
  id: string,
  createdAt: number,
  name = "lifecycle",
  conversationId?: string | null,
): Promise<boolean> {
  return insertTelemetryOutboxEvent({
    id,
    name,
    createdAt,
    conversationId,
    event: lifecycleEvent(id, createdAt),
  });
}

async function allIds(): Promise<string[]> {
  return (await queryTelemetryOutboxBatch("lifecycle", 10_000)).map(
    (r) => r.id,
  );
}

/** Read rows through the async facade so the assertion is backend-portable. */
function outboxRows() {
  const db = getTelemetryAsyncDb();
  if (!db) {
    throw new Error("telemetry DB unavailable in test");
  }
  return db.all<{ id: string; conversationId: string | null }>(
    'SELECT id, conversation_id AS "conversationId" FROM telemetry_events ORDER BY id',
  );
}

describe("telemetry-events-outbox", () => {
  beforeEach(async () => {
    setShareAnalytics(true);
    await resetOutboxTable();
  });

  test("insert + query round-trips the wire payload", async () => {
    expect(await insert("evt-1", 1000)).toBe(true);

    const rows = await queryTelemetryOutboxBatch("lifecycle", 10);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ id: "evt-1", createdAt: 1000 });
    expect(JSON.parse(rows[0]!.payload)).toEqual(lifecycleEvent("evt-1", 1000));
  });

  test("batch insert lands every row", async () => {
    const inserted = await insertTelemetryOutboxEvents([
      {
        id: "evt-1",
        name: "lifecycle",
        createdAt: 1000,
        event: lifecycleEvent("evt-1", 1000),
      },
      {
        id: "evt-2",
        name: "lifecycle",
        createdAt: 2000,
        event: lifecycleEvent("evt-2", 2000),
      },
      {
        id: "evt-3",
        name: "lifecycle",
        createdAt: 3000,
        event: lifecycleEvent("evt-3", 3000),
      },
    ]);
    expect(inserted).toBe(true);
    expect(await allIds()).toEqual(["evt-1", "evt-2", "evt-3"]);
  });

  test("batch insert is all-or-nothing on a mid-batch failure", async () => {
    await insert("evt-dup", 500);

    await expect(
      insertTelemetryOutboxEvents([
        {
          id: "evt-new-1",
          name: "lifecycle",
          createdAt: 1000,
          event: lifecycleEvent("evt-new-1", 1000),
        },
        {
          id: "evt-dup",
          name: "lifecycle",
          createdAt: 2000,
          event: lifecycleEvent("evt-dup", 2000),
        },
        {
          id: "evt-new-2",
          name: "lifecycle",
          createdAt: 3000,
          event: lifecycleEvent("evt-new-2", 3000),
        },
      ]),
    ).rejects.toThrow();

    // The primary-key conflict aborts the whole statement — no partial batch.
    expect(await allIds()).toEqual(["evt-dup"]);
  });

  test("batch insert returns false when the telemetry DB is unavailable", async () => {
    await withTelemetryDbUnavailable(async () => {
      expect(
        await insertTelemetryOutboxEvents([
          {
            id: "evt-1",
            name: "lifecycle",
            createdAt: 1000,
            event: lifecycleEvent("evt-1", 1000),
          },
        ]),
      ).toBe(false);
    });
    expect(await allIds()).toEqual([]);
  });

  test("empty batch is a successful no-op", async () => {
    expect(await insertTelemetryOutboxEvents([])).toBe(true);
    expect(await allIds()).toEqual([]);
  });

  test("conversation_id persists in its dedicated column", async () => {
    await insert("evt-conv", 1000, "lifecycle", "conv-1");
    await insert("evt-null", 2000, "lifecycle");

    expect(await outboxRows()).toEqual([
      { id: "evt-conv", conversationId: "conv-1" },
      { id: "evt-null", conversationId: null },
    ]);
  });

  test("orders by (created_at, id) with id as tiebreaker", async () => {
    await insert("evt-b", 2000);
    await insert("evt-c", 1000);
    await insert("evt-a", 1000);

    expect(await allIds()).toEqual(["evt-a", "evt-c", "evt-b"]);
  });

  test("honors the limit", async () => {
    await insert("evt-1", 1000);
    await insert("evt-2", 2000);
    await insert("evt-3", 3000);

    const rows = await queryTelemetryOutboxBatch("lifecycle", 2);
    expect(rows.map((r) => r.id)).toEqual(["evt-1", "evt-2"]);
  });

  test("queries are isolated per event name", async () => {
    await insert("evt-life", 1000, "lifecycle");
    await insert("evt-watch", 1000, "watchdog");

    expect(await allIds()).toEqual(["evt-life"]);
    expect(
      (await queryTelemetryOutboxBatch("watchdog", 10)).map((r) => r.id),
    ).toEqual(["evt-watch"]);
    expect(await queryTelemetryOutboxBatch("onboarding", 10)).toEqual([]);
  });

  test("deletes rows by id", async () => {
    await insert("evt-1", 1000);
    await insert("evt-2", 2000);
    await insert("evt-3", 3000);

    await deleteTelemetryOutboxEvents(["evt-1", "evt-3"]);

    expect(await allIds()).toEqual(["evt-2"]);
  });

  test("delete with an empty id list is a no-op", async () => {
    await insert("evt-1", 1000);

    await deleteTelemetryOutboxEvents([]);

    expect(await allIds()).toEqual(["evt-1"]);
  });

  test("deletes more than one chunk of ids", async () => {
    const ids: string[] = [];
    for (let i = 0; i < 501; i++) {
      const id = `evt-${String(i).padStart(4, "0")}`;
      ids.push(id);
      await insert(id, i);
    }
    await insert("evt-keep", 9999);

    await deleteTelemetryOutboxEvents(ids);

    expect(await allIds()).toEqual(["evt-keep"]);
  });

  test("recordTelemetryEvent stamps the base fields", async () => {
    const fields = {
      check_name: "db_size",
      value: 42,
      detail: { table: "messages" },
    };
    const recorded = await recordTelemetryEvent("watchdog", fields);
    expect(recorded).not.toBeNull();

    const rows = await queryTelemetryOutboxBatch("watchdog", 10);
    expect(rows).toHaveLength(1);
    expect(rows[0]!.id).toBe(recorded!.id);
    expect(JSON.parse(rows[0]!.payload)).toEqual({
      type: "watchdog",
      daemon_event_id: recorded!.id,
      recorded_at: recorded!.createdAt,
      assistant_version: APP_VERSION,
      ...fields,
    });
  });

  test("recordTelemetryEvent stamps win over base keys smuggled in via a widened fields value", async () => {
    // A variable (not a literal) skips excess-property checking, so base
    // keys can reach the helper structurally. The stamps must still win.
    const widened = {
      check_name: "db_size",
      value: null,
      detail: null,
      daemon_event_id: "spoofed-id",
      recorded_at: 1,
      assistant_version: "0.0.0-spoof",
    };
    const recorded = await recordTelemetryEvent("watchdog", widened);
    expect(recorded).not.toBeNull();

    const payload = JSON.parse(
      (await queryTelemetryOutboxBatch("watchdog", 10))[0]!.payload,
    ) as Record<string, unknown>;
    expect(payload.daemon_event_id).toBe(recorded!.id);
    expect(payload.recorded_at).toBe(recorded!.createdAt);
    expect(payload.assistant_version).toBe(APP_VERSION);
  });

  test("recordTelemetryEvent persists conversation_id in its column", async () => {
    const withConv = await recordTelemetryEvent(
      "watchdog",
      { check_name: "c1", value: null, detail: null },
      { conversationId: "conv-1" },
    );
    const withoutConv = await recordTelemetryEvent("watchdog", {
      check_name: "c2",
      value: null,
      detail: null,
    });

    const rows = await outboxRows();
    expect(rows).toHaveLength(2);
    expect(rows.find((r) => r.id === withConv!.id)!.conversationId).toBe(
      "conv-1",
    );
    expect(rows.find((r) => r.id === withoutConv!.id)!.conversationId).toBe(
      null,
    );
  });

  test("recordTelemetryEvent honors a confirmed share_analytics opt-out", async () => {
    setShareAnalytics(false);
    expect(
      await recordTelemetryEvent("watchdog", {
        check_name: "c",
        value: null,
        detail: null,
      }),
    ).toBeNull();
    expect(await queryTelemetryOutboxBatch("watchdog", 10)).toEqual([]);
  });

  test("recordTelemetryEvent records while consent is unknown (cold cache)", async () => {
    setShareAnalytics("unknown");
    const recorded = await recordTelemetryEvent("watchdog", {
      check_name: "c",
      value: null,
      detail: null,
    });
    expect(recorded).not.toBeNull();
    expect(
      (await queryTelemetryOutboxBatch("watchdog", 10)).map((r) => r.id),
    ).toEqual([recorded!.id]);
  });

  test("recordTelemetryEvent returns null when the telemetry DB is unavailable", async () => {
    await withTelemetryDbUnavailable(async () => {
      expect(
        await recordTelemetryEvent("watchdog", {
          check_name: "c",
          value: null,
          detail: null,
        }),
      ).toBeNull();
    });
    expect(await queryTelemetryOutboxBatch("watchdog", 10)).toEqual([]);
  });

  test("prune deletes rows strictly older than the cutoff across every name and returns the count", async () => {
    await insert("evt-old-life", 1000, "lifecycle");
    await insert("evt-old-watch", 1500, "watchdog");
    await insert("evt-at-cutoff", 2000, "lifecycle");
    await insert("evt-fresh", 3000, "lifecycle");

    expect(await deleteTelemetryOutboxEventsBefore(2000)).toBe(2);

    // Strictly-before semantics: the row AT the cutoff is retained.
    expect(await allIds()).toEqual(["evt-at-cutoff", "evt-fresh"]);
    expect(await queryTelemetryOutboxBatch("watchdog", 10)).toEqual([]);
  });

  test("prune with nothing expired deletes nothing and returns 0", async () => {
    await insert("evt-1", 5000);

    expect(await deleteTelemetryOutboxEventsBefore(5000)).toBe(0);

    expect(await allIds()).toEqual(["evt-1"]);
  });

  test("prune returns 0 when the telemetry DB is unavailable", async () => {
    await insert("evt-1", 1000);

    await withTelemetryDbUnavailable(async () => {
      expect(await deleteTelemetryOutboxEventsBefore(2000)).toBe(0);
    });

    expect(await allIds()).toEqual(["evt-1"]);
  });

  test("discards all pending rows for one name only", async () => {
    await insert("evt-1", 1000, "lifecycle");
    await insert("evt-2", 2000, "lifecycle");
    await insert("evt-other", 1000, "watchdog");

    await discardPendingTelemetryOutboxEvents("lifecycle");

    expect(await allIds()).toEqual([]);
    expect(
      (await queryTelemetryOutboxBatch("watchdog", 10)).map((r) => r.id),
    ).toEqual(["evt-other"]);
  });
});
