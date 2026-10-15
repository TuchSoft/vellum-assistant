/**
 * Client transport for asking the daemon to execute a shell command on the
 * connected desktop host via the `/host/exec` IPC route.
 *
 * The method-name constant lives here (not in the route module) so callers
 * (the CLI) can import it without pulling in the route handler's dependency
 * graph (the host proxies and their daemon wiring).
 */

import { cliIpcCall } from "./cli-client.js";
import type { HostExecResult } from "./routes/host-exec-ipc-routes.js";

/** IPC method name — host command execution transport for local processes. */
export const HOST_EXEC_IPC_METHOD = "/host/exec";

export interface HostExecInput {
  command: string;
  timeout_seconds?: number;
  working_dir?: string;
  env?: Record<string, string>;
  conversationId?: string;
}

/**
 * Ask the daemon to run `input.command` on the connected desktop host. The
 * daemon's proxy timeout is `timeout_seconds + 3s`, so the IPC call allows a
 * commensurate client-side margin on top of the requested timeout.
 */
export async function requestHostExec(
  input: HostExecInput,
): Promise<HostExecResult> {
  const result = await cliIpcCall<HostExecResult>(
    HOST_EXEC_IPC_METHOD,
    { body: input },
    { timeoutMs: (input.timeout_seconds ?? 30) * 1000 + 10_000 },
  );
  if (!result.ok) {
    return { ok: false, error: result.error ?? "Failed to reach the assistant." };
  }
  return result.result!;
}
