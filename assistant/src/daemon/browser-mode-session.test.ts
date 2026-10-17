import { afterEach, describe, expect, test } from "bun:test";

import { setOverridesForTesting } from "../__tests__/feature-flag-test-helpers.js";
import type { ModeSession } from "../api/mode-session.js";
import { isSessionGroupsEnabled } from "../config/session-groups-gate.js";
import { BrowserModeSessionProducer } from "./browser-mode-session.js";
import type {
  ModeSessionSourceHandle,
  ModeSessionTerminalDisposition,
} from "./conversation-mode-session.js";

function createCoordinator() {
  let owner: ModeSession | undefined;
  let activation = 0;
  const activated: ModeSessionSourceHandle[] = [];
  const retired: Array<{
    handle: ModeSessionSourceHandle;
    disposition?: ModeSessionTerminalDisposition;
  }> = [];
  const activity: Array<{ turnId: string; at: number }> = [];

  const coordinator = {
    async activateSource(input: {
      sourceId: string;
      generation: number;
      mode: "browser";
      sourceStartedAt: number;
    }): Promise<ModeSessionSourceHandle> {
      activation += 1;
      const handle = {
        sourceId: input.sourceId,
        generation: input.generation,
        activation,
        id: `browser-${activation}`,
        mode: input.mode,
      } as const;
      activated.push(handle);
      return handle;
    },
    async claimTurn(
      _turnId: string,
      handle: ModeSessionSourceHandle,
      _at: number,
    ): Promise<ModeSession> {
      owner ??= { id: handle.id, mode: handle.mode };
      return owner;
    },
    getTurnOwner: () => owner,
    recordActivity: async (turnId: string, at: number) => {
      activity.push({ turnId, at });
      return true;
    },
    retireSource: async (
      handle: ModeSessionSourceHandle,
      disposition?: ModeSessionTerminalDisposition,
    ) => {
      retired.push({ handle, disposition });
      return true;
    },
  };

  return {
    coordinator,
    activated,
    retired,
    activity,
    clearOwner: () => {
      owner = undefined;
    },
    setOwner: (next: ModeSession) => {
      owner = next;
    },
  };
}

describe("BrowserModeSessionProducer", () => {
  afterEach(() => {
    setOverridesForTesting({});
  });

  test.each([false, true])(
    "retires failed admission while preserving a partial turn owner (%s)",
    async (partial) => {
      const state = createCoordinator();
      const claim = state.coordinator.claimTurn;
      state.coordinator.claimTurn = async (...args) => {
        if (partial) {
          await claim(...args);
        }
        throw new Error("tracking unavailable");
      };
      const producer = new BrowserModeSessionProducer(state.coordinator);
      await expect(
        producer.beginOperation({
          turnId: "turn-123",
          lifecycle: "action",
          at: 100,
        }),
      ).rejects.toThrow("tracking unavailable");
      expect(state.retired).toHaveLength(1);
      expect(state.retired[0]?.disposition).toMatchObject({
        status: "interrupted",
        endReason: "tracking_failed",
      });
      if (partial) {
        expect(state.coordinator.getTurnOwner()).toBeDefined();
      } else {
        expect(state.coordinator.getTurnOwner()).toBeUndefined();
      }
    },
  );

  test("admits new tracking only while the shared feature flag is enabled", async () => {
    const state = createCoordinator();
    const producer = new BrowserModeSessionProducer(
      state.coordinator,
      1,
      isSessionGroupsEnabled,
    );

    setOverridesForTesting({});
    expect(isSessionGroupsEnabled()).toBe(false);
    expect(
      await producer.beginOperation({
        turnId: "turn-disabled",
        lifecycle: "action",
        at: 100,
      }),
    ).toBeUndefined();
    expect(state.activated).toEqual([]);

    setOverridesForTesting({ "session-groups": true });
    const admitted = await producer.beginOperation({
      turnId: "turn-enabled",
      lifecycle: "action",
      at: 110,
    });
    expect(admitted?.owner).toEqual({ id: "browser-1", mode: "browser" });

    setOverridesForTesting({ "session-groups": false });
    state.clearOwner();
    const close = await producer.beginOperation({
      turnId: "turn-close",
      lifecycle: "terminal",
      at: 120,
    });
    expect(close?.owner).toEqual({ id: "browser-1", mode: "browser" });
    expect(
      await producer.finishOperation(close, {
        at: 130,
        isError: false,
        cancelled: false,
        terminalReason: "browser_closed",
      }),
    ).toBe(true);
    expect(state.retired).toHaveLength(1);
  });

  test("claims the first action and records repeated successful activity", async () => {
    const state = createCoordinator();
    const producer = new BrowserModeSessionProducer(state.coordinator);

    const first = await producer.beginOperation({
      turnId: "turn-1",
      lifecycle: "action",
      at: 100,
    });
    expect(first?.owner).toEqual({ id: "browser-1", mode: "browser" });
    expect(state.activated).toHaveLength(1);
    expect(
      await producer.finishOperation(first, {
        at: 120,
        isError: false,
        cancelled: false,
      }),
    ).toBe(true);
    expect(state.activity).toEqual([{ turnId: "turn-1", at: 120 }]);

    const repeated = await producer.beginOperation({
      turnId: "turn-1",
      lifecycle: "action",
      at: 130,
    });
    expect(repeated?.owner.id).toBe("browser-1");
    expect(state.activated).toHaveLength(1);
  });

  test("status and a terminal operation without an active run are inert", async () => {
    const state = createCoordinator();
    const producer = new BrowserModeSessionProducer(state.coordinator);

    expect(
      await producer.beginOperation({
        turnId: "turn-1",
        lifecycle: "status",
        at: 100,
      }),
    ).toBeUndefined();
    expect(
      await producer.beginOperation({
        turnId: "turn-1",
        lifecycle: "terminal",
        at: 110,
      }),
    ).toBeUndefined();
    expect(state.activated).toEqual([]);
  });

  test("keeps an existing non-browser owner without activating a nested run", async () => {
    const state = createCoordinator();
    state.setOwner({ id: "live-1", mode: "live_vision" });
    const producer = new BrowserModeSessionProducer(state.coordinator);

    const token = await producer.beginOperation({
      turnId: "turn-1",
      lifecycle: "action",
      at: 100,
    });
    expect(token).toMatchObject({ owner: { id: "live-1" } });
    expect(token?.handle).toBeUndefined();
    expect(state.activated).toEqual([]);
    expect(
      await producer.finishOperation(token, {
        at: 120,
        isError: false,
        cancelled: false,
      }),
    ).toBe(true);
    expect(state.activity).toEqual([{ turnId: "turn-1", at: 120 }]);
  });

  test("successful close retires the active run with a completed disposition", async () => {
    const state = createCoordinator();
    const producer = new BrowserModeSessionProducer(state.coordinator);
    await producer.beginOperation({
      turnId: "turn-1",
      lifecycle: "action",
      at: 100,
    });
    state.clearOwner();

    const close = await producer.beginOperation({
      turnId: "turn-close",
      lifecycle: "terminal",
      at: 200,
    });
    expect(close?.owner.id).toBe("browser-1");
    expect(
      await producer.finishOperation(close, {
        at: 220,
        isError: false,
        cancelled: false,
        terminalReason: "browser_closed",
      }),
    ).toBe(true);
    expect(state.retired).toEqual([
      {
        handle: expect.objectContaining({ id: "browser-1", activation: 1 }),
        disposition: {
          status: "completed",
          endReason: "browser_closed",
        },
      },
    ]);
  });

  test("a foreign-owned terminal operation retires only the captured browser run", async () => {
    const state = createCoordinator();
    const producer = new BrowserModeSessionProducer(state.coordinator);
    await producer.beginOperation({
      turnId: "turn-browser",
      lifecycle: "action",
      at: 100,
    });
    state.setOwner({ id: "live-1", mode: "live_vision" });

    const close = await producer.beginOperation({
      turnId: "turn-live",
      lifecycle: "terminal",
      at: 200,
    });
    expect(close).toMatchObject({
      owner: { id: "live-1", mode: "live_vision" },
      handle: { id: "browser-1", activation: 1 },
    });
    expect(
      await producer.finishOperation(close, {
        at: 220,
        isError: false,
        cancelled: false,
        terminalReason: "browser_detached",
      }),
    ).toBe(true);
    expect(state.retired.at(-1)).toEqual({
      handle: expect.objectContaining({ id: "browser-1", activation: 1 }),
      disposition: {
        status: "completed",
        endReason: "browser_detached",
      },
    });

    state.clearOwner();
    await producer.beginOperation({
      turnId: "turn-browser-2",
      lifecycle: "action",
      at: 300,
    });
    expect(
      await producer.finishOperation(close, {
        at: 320,
        isError: true,
        cancelled: false,
      }),
    ).toBe(false);
    expect(state.retired).toHaveLength(1);
  });

  test("a failed close keeps the session active until a successful retry", async () => {
    const state = createCoordinator();
    const producer = new BrowserModeSessionProducer(state.coordinator);
    const action = await producer.beginOperation({
      turnId: "turn-1",
      lifecycle: "action",
      at: 100,
    });
    const close = await producer.beginOperation({
      turnId: "turn-1",
      lifecycle: "terminal",
      at: 110,
    });
    expect(
      await producer.finishOperation(close, {
        at: 120,
        isError: true,
        cancelled: false,
      }),
    ).toBe(true);
    expect(state.retired).toHaveLength(0);
    expect(state.activity).toEqual([{ turnId: "turn-1", at: 120 }]);

    const retry = await producer.beginOperation({
      turnId: "turn-1",
      lifecycle: "terminal",
      at: 130,
    });
    expect(retry?.handle).toEqual(action?.handle);
    await producer.finishOperation(retry, {
      at: 140,
      isError: false,
      cancelled: false,
    });
    expect(state.retired[0]?.disposition).toEqual({
      status: "completed",
      endReason: "browser_closed",
    });
  });

  test("cancellation retires the exact run while accepted output remains on its captured turn", async () => {
    const state = createCoordinator();
    const producer = new BrowserModeSessionProducer(state.coordinator);
    const stale = await producer.beginOperation({
      turnId: "turn-1",
      lifecycle: "action",
      at: 100,
    });
    expect(
      await producer.finishOperation(stale, {
        at: 120,
        isError: true,
        cancelled: true,
      }),
    ).toBe(true);
    expect(state.retired[0]?.disposition).toEqual({
      status: "interrupted",
      endReason: "browser_operation_cancelled",
    });

    state.clearOwner();
    const current = await producer.beginOperation({
      turnId: "turn-2",
      lifecycle: "action",
      at: 200,
    });
    expect(current?.handle?.activation).toBe(2);
    expect(
      await producer.finishOperation(stale, {
        at: 210,
        isError: true,
        cancelled: true,
      }),
    ).toBe(false);
    expect(
      await producer.finishOperation(stale, {
        at: 220,
        isError: false,
        cancelled: false,
      }),
    ).toBe(true);
    expect(state.activity).toEqual([{ turnId: "turn-1", at: 220 }]);
    expect(state.retired).toHaveLength(1);
  });
});
