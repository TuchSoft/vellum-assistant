/**
 * Periodic MCP reconcile.
 *
 * Runs reloadMcpServers() on a fixed cadence so connections that died
 * silently (expired streamable-HTTP sessions, server restarts, proxy
 * timeouts) recover without waiting for a config edit, a plugin change, or
 * a manual `assistant mcp reload`. The reconcile itself is a no-op for
 * healthy, unchanged servers: a passing tick costs no reconnects and leaves
 * the registered tool list (and its provider cache key) untouched.
 *
 * Interval: defaults to 15 minutes, overridable with
 * VELLUM_MCP_HEALTH_INTERVAL_MS (milliseconds) for deployments that want a
 * different cadence.
 */

import { getLogger } from "../util/logger.js";
import { reloadMcpServers } from "./mcp-reload-service.js";

const log = getLogger("mcp-health-scheduler");

const DEFAULT_INTERVAL_MS = 15 * 60 * 1000;

let timer: ReturnType<typeof setInterval> | null = null;

export function startMcpHealthScheduler(): void {
  if (timer) {
    return;
  }
  const fromEnv = Number(process.env.VELLUM_MCP_HEALTH_INTERVAL_MS);
  const intervalMs =
    Number.isFinite(fromEnv) && fromEnv > 0 ? fromEnv : DEFAULT_INTERVAL_MS;
  timer = setInterval(() => {
    reloadMcpServers().catch((err: unknown) => {
      log.error({ err }, "Scheduled MCP reconcile failed");
    });
  }, intervalMs);
  // Never keep the process alive on account of this timer.
  timer.unref?.();
  log.info({ intervalMs }, "MCP health scheduler started");
}

export function stopMcpHealthScheduler(): void {
  if (!timer) {
    return;
  }
  clearInterval(timer);
  timer = null;
}
