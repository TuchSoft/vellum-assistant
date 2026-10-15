import { UnauthorizedError } from "@modelcontextprotocol/sdk/client/auth.js";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { SSEClientTransport } from "@modelcontextprotocol/sdk/client/sse.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import {
  StreamableHTTPClientTransport,
  StreamableHTTPError,
} from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import {
  McpError,
  type ToolAnnotations,
} from "@modelcontextprotocol/sdk/types.js";

import type {
  McpServerSource,
  McpTransport,
  ResolvedMcpServerConfig,
} from "../config/schemas/mcp.js";
import { getLogger } from "../util/logger.js";
import {
  resolveMcpOAuthCredentialTarget,
  workspaceMcpOAuthCredentialTarget,
} from "./credential-target.js";
import { getMcpHeaders } from "./mcp-header-store.js";
import { hasMcpOAuthTokens, McpOAuthProvider } from "./mcp-oauth-provider.js";

const log = getLogger("mcp-client");

const CONNECT_TIMEOUT_MS = 30_000;

/**
 * Behavioral hints a server may attach to a tool (MCP `ToolAnnotations`).
 * Self-reported by the server, so consumers treat them as hints rather than
 * guarantees.
 */
export type McpToolAnnotations = ToolAnnotations;

export interface McpToolInfo {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
  annotations?: McpToolAnnotations;
}

export interface McpCallResult {
  content: string;
  isError: boolean;
}

export class McpClient {
  readonly serverId: string;
  /**
   * Where this server was declared. Workspace servers use their public id for
   * OAuth and static-header identity. Plugin servers use their declaring owner,
   * original key, and endpoint for OAuth and never read workspace headers.
   */
  readonly source: McpServerSource;
  private readonly serverConfig: ResolvedMcpServerConfig | null;
  private client: Client;
  private transport:
    | StdioClientTransport
    | SSEClientTransport
    | StreamableHTTPClientTransport
    | null = null;
  private connected = false;
  private oauthProvider: McpOAuthProvider | null = null;
  private _lastError: Error | null = null;
  /** Transport config of the last connect(), used by self-healing reconnects. */
  private lastTransportConfig: McpTransport | null = null;
  /** Single-flight guard: concurrent callers share one reconnect attempt. */
  private reconnectInFlight: Promise<boolean> | null = null;

  /** The last connection error, if any. Null when connected or not yet attempted. */
  get lastError(): Error | null {
    return this._lastError;
  }

  get isConnected(): boolean {
    return this.connected;
  }

  constructor(
    serverId: string,
    sourceOrConfig: McpServerSource | ResolvedMcpServerConfig = "workspace",
    private readonly onUnexpectedClose?: () => void,
  ) {
    this.serverId = serverId;
    this.source =
      typeof sourceOrConfig === "string"
        ? sourceOrConfig
        : sourceOrConfig.source;
    this.serverConfig =
      typeof sourceOrConfig === "string" ? null : sourceOrConfig;
    this.client = this.createSdkClient();
  }

  private createSdkClient(): Client {
    const client = new Client({
      name: "vellum-assistant",
      version: "1.0.0",
    });

    // Prevent SDK-internal transport errors (e.g. SSE reconnection auth
    // failures) from surfacing as unhandled rejections that crash the daemon
    // via the global unhandledRejection → shutdown handler.
    client.onerror = (error) => {
      log.warn(
        { serverId: this.serverId, err: error },
        "MCP SDK transport error (non-fatal)",
      );
    };

    // A close initiated by the remote peer or a fatal transport error marks
    // the client dead so the next call lazily reconnects. disconnect() nulls
    // `connected` before closing, which distinguishes an intentional teardown
    // from a lost connection here.
    client.onclose = () => {
      const wasConnected = this.connected;
      this.connected = false;
      this.transport = null;
      if (wasConnected) {
        log.warn(
          { serverId: this.serverId },
          "MCP connection closed; will reconnect on next use",
        );
        this.onUnexpectedClose?.();
      }
    };

    return client;
  }

  async connect(transportConfig: McpTransport): Promise<void> {
    if (this.connected) {
      return;
    }
    this.lastTransportConfig = transportConfig;
    await this.establishConnection(transportConfig);
  }

  private async establishConnection(
    transportConfig: McpTransport,
  ): Promise<void> {
    const isHttpTransport =
      transportConfig.type === "sse" ||
      transportConfig.type === "streamable-http";
    const credentialTarget = this.resolveCredentialTarget(transportConfig);
    this.oauthProvider = null;

    // For HTTP transports, only attach an OAuth provider if cached tokens
    // exist. This avoids triggering client registration during daemon
    // startup. If no tokens, try without auth: if the server requires it,
    // skip silently.
    if (isHttpTransport && credentialTarget) {
      if (await hasMcpOAuthTokens(credentialTarget)) {
        this.oauthProvider = new McpOAuthProvider(
          this.serverId,
          transportConfig.url,
          /* interactive */ false,
          { credentialTarget },
        );
      }
    }

    // Resolve static auth headers from credential store, falling back to
    // any legacy headers in the transport config for backward compatibility.
    let effectiveConfig = transportConfig;
    if (isHttpTransport && this.source === "workspace") {
      const storedHeaders = await getMcpHeaders(this.serverId);
      if (storedHeaders) {
        effectiveConfig = {
          ...transportConfig,
          headers: { ...transportConfig.headers, ...storedHeaders },
        } as McpTransport;
      }
    }

    log.info({ serverId: this.serverId }, "Connecting to MCP server");
    this.transport = this.createTransport(effectiveConfig);

    try {
      await Promise.race([
        this.client.connect(this.transport),
        new Promise<never>((_, reject) =>
          setTimeout(
            () =>
              reject(
                new Error(
                  `MCP server "${this.serverId}" connection timed out after ${CONNECT_TIMEOUT_MS}ms`,
                ),
              ),
            CONNECT_TIMEOUT_MS,
          ),
        ),
      ]);
    } catch (err) {
      // Null the transport before closing so the onclose handler does not
      // report a failed connect as a lost connection.
      this.transport = null;
      try {
        await this.client.close();
      } catch {
        /* ignore cleanup errors */
      }

      if (isHttpTransport && isAuthRelatedError(err)) {
        // Auth-related. User can run `assistant mcp auth <name>` to authenticate.
        log.info(
          { serverId: this.serverId, err },
          "MCP server requires authentication",
        );
        return;
      }

      // Non-auth error (DNS, TLS, timeout, etc.) — log but never propagate
      // an MCP connection failure to the caller.  The daemon must keep
      // running even when individual MCP servers are unreachable.
      this._lastError = err instanceof Error ? err : new Error(String(err));
      log.error(
        { serverId: this.serverId, err },
        "MCP server connection failed",
      );
      return;
    }

    if (this.transport === null) {
      this._lastError = new Error(
        `MCP server "${this.serverId}" closed during initialization`,
      );
      return;
    }

    this.connected = true;
    log.info({ serverId: this.serverId }, "MCP client connected");
  }

  private resolveCredentialTarget(
    transport: McpTransport,
  ): ReturnType<typeof resolveMcpOAuthCredentialTarget> {
    if (this.source === "workspace") {
      return transport.type === "stdio"
        ? null
        : workspaceMcpOAuthCredentialTarget(this.serverId);
    }
    if (!this.serverConfig) {
      return null;
    }
    return resolveMcpOAuthCredentialTarget(this.serverId, {
      ...this.serverConfig,
      transport,
    });
  }

  async listTools(): Promise<McpToolInfo[]> {
    if (!this.connected) {
      throw new Error(`MCP client "${this.serverId}" is not connected`);
    }

    const result = await Promise.race([
      this.client.listTools(),
      new Promise<never>((_, reject) =>
        setTimeout(
          () =>
            reject(
              new Error(
                `MCP server "${this.serverId}" listTools timed out after ${CONNECT_TIMEOUT_MS}ms`,
              ),
            ),
          CONNECT_TIMEOUT_MS,
        ),
      ),
    ]);
    return result.tools.map((tool) => ({
      name: tool.name,
      description: tool.description ?? "",
      inputSchema: tool.inputSchema,
      annotations: tool.annotations,
    }));
  }

  async callTool(
    name: string,
    args: Record<string, unknown>,
    signal?: AbortSignal,
  ): Promise<McpCallResult> {
    if (!this.connected) {
      const revived = await this.reconnect();
      if (!revived) {
        throw new Error(`MCP client "${this.serverId}" is not connected`);
      }
    }

    try {
      return await this.invokeTool(name, args, signal);
    } catch (err) {
      // Tool-level failures arrive as isError results, so a throw here means
      // the transport or the protocol broke. HTTP sessions expire server-side
      // (idle TTLs, server restarts, proxy timeouts) without any close event
      // reaching this client, so a dead session is often first observed as a
      // failed call. Reconnect once and retry the call on the fresh session.
      if (signal?.aborted || !isRetryableConnectionError(err)) {
        throw err;
      }
      log.warn(
        { serverId: this.serverId, toolName: name, err },
        "MCP tool call failed with a connection-level error; reconnecting and retrying once",
      );
      const revived = await this.reconnect();
      if (!revived) {
        throw err;
      }
      return this.invokeTool(name, args, signal);
    }
  }

  /**
   * Tear down the current connection and re-run the full connect pipeline
   * (credential-store headers, OAuth tokens) on a fresh SDK client. The SDK
   * does not support resuming a streamable-HTTP session without an event
   * store, so recovery is a new initialize handshake. Concurrent callers
   * share one attempt; resolves to whether a connection was established.
   */
  private reconnect(): Promise<boolean> {
    if (this.reconnectInFlight) {
      return this.reconnectInFlight;
    }
    const config = this.lastTransportConfig;
    if (!config) {
      return Promise.resolve(false);
    }
    this.reconnectInFlight = (async () => {
      log.info({ serverId: this.serverId }, "Reconnecting MCP client");
      this.transport = null;
      this.connected = false;
      try {
        await this.client.close();
      } catch {
        /* ignore cleanup errors */
      }
      this.client = this.createSdkClient();
      await this.establishConnection(config);
      return this.connected;
    })().finally(() => {
      this.reconnectInFlight = null;
    });
    return this.reconnectInFlight;
  }

  private async invokeTool(
    name: string,
    args: Record<string, unknown>,
    signal?: AbortSignal,
  ): Promise<McpCallResult> {
    const result = await this.client.callTool(
      { name, arguments: args },
      undefined,
      signal ? { signal } : undefined,
    );
    const isError = result.isError === true;

    // Handle structuredContent if present
    if (result.structuredContent !== undefined) {
      return {
        content: JSON.stringify(result.structuredContent),
        isError,
      };
    }

    // Concatenate all content blocks into a single string
    const textParts: string[] = [];
    if (Array.isArray(result.content)) {
      for (const block of result.content) {
        if (
          typeof block === "object" &&
          block !== undefined &&
          "type" in block
        ) {
          if (block.type === "text" && "text" in block) {
            textParts.push(String(block.text));
          } else if (block.type === "resource" && "resource" in block) {
            const resource = block.resource as Record<string, unknown>;
            textParts.push(
              typeof resource.text === "string"
                ? resource.text
                : JSON.stringify(resource),
            );
          } else {
            // For other content types (image, etc.), include type and any available data
            textParts.push(`[${block.type} content: ${JSON.stringify(block)}]`);
          }
        }
      }
    }

    return {
      content:
        textParts.join("\n") ||
        (isError ? "Tool execution failed" : "Tool executed successfully"),
      isError,
    };
  }

  async disconnect(): Promise<void> {
    if (!this.connected) {
      return;
    }

    // An intentionally disconnected client must not self-heal: the manager
    // tears clients down during reload and shutdown, and a lazy reconnect
    // would resurrect a server that was deliberately stopped.
    this.lastTransportConfig = null;
    this.connected = false;
    try {
      await this.client.close();
    } catch (err) {
      log.warn({ err, serverId: this.serverId }, "Error closing MCP client");
    }
    this.transport = null;
    log.info({ serverId: this.serverId }, "MCP client disconnected");
  }

  private createTransport(
    config: McpTransport,
  ): StdioClientTransport | SSEClientTransport | StreamableHTTPClientTransport {
    switch (config.type) {
      case "stdio":
        return new StdioClientTransport({
          command: config.command,
          args: config.args,
          env: config.env
            ? ({ ...process.env, ...config.env } as Record<string, string>)
            : undefined,
        });
      case "sse":
        return new SSEClientTransport(new URL(config.url), {
          authProvider: this.oauthProvider ?? undefined,
          requestInit: config.headers ? { headers: config.headers } : undefined,
        });
      case "streamable-http":
        return new StreamableHTTPClientTransport(new URL(config.url), {
          authProvider: this.oauthProvider ?? undefined,
          requestInit: config.headers ? { headers: config.headers } : undefined,
        });
    }
  }
}

/**
 * Returns true when a thrown `callTool` error means the transport or session
 * is broken, making a reconnect worth attempting. `McpError` carries a
 * JSON-RPC error the server actively answered, so the connection is alive
 * and the failure belongs to the call itself. HTTP 401/403 are auth
 * failures a plain reconnect cannot fix; 404/410 are the expired-session
 * responses streamable-HTTP servers send, and anything else at this layer
 * (fetch failures, resets, premature close) is transport-level.
 */
function isRetryableConnectionError(err: unknown): boolean {
  if (err instanceof McpError) {
    return false;
  }
  if (err instanceof Error && err.name === "AbortError") {
    return false;
  }
  if (err instanceof StreamableHTTPError) {
    return err.code !== 401 && err.code !== 403;
  }
  return true;
}

/**
 * Returns true when `err` looks like an authentication / authorization failure
 * from the MCP SDK or the remote server.  Used to distinguish "needs auth"
 * from genuine transport failures so we can log guidance instead of crashing.
 */
function isAuthRelatedError(err: unknown): boolean {
  if (err instanceof UnauthorizedError) {
    return true;
  }

  if (
    err instanceof Error &&
    /\b(401|403|unauthorized|forbidden|authorizationCode is required|prepareTokenRequest)\b/i.test(
      err.message,
    )
  ) {
    return true;
  }

  if (
    err != null &&
    typeof err === "object" &&
    "code" in err &&
    (err.code === 401 || err.code === 403)
  ) {
    return true;
  }

  return false;
}
