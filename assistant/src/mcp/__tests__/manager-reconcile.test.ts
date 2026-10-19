import { beforeEach, describe, expect, mock, test } from "bun:test";

import type { ResolvedMcpConfig } from "../../config/schemas/mcp.js";

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

interface FakeClient {
  serverId: string;
  instanceIndex: number;
  connected: boolean;
  connectCalls: number;
  disconnectCalls: number;
  calls: Array<Record<string, unknown>>;
}

let behavior = {
  connectDelayMs: 0,
  connectSucceeds: true,
  callDelayMs: 0,
};
const instances: FakeClient[] = [];

mock.module("../../config/loader.js", () => ({
  getConfig: () => ({ tools: {} }),
}));

mock.module("../client.js", () => ({
  McpClient: class {
    readonly serverId: string;
    readonly instanceIndex: number;
    connected = false;
    connectCalls = 0;
    disconnectCalls = 0;
    readonly calls: Array<Record<string, unknown>> = [];
    constructor(serverId: string) {
      this.serverId = serverId;
      this.instanceIndex = instances.length + 1;
      instances.push(this as unknown as FakeClient);
    }
    get isConnected() {
      return this.connected;
    }
    get lastError() {
      return null;
    }
    async connect() {
      this.connectCalls++;
      if (behavior.connectDelayMs > 0) {
        await sleep(behavior.connectDelayMs);
      }
      this.connected = behavior.connectSucceeds;
    }
    async disconnect() {
      this.disconnectCalls++;
      this.connected = false;
    }
    async listTools() {
      return [
        {
          name: "tool",
          description: "a tool",
          inputSchema: { type: "object", properties: {} },
        },
      ];
    }
    async callTool(_name: string, args: Record<string, unknown>) {
      this.calls.push(args);
      if (behavior.callDelayMs > 0) {
        await sleep(behavior.callDelayMs);
      }
      return {
        content: `from-${this.serverId}#${this.instanceIndex}`,
        isError: false,
      };
    }
  },
}));

const { McpServerManager } = await import("../manager.js");

function makeConfig(
  servers: Record<string, { url: string }>,
): ResolvedMcpConfig {
  const resolved: Record<string, unknown> = {};
  for (const [id, s] of Object.entries(servers)) {
    resolved[id] = {
      transport: { type: "streamable-http", url: s.url },
      defaultRiskLevel: "low",
      source: "workspace",
    };
  }
  return { servers: resolved } as unknown as ResolvedMcpConfig;
}

describe("McpServerManager.reconcile", () => {
  beforeEach(() => {
    instances.length = 0;
    behavior = { connectDelayMs: 0, connectSucceeds: true, callDelayMs: 0 };
  });

  test("reuses a healthy server with unchanged config without reconnecting", async () => {
    const manager = new McpServerManager();
    const config = makeConfig({ alpha: { url: "https://a/mcp" } });
    await manager.start(config);
    expect(instances.length).toBe(1);

    const result = await manager.reconcile(config);

    expect(instances.length).toBe(1);
    expect(result.kept).toEqual(["alpha"]);
    expect(result.connected).toEqual([]);
    expect(result.failed).toEqual([]);
    expect(result.removed).toEqual([]);
  });

  test("reconnects a server whose config changed and retires the old client", async () => {
    const manager = new McpServerManager();
    await manager.start(makeConfig({ alpha: { url: "https://a/mcp" } }));

    const result = await manager.reconcile(
      makeConfig({ alpha: { url: "https://a/v2/mcp" } }),
    );

    expect(instances.length).toBe(2);
    expect(result.connected).toHaveLength(1);
    expect(result.kept).toEqual([]);
    expect(instances[0].disconnectCalls).toBe(1);
    // Calls route to the new client
    const res = await manager.callTool("alpha", "tool", {});
    expect(res.content).toBe("from-alpha#2");
  });

  test("queues calls arriving during the swap and releases them onto the new client", async () => {
    const manager = new McpServerManager();
    await manager.start(makeConfig({ alpha: { url: "https://a/mcp" } }));

    behavior.connectDelayMs = 100;
    const reconcilePromise = manager.reconcile(
      makeConfig({ alpha: { url: "https://a/v2/mcp" } }),
    );

    let settled = false;
    const callPromise = manager.callTool("alpha", "tool", {}).then((r) => {
      settled = true;
      return r;
    });
    await sleep(30);
    expect(settled).toBe(false);

    const [result, callResult] = await Promise.all([
      reconcilePromise,
      callPromise,
    ]);
    expect(result.connected).toHaveLength(1);
    // Served by the new client: a call that ran before the swap would have
    // hit instance #1.
    expect(callResult.content).toBe("from-alpha#2");
  });

  test("waits for in-flight calls to drain before swapping", async () => {
    const manager = new McpServerManager();
    await manager.start(makeConfig({ alpha: { url: "https://a/mcp" } }));

    const events: string[] = [];
    behavior.callDelayMs = 100;
    const callPromise = manager.callTool("alpha", "tool", {}).then((r) => {
      events.push("call");
      return r;
    });

    const reconcilePromise = manager
      .reconcile(makeConfig({ alpha: { url: "https://a/v2/mcp" } }))
      .then(() => {
        events.push("reconcile");
      });

    const [callResult] = await Promise.all([callPromise, reconcilePromise]);
    expect(events).toEqual(["call", "reconcile"]);
    // The call started before the swap and was served by the old client.
    expect(callResult.content).toBe("from-alpha#1");
    expect(instances[0].disconnectCalls).toBe(1);
  });

  test("runs the delta callback before releasing queued calls", async () => {
    const manager = new McpServerManager();
    await manager.start(makeConfig({ alpha: { url: "https://a/mcp" } }));

    behavior.connectDelayMs = 80;
    const events: string[] = [];
    const reconcilePromise = manager.reconcile(
      makeConfig({ alpha: { url: "https://a/v2/mcp" } }),
      () => {
        events.push("delta");
      },
    );
    const callPromise = manager.callTool("alpha", "tool", {}).then(() => {
      events.push("call");
    });

    await Promise.all([reconcilePromise, callPromise]);
    expect(events).toEqual(["delta", "call"]);
  });

  test("disconnects servers that disappear from the config", async () => {
    const manager = new McpServerManager();
    await manager.start(
      makeConfig({
        alpha: { url: "https://a/mcp" },
        beta: { url: "https://b/mcp" },
      }),
    );

    const result = await manager.reconcile(
      makeConfig({ alpha: { url: "https://a/mcp" } }),
    );

    expect(result.kept).toEqual(["alpha"]);
    expect(result.removed).toEqual(["beta"]);
    expect(instances[1].disconnectCalls).toBe(1);
    await expect(manager.callTool("beta", "tool", {})).rejects.toThrow(
      'MCP server "beta" not found',
    );
  });

  test("keeps serving through the old client when a refresh fails but it still works", async () => {
    const manager = new McpServerManager();
    await manager.start(makeConfig({ alpha: { url: "https://a/mcp" } }));

    behavior.connectSucceeds = false;
    const result = await manager.reconcile(
      makeConfig({ alpha: { url: "https://a/v2/mcp" } }),
    );

    expect(result.kept).toEqual(["alpha"]);
    expect(result.failed).toEqual([]);
    const res = await manager.callTool("alpha", "tool", {});
    expect(res.content).toBe("from-alpha#1");
  });

  test("reports a server as failed when its client is dead and reconnect fails", async () => {
    const manager = new McpServerManager();
    await manager.start(makeConfig({ alpha: { url: "https://a/mcp" } }));
    instances[0].connected = false;
    behavior.connectSucceeds = false;

    const result = await manager.reconcile(
      makeConfig({ alpha: { url: "https://a/mcp" } }),
    );

    expect(result.failed).toEqual([{ id: "alpha" }]);
    expect(result.kept).toEqual([]);
    expect(instances[0].disconnectCalls).toBe(1);
  });
});
