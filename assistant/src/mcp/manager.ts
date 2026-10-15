import { getConfig } from "../config/loader.js";
import type {
  ResolvedMcpConfig,
  ResolvedMcpServerConfig,
} from "../config/schemas/mcp.js";
import { getLogger } from "../util/logger.js";
import { McpClient, type McpToolInfo } from "./client.js";
import {
  applyMcpToolCaps,
  resolveMcpGlobalMaxTools,
  truncatedServerIdsFromCaps,
} from "./tool-caps.js";

const log = getLogger("mcp-manager");

export interface McpServerToolInfo {
  serverId: string;
  serverConfig: ResolvedMcpServerConfig;
  tools: McpToolInfo[];
}

export interface McpStartResult {
  servers: McpServerToolInfo[];
  configuredServerCount: number;
  connectedServerCount: number;
  errorServerCount: number;
  needsAuthServerCount: number;
  discoveredToolCount: number;
  keptToolCount: number;
  droppedToolCount: number;
  truncatedServerIds: string[];
}

export type McpConnectionState =
  | "connecting"
  | "connected"
  | "needs-auth"
  | "error";

export type McpUnexpectedCloseHandler = () => void;

export interface McpReconcileServerFailure {
  id: string;
}

export interface McpReconcileResult {
  /** Servers with a freshly connected client and a current tool list. */
  connected: McpServerToolInfo[];
  /** Servers kept as-is: the existing healthy client was reused. */
  kept: string[];
  /** Servers present in config but with no working connection. */
  failed: McpReconcileServerFailure[];
  /** Servers that were connected before and no longer appear in config. */
  removed: string[];
}

/** How long a swap waits for in-flight tool calls before proceeding anyway. */
const WRITE_LEASE_DRAIN_TIMEOUT_MS = 30_000;

export class McpServerManager {
  private clients = new Map<string, McpClient>();
  private serverConfigs = new Map<string, ResolvedMcpServerConfig>();
  private connectionStates = new Map<
    string,
    { source: ResolvedMcpServerConfig["source"]; state: McpConnectionState }
  >();

  /** In-flight tool calls holding the read side of the gate. */
  private inFlightCalls = 0;
  /** True while a reconcile holds the write lease: new calls queue. */
  private writeLeaseHeld = false;
  /** Resolvers for calls queued behind the write lease. */
  private leaseWaiters: Array<() => void> = [];
  /** Resolvers waiting for in-flight calls to drain. */
  private drainWaiters: Array<() => void> = [];

  constructor(private onUnexpectedClose?: McpUnexpectedCloseHandler) {}

  setUnexpectedCloseHandler(handler: McpUnexpectedCloseHandler): void {
    this.onUnexpectedClose = handler;
  }

  async start(config: ResolvedMcpConfig): Promise<McpStartResult> {
    const entries = Object.entries(config.servers);
    log.info(
      { configuredServerCount: entries.length },
      "Starting configured MCP servers",
    );
    console.log(`[MCP] Starting ${entries.length} server(s)...`);

    const started = await Promise.all(
      entries.map(([serverId, serverConfig]) =>
        this.startOne(serverId, serverConfig),
      ),
    );
    const connected = started.filter(
      (result): result is McpServerToolInfo => result != null,
    );
    const errorServerCount = [...this.connectionStates.values()].filter(
      (entry) => entry.state === "error",
    ).length;
    const needsAuthServerCount = [...this.connectionStates.values()].filter(
      (entry) => entry.state === "needs-auth",
    ).length;

    const capped = applyMcpToolCaps(
      connected.map((result) => ({
        serverId: result.serverId,
        tools: result.tools,
      })),
      { globalMax: resolveMcpGlobalMaxTools(getConfig().tools) },
    );
    const keptByServer = new Map(
      capped.servers.map((server) => [server.serverId, server.tools]),
    );
    const results = connected.map((result) => ({
      ...result,
      tools: keptByServer.get(result.serverId) ?? [],
    }));
    const truncatedServerIds = truncatedServerIdsFromCaps(capped.decisions);

    if (capped.droppedToolCount > 0) {
      log.warn(
        {
          configuredServerCount: entries.length,
          connectedServerCount: connected.length,
          errorServerCount,
          needsAuthServerCount,
          discoveredToolCount: capped.discoveredToolCount,
          keptToolCount: capped.keptToolCount,
          droppedToolCount: capped.droppedToolCount,
          globalCap: capped.globalCap,
          perServerCap: capped.perServerCap,
          truncatedServerIds,
          decisions: capped.decisions.filter(
            (decision) =>
              decision.droppedByPerServerCap > 0 ||
              decision.droppedByGlobalCap > 0,
          ),
        },
        "MCP tool caps dropped tools using fair per-server selection",
      );
    } else {
      log.info(
        {
          configuredServerCount: entries.length,
          connectedServerCount: connected.length,
          errorServerCount,
          needsAuthServerCount,
          discoveredToolCount: capped.discoveredToolCount,
          keptToolCount: capped.keptToolCount,
          globalCap: capped.globalCap,
          perServerCap: capped.perServerCap,
        },
        "MCP servers connected",
      );
    }

    return {
      servers: results,
      configuredServerCount: entries.length,
      connectedServerCount: connected.length,
      errorServerCount,
      needsAuthServerCount,
      discoveredToolCount: capped.discoveredToolCount,
      keptToolCount: capped.keptToolCount,
      droppedToolCount: capped.droppedToolCount,
      truncatedServerIds,
    };
  }

  private async startOne(
    serverId: string,
    serverConfig: ResolvedMcpServerConfig,
  ): Promise<McpServerToolInfo | null> {
    this.connectionStates.set(serverId, {
      source: serverConfig.source,
      state: "connecting",
    });
    try {
      console.log(
        `[MCP] Starting server "${serverId}" (transport: ${serverConfig.transport.type})`,
      );
      if (
        serverConfig.transport.type === "sse" ||
        serverConfig.transport.type === "streamable-http"
      ) {
        log.debug(
          { serverId },
          "HTTP transport: OAuth provider will be available if server requires authentication",
        );
      }
      const client = new McpClient(serverId, serverConfig, () => {
        if (this.clients.get(serverId) !== client) {
          return;
        }
        this.connectionStates.set(serverId, {
          source: serverConfig.source,
          state: "error",
        });
        this.onUnexpectedClose?.();
      });
      await client.connect(serverConfig.transport);

      if (!client.isConnected) {
        this.connectionStates.set(serverId, {
          source: serverConfig.source,
          state: client.lastError ? "error" : "needs-auth",
        });
        return null;
      }

      this.clients.set(serverId, client);
      this.serverConfigs.set(serverId, serverConfig);

      const tools = await client.listTools();
      if (!client.isConnected || this.clients.get(serverId) !== client) {
        this.clients.delete(serverId);
        this.serverConfigs.delete(serverId);
        this.connectionStates.set(serverId, {
          source: serverConfig.source,
          state: "error",
        });
        return null;
      }
      log.info(
        { serverId, toolCount: tools.length },
        "MCP server tools discovered",
      );

      this.connectionStates.set(serverId, {
        source: serverConfig.source,
        state: "connected",
      });
      return { serverId, serverConfig, tools };
    } catch (err) {
      this.connectionStates.set(serverId, {
        source: serverConfig.source,
        state: "error",
      });
      console.error(`[MCP] Failed to connect to server "${serverId}":`, err);
      log.error({ err, serverId }, "Failed to connect to MCP server");
      const staleClient = this.clients.get(serverId);
      if (staleClient) {
        try {
          await staleClient.disconnect();
        } catch {
          /* ignore */
        }
        this.clients.delete(serverId);
        this.serverConfigs.delete(serverId);
      }
      return null;
    }
  }

  async stop(): Promise<void> {
    const disconnects = Array.from(this.clients.values()).map((client) =>
      client.disconnect().catch((err) => {
        log.warn(
          { err, serverId: client.serverId },
          "Error disconnecting MCP server",
        );
      }),
    );
    await Promise.all(disconnects);
    this.clients.clear();
    this.serverConfigs.clear();
    this.connectionStates.clear();
    log.info("All MCP servers disconnected");
  }

  async callTool(
    serverId: string,
    toolName: string,
    args: Record<string, unknown>,
    signal?: AbortSignal,
  ) {
    // Queued behind a running swap: released once the new client map (and,
    // via the reconcile delta callback, the registry) already reflect the
    // new state, so a call never lands in the teardown window.
    await this.enterCall();
    try {
      if (signal?.aborted) {
        throw new DOMException("The operation was aborted", "AbortError");
      }
      const client = this.clients.get(serverId);
      if (!client) {
        throw new Error(`MCP server "${serverId}" not found`);
      }
      return await client.callTool(toolName, args, signal);
    } finally {
      this.exitCall();
    }
  }

  /**
   * Bring the live client set in line with the given config without tearing
   * down healthy servers. A server whose config is unchanged and whose
   * client is still connected is reused untouched, so neither its connection
   * nor its registered tools move. Servers that died, changed config, or are
   * new get a fresh client.
   *
   * The reconcile runs under the write lease for its whole duration:
   * in-flight calls drain first, and calls arriving while new connections
   * are being built queue instead of hitting a server mid-replacement.
   * `applyDelta` runs after the client-map swap while the write lease is
   * still held. Registry updates belong there so they publish atomically
   * with the swap: a call released from the queue sees both or neither.
   * `applyDelta` must not call back into `callTool` (the lease is held).
   */
  async reconcile(
    config: ResolvedMcpConfig,
    applyDelta?: (result: McpReconcileResult) => void | Promise<void>,
  ): Promise<McpReconcileResult> {
    await this.acquireWriteLease();

    const connected: McpServerToolInfo[] = [];
    const kept: string[] = [];
    const failed: McpReconcileServerFailure[] = [];
    const removed: string[] = [];
    const nextClients = new Map<string, McpClient>();
    const nextConfigs = new Map<string, ResolvedMcpServerConfig>();
    const replacedClients = new Set<McpClient>();

    try {
      for (const [serverId, serverConfig] of Object.entries(config.servers)) {
        const existing = this.clients.get(serverId);
        const existingConfig = this.serverConfigs.get(serverId);
        if (
          existing &&
          existing.isConnected &&
          existingConfig &&
          JSON.stringify(existingConfig) === JSON.stringify(serverConfig)
        ) {
          kept.push(serverId);
          nextClients.set(serverId, existing);
          nextConfigs.set(serverId, serverConfig);
          continue;
        }

        try {
          const client = new McpClient(serverId, serverConfig, () => {
            if (this.clients.get(serverId) !== client) {
              return;
            }
            this.connectionStates.set(serverId, {
              source: serverConfig.source,
              state: "error",
            });
            this.onUnexpectedClose?.();
          });
          await client.connect(serverConfig.transport);
          if (!client.isConnected) {
            await client.disconnect().catch(() => {
              /* ignore cleanup errors */
            });
            if (existing && existing.isConnected) {
              // The refreshed connection failed but the old one still works:
              // keep serving through it rather than dropping the server.
              kept.push(serverId);
              nextClients.set(serverId, existing);
              if (existingConfig) {
                nextConfigs.set(serverId, existingConfig);
              }
            } else {
              failed.push({ id: serverId });
              this.connectionStates.set(serverId, {
                source: serverConfig.source,
                state: client.lastError ? "error" : "needs-auth",
              });
              if (existing) {
                replacedClients.add(existing);
              }
            }
            continue;
          }

          const tools = await client.listTools();
          connected.push({ serverId, serverConfig, tools });
          nextClients.set(serverId, client);
          nextConfigs.set(serverId, serverConfig);
          this.connectionStates.set(serverId, {
            source: serverConfig.source,
            state: "connected",
          });
          if (existing) {
            replacedClients.add(existing);
          }
        } catch (err) {
          log.error(
            { err, serverId },
            "Failed to connect to MCP server during reconcile",
          );
          if (existing && existing.isConnected) {
            kept.push(serverId);
            nextClients.set(serverId, existing);
            if (existingConfig) {
              nextConfigs.set(serverId, existingConfig);
            }
          } else {
            failed.push({ id: serverId });
            this.connectionStates.set(serverId, {
              source: serverConfig.source,
              state: "error",
            });
            if (existing) {
              replacedClients.add(existing);
            }
          }
        }
      }

      // Apply the shared fair cap across freshly connected servers; kept
      // servers already carry the capped set they connected with.
      const capped = applyMcpToolCaps(
        connected.map((result) => ({
          serverId: result.serverId,
          tools: result.tools,
        })),
        { globalMax: resolveMcpGlobalMaxTools(getConfig().tools) },
      );
      const keptByServer = new Map(
        capped.servers.map((server) => [server.serverId, server.tools]),
      );
      for (const result of connected) {
        result.tools = keptByServer.get(result.serverId) ?? [];
      }
      if (capped.droppedToolCount > 0) {
        const truncatedServerIds = truncatedServerIdsFromCaps(capped.decisions);
        log.warn(
          { droppedToolCount: capped.droppedToolCount, truncatedServerIds },
          "MCP reconcile dropped tools under the global cap",
        );
      }

      for (const [serverId, client] of this.clients) {
        if (!nextClients.has(serverId)) {
          // A server already reported as failed owns its own removal; listing
          // it here too would double-report it to the delta callback.
          if (!failed.some((f) => f.id === serverId)) {
            removed.push(serverId);
          }
          replacedClients.add(client);
          this.connectionStates.delete(serverId);
        }
      }

      const result: McpReconcileResult = { connected, kept, failed, removed };

      this.clients = nextClients;
      this.serverConfigs = nextConfigs;
      if (applyDelta) {
        await applyDelta(result);
      }

      return result;
    } finally {
      this.releaseWriteLease();
      // Disconnect replaced clients after the swap: nothing routes to them
      // anymore, and any in-flight work that outlived the drain timeout
      // errors out instead of hanging.
      for (const client of replacedClients) {
        client.disconnect().catch((err) => {
          log.warn(
            { err, serverId: client.serverId },
            "Error disconnecting replaced MCP client",
          );
        });
      }
    }
  }

  private async enterCall(): Promise<void> {
    while (this.writeLeaseHeld) {
      await new Promise<void>((resolve) => {
        this.leaseWaiters.push(resolve);
      });
    }
    this.inFlightCalls++;
  }

  private exitCall(): void {
    this.inFlightCalls--;
    if (this.inFlightCalls === 0 && this.drainWaiters.length > 0) {
      const waiters = this.drainWaiters.splice(0);
      for (const resolve of waiters) {
        resolve();
      }
    }
  }

  /**
   * Take the write lease. Sets the flag before inspecting the in-flight
   * count, so a call is either already counted or queues on the flag; there
   * is no window where it slips in between. Waits for in-flight calls to
   * drain, giving up after {@link WRITE_LEASE_DRAIN_TIMEOUT_MS} so a hung
   * call cannot block the swap forever.
   */
  private async acquireWriteLease(): Promise<boolean> {
    this.writeLeaseHeld = true;
    if (this.inFlightCalls === 0) {
      return true;
    }
    return await new Promise<boolean>((resolve) => {
      const waiter = () => {
        clearTimeout(timeout);
        resolve(true);
      };
      const timeout = setTimeout(() => {
        const index = this.drainWaiters.indexOf(waiter);
        if (index >= 0) {
          this.drainWaiters.splice(index, 1);
        }
        log.warn(
          { inFlightCalls: this.inFlightCalls },
          "Timed out waiting for in-flight MCP calls to drain; swapping anyway",
        );
        resolve(false);
      }, WRITE_LEASE_DRAIN_TIMEOUT_MS);
      this.drainWaiters.push(waiter);
    });
  }

  private releaseWriteLease(): void {
    this.writeLeaseHeld = false;
    const waiters = this.leaseWaiters.splice(0);
    for (const resolve of waiters) {
      resolve();
    }
  }

  getClient(serverId: string): McpClient | undefined {
    return this.clients.get(serverId);
  }

  getServerState(
    serverId: string,
    source: ResolvedMcpServerConfig["source"],
  ): McpConnectionState | undefined {
    const entry = this.connectionStates.get(serverId);
    return entry?.source === source ? entry.state : undefined;
  }
}

// Singleton instance
let instance: McpServerManager | null = null;

export function getMcpServerManager(): McpServerManager {
  if (!instance) {
    instance = new McpServerManager();
  }
  return instance;
}

/**
 * Stop the MCP server manager singleton (disconnect all servers) if one was
 * created. No-op when no manager exists — e.g. no MCP servers were ever
 * configured — so shutdown callers don't need to gate on configuration. Acts on
 * the live singleton, so it also stops servers added at runtime via MCP reload.
 */
export async function stopMcpServerManager(): Promise<void> {
  if (!instance) {
    return;
  }
  await instance.stop();
}
