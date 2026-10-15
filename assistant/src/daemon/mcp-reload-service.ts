/**
 * Shared MCP reload business logic.
 *
 * Called by the ConfigWatcher when config.json changes or a reload signal
 * file is detected, by the periodic health scheduler, and by OAuth
 * completion, so the daemon reconnects MCP servers without a restart.
 *
 * The reload is non-destructive: healthy servers with unchanged config keep
 * their connections and their registered tools, so the provider-facing tool
 * list only changes for servers that actually moved. Tool calls in flight
 * during the swap drain first; calls arriving mid-swap queue until the new
 * state is published.
 */

import { invalidateConfigCache } from "../config/loader.js";
import {
  buildEffectiveMcpConfig,
  pluginMcpServersChangedSinceLastBuild,
} from "../mcp/effective-config.js";
import { getMcpServerManager } from "../mcp/manager.js";
import { migrateLegacyMcpHeaders } from "../mcp/mcp-header-store.js";
import { signalMcpReloaded } from "../mcp/reload-signal.js";
import { loadWorkspaceMcpConfig } from "../mcp/workspace-mcp-config.js";
import { publishMcpChanged } from "../runtime/sync/resource-sync-events.js";
import { createMcpToolsFromServer } from "../tools/mcp/mcp-tool-factory.js";
import {
  getMcpToolNamesForServer,
  replaceMcpToolsForServer,
  unregisterMcpToolsForServer,
} from "../tools/registry.js";
import { getLogger } from "../util/logger.js";

const log = getLogger("mcp-reload-service");

/** Per-server reload result. */
export interface McpReloadServerResult {
  id: string;
  connected: boolean;
  toolCount: number;
  tools: string[];
}

export interface McpReloadResult {
  success: boolean;
  serverCount?: number;
  toolCount?: number;
  servers?: McpReloadServerResult[];
  error?: string;
}

let reloadInProgress: Promise<McpReloadResult> | null = null;

/**
 * Reload MCP servers, reconciling toward the current config instead of
 * tearing everything down. Returns a summary of the reload.
 *
 * Concurrent calls are serialized; if a reload is already in progress
 * the caller receives the same promise instead of starting a second one.
 */
export function reloadMcpServers(): Promise<McpReloadResult> {
  if (reloadInProgress) {
    log.info("MCP reload already in progress, awaiting existing operation");
    return reloadInProgress;
  }
  reloadInProgress = doReload().finally(() => {
    reloadInProgress = null;
  });
  return reloadInProgress;
}

/**
 * Reload MCP servers if — and only if — the plugin-declared set moved.
 *
 * Called by the plugin source reconcile, which every install / uninstall /
 * upgrade / enable / disable already funnels through, so a plugin's MCP
 * tools come up and go down with the plugin instead of lingering until an
 * explicit reload, a config edit, or a restart.
 *
 * The guard matters: a reconcile also fires for plugin edits that touch no
 * `mcp.json` at all, and an unconditional reload would reconnect every
 * healthy workspace server to rebuild it for nothing.
 *
 * Never throws: the reconcile is best-effort and must not fail an install
 * whose files already landed on disk.
 */
export async function reconcilePluginMcpServers(): Promise<void> {
  if (!pluginMcpServersChangedSinceLastBuild()) {
    return;
  }
  log.info("Plugin-declared MCP servers changed; reloading");
  await reloadMcpServers();
}

async function doReload(): Promise<McpReloadResult> {
  let reconcileStarted = false;
  try {
    const manager = getMcpServerManager();

    // 0. Migrate any legacy plaintext headers from config.json into
    //    the credential store before loading config for server startup.
    //    No-ops when no legacy headers remain; errors are logged, not thrown.
    try {
      await migrateLegacyMcpHeaders();
    } catch (err) {
      log.warn({ err }, "Legacy MCP header migration failed (continuing)");
    }

    // 1. Validate new config before touching any connection. If the config
    //    is broken we abort early, preserving the current working MCP setup.
    invalidateConfigCache();

    // Plugins are re-read here too: installing or removing one changes the
    // server set exactly like editing config.json does, and both arrive
    // through this same reload.
    const mcpConfig = buildEffectiveMcpConfig(loadWorkspaceMcpConfig());

    // 2. Reconcile: reuse healthy unchanged servers, connect new or changed
    //    ones alongside the live set, then swap atomically under the write
    //    lease. The registry delta runs inside the lease (via applyDelta) so
    //    a tool call released from the queue never observes a half-swapped
    //    state.
    let toolCount = 0;
    const servers: McpReloadServerResult[] = [];

    reconcileStarted = true;
    const outcome = await manager.reconcile(mcpConfig, (result) => {
      // Servers without a working connection lose their tools; a failed
      // refresh of a still-working connection lands in `kept` instead and
      // keeps them.
      for (const failure of result.failed) {
        unregisterMcpToolsForServer(failure.id);
      }
      for (const id of result.removed) {
        unregisterMcpToolsForServer(id);
      }
      for (const { serverId, serverConfig, tools } of result.connected) {
        const mcpTools = createMcpToolsFromServer(
          tools,
          serverId,
          serverConfig,
          manager,
        );
        const live = replaceMcpToolsForServer(serverId, mcpTools);
        toolCount += live.length;
        servers.push({
          id: serverId,
          connected: true,
          toolCount: live.length,
          tools: live.map((t) => t.name),
        });
      }
      for (const id of result.kept) {
        const names = getMcpToolNamesForServer(id);
        toolCount += names.length;
        servers.push({
          id,
          connected: true,
          toolCount: names.length,
          tools: names,
        });
      }
      for (const failure of result.failed) {
        servers.push({
          id: failure.id,
          connected: false,
          toolCount: 0,
          tools: [],
        });
      }
      for (const id of result.removed) {
        servers.push({ id, connected: false, toolCount: 0, tools: [] });
      }
    });

    // Sessions pick up new MCP tools automatically on their next turn
    // via the dynamic resolver in createResolveToolsCallback; no need
    // to evict sessions.

    log.info(
      { serverCount: servers.length, toolCount, outcome },
      "MCP servers reloaded",
    );
    // Other processes hold their own connections to the same servers and have
    // no watcher of their own; this is how they learn the set moved. Only on
    // success: a reload that failed before the reconcile left this process on
    // its existing servers, so there is nothing for anyone to mirror.
    signalMcpReloaded();
    return { success: true, serverCount: servers.length, toolCount, servers };
  } catch (err) {
    const error = err instanceof Error ? err.message : String(err);
    log.error({ err }, "MCP reload failed");
    return { success: false, error };
  } finally {
    if (reconcileStarted) {
      publishMcpChanged();
    }
  }
}
