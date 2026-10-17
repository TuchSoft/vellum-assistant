import { beforeEach, describe, expect, test } from "bun:test";

import { describePg } from "../../__tests__/pg-test-db.js";
import {
  CLIENT_CONNECTION_EVENT_RETENTION_MS,
  CLIENT_CONNECTION_FLAP_WINDOW_MS,
  type ClientConnectionEvent,
  coalesceClientConnectionSessions,
  listClientConnectionHistory,
  recordClientConnectionEvent,
} from "../client-connection-events-store.js";
import { requireMainDb } from "../db-facade.js";
import { initializeDb } from "../db-init.js";

await initializeDb();

async function clearEvents(): Promise<void> {
  await requireMainDb().run("DELETE FROM client_connection_events");
}

function event(
  overrides: Partial<ClientConnectionEvent> &
    Pick<ClientConnectionEvent, "reason" | "occurredAt">,
): ClientConnectionEvent {
  return {
    id: overrides.id ?? `evt-${overrides.occurredAt}`,
    clientId: overrides.clientId ?? "client-123",
    interfaceId: overrides.interfaceId ?? "chrome-extension",
    connectionId: overrides.connectionId ?? `conn-${overrides.occurredAt}`,
    reason: overrides.reason,
    occurredAt: overrides.occurredAt,
    actorPrincipalId: overrides.actorPrincipalId ?? "user-123",
    clientVersion: overrides.clientVersion ?? "0.12.1",
    sseWatchdog: overrides.sseWatchdog ?? true,
    machineName: overrides.machineName ?? null,
  };
}

describe("coalesceClientConnectionSessions", () => {
  test("merges a reconnect shorter than the flap window", () => {
    const sessions = coalesceClientConnectionSessions(
      [
        event({
          reason: "sse_open",
          occurredAt: 1_000,
          connectionId: "conn-1",
        }),
        event({
          reason: "stale_replaced",
          occurredAt: 2_000,
          connectionId: "conn-1",
        }),
        event({
          reason: "sse_open",
          occurredAt: 2_000 + CLIENT_CONNECTION_FLAP_WINDOW_MS - 1,
          connectionId: "conn-2",
        }),
      ],
      10_000 + CLIENT_CONNECTION_FLAP_WINDOW_MS,
    );

    expect(sessions).toHaveLength(1);
    expect(sessions[0].flapCount).toBe(1);
    expect(sessions[0].endedAt).toBeNull();
    expect(sessions[0].connectionIds).toHaveLength(2);
  });

  test("keeps a gap at or beyond the flap window as a separate session", () => {
    const sessions = coalesceClientConnectionSessions([
      event({ reason: "sse_open", occurredAt: 1_000 }),
      event({ reason: "sse_close", occurredAt: 2_000 }),
      event({
        reason: "sse_open",
        occurredAt: 2_000 + CLIENT_CONNECTION_FLAP_WINDOW_MS,
      }),
    ]);

    expect(sessions).toHaveLength(2);
    expect(sessions.every((session) => session.flapCount === 0)).toBe(true);
  });

  test("leaves an unmatched open as a still-connected session", () => {
    const now = 8_000;
    const sessions = coalesceClientConnectionSessions(
      [event({ reason: "sse_open", occurredAt: 1_000 })],
      now,
    );

    expect(sessions).toHaveLength(1);
    expect(sessions[0].endedAt).toBeNull();
    expect(sessions[0].durationMs).toBe(7_000);
    expect(sessions[0].closeReason).toBeNull();
  });

  test("ends an orphaned open when a later open arrives with no close", () => {
    const sessions = coalesceClientConnectionSessions(
      [
        event({
          reason: "sse_open",
          occurredAt: 1_000,
          connectionId: "conn-1",
        }),
        event({
          reason: "sse_open",
          occurredAt: 5_000,
          connectionId: "conn-2",
        }),
      ],
      8_000,
    );

    expect(sessions).toHaveLength(2);
    expect(sessions[1].startedAt).toBe(1_000);
    expect(sessions[1].endedAt).toBe(5_000);
    expect(sessions[1].closeReason).toBe("implicit_replaced");
    expect(sessions[1].durationMs).toBe(4_000);
    expect(sessions[0].startedAt).toBe(5_000);
    expect(sessions[0].endedAt).toBeNull();
    expect(sessions[0].durationMs).toBe(3_000);
  });
});

describePg("recordClientConnectionEvent / listClientConnectionHistory", () => {
  beforeEach(async () => {
    await clearEvents();
  });

  test("writes events and returns coalesced sessions", async () => {
    const t0 = 1_700_000_000_000;

    await recordClientConnectionEvent({
      clientId: "client-123",
      interfaceId: "chrome-extension",
      connectionId: "conn-1",
      reason: "sse_open",
      occurredAt: t0,
      actorPrincipalId: "user-123",
      clientVersion: "0.12.1",
      sseWatchdog: true,
    });
    await recordClientConnectionEvent({
      clientId: "client-123",
      interfaceId: "chrome-extension",
      connectionId: "conn-1",
      reason: "stale_replaced",
      occurredAt: t0 + 5_000,
      actorPrincipalId: "user-123",
    });
    await recordClientConnectionEvent({
      clientId: "client-123",
      interfaceId: "chrome-extension",
      connectionId: "conn-2",
      reason: "sse_open",
      occurredAt: t0 + 6_000,
      actorPrincipalId: "user-123",
      clientVersion: "0.12.1",
      sseWatchdog: true,
    });

    const history = await listClientConnectionHistory({
      clientId: "client-123",
      now: t0 + 10_000,
    });

    expect(history.events).toHaveLength(3);
    expect(history.sessions).toHaveLength(1);
    expect(history.sessions[0].flapCount).toBe(1);
    expect(history.sessions[0].endedAt).toBeNull();
    expect(history.sessions[0].sseWatchdog).toBe(true);
    expect(history.sessions[0].clientVersion).toBe("0.12.1");
  });

  test("prunes rows older than the retention window", async () => {
    const now = 1_700_000_000_000;

    await recordClientConnectionEvent({
      clientId: "client-123",
      interfaceId: "chrome-extension",
      connectionId: "conn-old",
      reason: "sse_open",
      occurredAt: now - CLIENT_CONNECTION_EVENT_RETENTION_MS - 1,
    });
    await recordClientConnectionEvent({
      clientId: "client-123",
      interfaceId: "chrome-extension",
      connectionId: "conn-new",
      reason: "sse_open",
      occurredAt: now,
    });

    const history = await listClientConnectionHistory({ now });
    expect(history.events).toHaveLength(1);
    expect(history.events[0].connectionId).toBe("conn-new");
  });

  test("does not throw when listing without an injected database", async () => {
    const history = await listClientConnectionHistory();
    expect(Array.isArray(history.events)).toBe(true);
    expect(Array.isArray(history.sessions)).toBe(true);
  });

  test("preserves a session that opened before the since bound", async () => {
    const t0 = 1_700_000_000_000;

    await recordClientConnectionEvent({
      clientId: "client-123",
      interfaceId: "chrome-extension",
      connectionId: "conn-1",
      reason: "sse_open",
      occurredAt: t0,
      actorPrincipalId: "user-123",
    });
    await recordClientConnectionEvent({
      clientId: "client-123",
      interfaceId: "chrome-extension",
      connectionId: "conn-1",
      reason: "sse_close",
      occurredAt: t0 + 8_000,
      actorPrincipalId: "user-123",
    });

    const history = await listClientConnectionHistory({
      clientId: "client-123",
      since: t0 + 5_000,
      now: t0 + 10_000,
    });

    expect(history.sessions).toHaveLength(1);
    expect(history.sessions[0].startedAt).toBe(t0);
    expect(history.sessions[0].endedAt).toBe(t0 + 8_000);
    expect(history.sessions[0].durationMs).toBe(8_000);
    expect(history.events).toHaveLength(1);
    expect(history.events[0].reason).toBe("sse_close");
  });

  test("keeps a still-open session whose only event is before since", async () => {
    const t0 = 1_700_000_000_000;

    await recordClientConnectionEvent({
      clientId: "client-123",
      interfaceId: "chrome-extension",
      connectionId: "conn-1",
      reason: "sse_open",
      occurredAt: t0,
      actorPrincipalId: "user-123",
    });

    const history = await listClientConnectionHistory({
      clientId: "client-123",
      since: t0 + 5_000,
      now: t0 + 10_000,
    });

    expect(history.sessions).toHaveLength(1);
    expect(history.sessions[0].startedAt).toBe(t0);
    expect(history.sessions[0].endedAt).toBeNull();
    expect(history.sessions[0].durationMs).toBe(10_000);
    expect(history.events).toHaveLength(0);
  });

  test("omits a session that ended before the since bound", async () => {
    const t0 = 1_700_000_000_000;

    await recordClientConnectionEvent({
      clientId: "client-123",
      interfaceId: "chrome-extension",
      connectionId: "conn-old",
      reason: "sse_open",
      occurredAt: t0,
      actorPrincipalId: "user-123",
    });
    await recordClientConnectionEvent({
      clientId: "client-123",
      interfaceId: "chrome-extension",
      connectionId: "conn-old",
      reason: "sse_close",
      occurredAt: t0 + 1_000,
      actorPrincipalId: "user-123",
    });

    const history = await listClientConnectionHistory({
      clientId: "client-123",
      since: t0 + 5_000,
      now: t0 + 10_000,
    });

    expect(history.sessions).toHaveLength(0);
    expect(history.events).toHaveLength(0);
  });
});
