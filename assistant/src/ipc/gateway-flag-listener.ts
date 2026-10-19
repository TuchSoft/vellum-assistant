import { Socket } from "node:net";

import { refreshOverridesFromGateway } from "../config/assistant-feature-flags.js";
import { SYNC_TAGS } from "../daemon/message-types/sync.js";
import { publishSyncInvalidation } from "../runtime/sync/sync-publisher.js";
import { getLogger } from "../util/logger.js";
import { resolveIpcSocketPath } from "./socket-path.js";

const log = getLogger("gateway-flag-listener");

/**
 * Refresh the flag-overrides cache from the gateway. Both the
 * `feature_flags_changed` event and a reconnect refresh the cache; consumers
 * read the synchronous cache in response to the invalidation published here.
 */
function refreshFlags(context: string): void {
  refreshOverridesFromGateway()
    .then((loaded) => {
      if (!loaded) {
        return;
      }
      void publishSyncInvalidation([
        SYNC_TAGS.featureFlagsClient,
        SYNC_TAGS.featureFlagsAssistant,
      ]).catch((err) => {
        log.warn({ err }, "Failed to broadcast feature-flags sync_changed");
      });
    })
    .catch((err) => {
      log.warn(
        { err },
        `Failed to refresh feature flag overrides (${context})`,
      );
    });
}

const MAX_BACKOFF_MS = 30_000;
const INITIAL_BACKOFF_MS = 1_000;

let socket: Socket | null = null;
let stopped = false;
let reconnectTimer: ReturnType<typeof setTimeout> | null = null;
let currentBackoffMs = INITIAL_BACKOFF_MS;

function getSocketPath(): string {
  return resolveIpcSocketPath("gateway").path;
}

function handleData(chunk: Buffer): void {
  const lines = chunk.toString().split("\n");
  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed) {
      continue;
    }
    try {
      const msg = JSON.parse(trimmed) as { event?: string };
      if (msg.event === "feature_flags_changed") {
        log.info("Received feature_flags_changed event — refreshing overrides");
        refreshFlags("flags-changed event");
      }
    } catch {
      // Ignore non-JSON lines (e.g. IPC responses on a shared socket)
    }
  }
}

function scheduleReconnect(): void {
  if (stopped) {
    return;
  }
  reconnectTimer = setTimeout(() => {
    reconnectTimer = null;
    connectToGateway();
  }, currentBackoffMs);
  currentBackoffMs = Math.min(currentBackoffMs * 2, MAX_BACKOFF_MS);
}

function connectToGateway(): void {
  if (stopped) {
    return;
  }

  const socketPath = getSocketPath();
  // Attach error listeners before connect() so a missing gateway.sock cannot
  // surface as an uncaught exception.
  const conn = new Socket();

  conn.on("connect", () => {
    if (stopped) {
      conn.destroy();
      return;
    }
    log.info("Connected to gateway IPC for flag events");
    currentBackoffMs = INITIAL_BACKOFF_MS;
    socket = conn;
    // A reconnect may have missed a flag flip while disconnected, so reconcile
    // the managed profile too — not just the cache.
    refreshFlags("reconnect");
  });

  let buffer = "";
  conn.on("data", (chunk) => {
    buffer += chunk.toString();
    let newlineIdx: number;
    while ((newlineIdx = buffer.indexOf("\n")) !== -1) {
      const line = buffer.slice(0, newlineIdx);
      buffer = buffer.slice(newlineIdx + 1);
      if (line.trim()) {
        handleData(Buffer.from(line));
      }
    }
  });

  conn.on("close", () => {
    socket = null;
    if (!stopped) {
      log.debug("Gateway IPC connection closed — reconnecting");
      scheduleReconnect();
    }
  });

  conn.on("error", (err) => {
    log.debug({ err }, "Gateway IPC connection error");
    conn.destroy();
  });

  conn.connect(socketPath);
}

export function startGatewayFlagListener(): void {
  stopped = false;
  currentBackoffMs = INITIAL_BACKOFF_MS;
  connectToGateway();
}

export function stopGatewayFlagListener(): void {
  stopped = true;
  if (reconnectTimer) {
    clearTimeout(reconnectTimer);
    reconnectTimer = null;
  }
  if (socket) {
    socket.destroy();
    socket = null;
  }
}
