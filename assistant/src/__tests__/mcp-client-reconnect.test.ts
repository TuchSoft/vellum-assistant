import { describe, expect, jest, mock, test } from "bun:test";

import { StreamableHTTPError } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { ErrorCode, McpError } from "@modelcontextprotocol/sdk/types.js";

// Mock secure-keys so the MCP OAuth provider doesn't try to access the
// credential store when connect() probes for cached tokens.
mock.module("../security/secure-keys.js", () => ({
  getSecureKeyAsync: jest.fn().mockResolvedValue(null),
  setSecureKeyAsync: jest.fn().mockResolvedValue(true),
  deleteSecureKeyAsync: jest.fn().mockResolvedValue("deleted"),
  listSecureKeysAsync: jest.fn().mockResolvedValue([]),
}));

mock.module("../mcp/mcp-header-store.js", () => ({
  getMcpHeaders: jest.fn().mockResolvedValue(null),
  migrateLegacyMcpHeaders: jest.fn().mockResolvedValue(undefined),
}));

mock.module("../config/env-registry.js", () => ({
  getDebugStdoutLogs: () => false,
  getIsContainerized: () => false,
  getIsPlatform: () => false,
  isPlatformRemote: () => false,
  getWorkspaceDirOverride: () => process.env.VELLUM_WORKSPACE_DIR,
  getBackupDirOverride: () => undefined,
  getBackupKeyPathOverride: () => undefined,
  getCpuLimit: () => undefined,
  getMinikubeStorageSize: () => undefined,
  getProfilerRunId: () => undefined,
  getProfilerMode: () => undefined,
  getProfilerMaxBytes: () => undefined,
  getProfilerMaxRuns: () => undefined,
  getProfilerMinFreeMb: () => undefined,
  checkUnrecognizedEnvVars: () => [],
}));

const { McpClient } = await import("../mcp/client.js");

const httpTransport = {
  type: "streamable-http" as const,
  url: "https://example.com/mcp",
};

interface FakeSdkClient {
  connectCalls: number;
  closeCalls: number;
  callToolCalls: number;
  connect: () => Promise<void>;
  close: () => Promise<void>;
  callTool: () => Promise<unknown>;
}

function fakeSdkClient(options?: {
  connectError?: Error;
  callToolError?: Error;
  text?: string;
}): FakeSdkClient {
  const fake: FakeSdkClient = {
    connectCalls: 0,
    closeCalls: 0,
    callToolCalls: 0,
    async connect() {
      fake.connectCalls++;
      if (options?.connectError) {
        throw options.connectError;
      }
    },
    async close() {
      fake.closeCalls++;
    },
    async callTool() {
      fake.callToolCalls++;
      if (options?.callToolError) {
        throw options.callToolError;
      }
      return { content: [{ type: "text", text: options?.text ?? "ok" }] };
    },
  };
  return fake;
}

/** Client wired to a first fake SDK client, already connected. */
async function connectedClient(first: FakeSdkClient): Promise<{
  client: InstanceType<typeof McpClient>;
  setNextSdkClient: (next: FakeSdkClient) => void;
  createSdkClientCalls: () => number;
}> {
  const client = new McpClient("test-server");
  (client as any).createTransport = () => ({});
  (client as any).client = first;
  let creates = 0;
  let next: FakeSdkClient | null = null;
  (client as any).createSdkClient = () => {
    creates++;
    return next;
  };
  await client.connect(httpTransport);
  return {
    client,
    setNextSdkClient: (n: FakeSdkClient) => {
      next = n;
    },
    createSdkClientCalls: () => creates,
  };
}

describe("McpClient self-healing reconnect", () => {
  test("reconnects lazily on the next call after the connection died", async () => {
    const first = fakeSdkClient({ text: "first" });
    const { client, setNextSdkClient, createSdkClientCalls } =
      await connectedClient(first);
    const second = fakeSdkClient({ text: "second" });
    setNextSdkClient(second);

    // Remote close observed via the SDK onclose handler
    (client as any).connected = false;

    const result = await client.callTool("tool", {});
    expect(result.content).toBe("second");
    expect(first.closeCalls).toBe(1);
    expect(second.connectCalls).toBe(1);
    expect(second.callToolCalls).toBe(1);
    expect(createSdkClientCalls()).toBe(1);
  });

  test("reconnects and retries once when a call fails with an expired session (404)", async () => {
    const first = fakeSdkClient({
      callToolError: new StreamableHTTPError(404, "Session not found"),
    });
    const { client, setNextSdkClient } = await connectedClient(first);
    const second = fakeSdkClient({ text: "recovered" });
    setNextSdkClient(second);

    const result = await client.callTool("tool", {});
    expect(result.content).toBe("recovered");
    expect(first.callToolCalls).toBe(1);
    expect(second.connectCalls).toBe(1);
    expect(second.callToolCalls).toBe(1);
  });

  test("does not reconnect on protocol-level errors (server answered)", async () => {
    const first = fakeSdkClient({
      callToolError: new McpError(ErrorCode.InvalidParams, "bad args"),
    });
    const { client, setNextSdkClient, createSdkClientCalls } =
      await connectedClient(first);
    setNextSdkClient(fakeSdkClient());

    await expect(client.callTool("tool", {})).rejects.toThrow("bad args");
    expect(createSdkClientCalls()).toBe(0);
    expect(first.closeCalls).toBe(0);
  });

  test("does not reconnect on auth failures (401)", async () => {
    const first = fakeSdkClient({
      callToolError: new StreamableHTTPError(401, "Unauthorized"),
    });
    const { client, setNextSdkClient, createSdkClientCalls } =
      await connectedClient(first);
    setNextSdkClient(fakeSdkClient());

    await expect(client.callTool("tool", {})).rejects.toThrow("Unauthorized");
    expect(createSdkClientCalls()).toBe(0);
  });

  test("propagates the original error when the reconnect fails", async () => {
    const first = fakeSdkClient({
      callToolError: new StreamableHTTPError(404, "Session not found"),
    });
    const { client, setNextSdkClient } = await connectedClient(first);
    // Reconnect target refuses the handshake with a non-auth error
    setNextSdkClient(
      fakeSdkClient({ connectError: new Error("ECONNREFUSED") }),
    );

    await expect(client.callTool("tool", {})).rejects.toThrow(
      "Session not found",
    );
  });

  test("concurrent calls share a single reconnect attempt", async () => {
    const first = fakeSdkClient();
    const { client, setNextSdkClient, createSdkClientCalls } =
      await connectedClient(first);
    const second = fakeSdkClient({ text: "shared" });
    setNextSdkClient(second);
    (client as any).connected = false;

    const [a, b] = await Promise.all([
      client.callTool("tool", {}),
      client.callTool("tool", {}),
    ]);
    expect(a.content).toBe("shared");
    expect(b.content).toBe("shared");
    expect(createSdkClientCalls()).toBe(1);
    expect(second.connectCalls).toBe(1);
  });

  test("an intentionally disconnected client does not self-heal", async () => {
    const first = fakeSdkClient();
    const { client, setNextSdkClient, createSdkClientCalls } =
      await connectedClient(first);
    setNextSdkClient(fakeSdkClient());

    await client.disconnect();
    await expect(client.callTool("tool", {})).rejects.toThrow(
      'MCP client "test-server" is not connected',
    );
    expect(createSdkClientCalls()).toBe(0);
  });
});
