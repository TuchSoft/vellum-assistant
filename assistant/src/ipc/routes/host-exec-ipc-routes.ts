/**
 * IPC-only route for executing a shell command on the connected desktop host
 * from any local process that can reach the assistant IPC socket.
 *
 * The handler reuses the exact same code path as the `host_bash` tool:
 * {@link HostBashProxy.instance.request}. The desktop client still performs
 * its normal risk classification and user approval for the `host_bash_request`
 * event, so the same security boundary applies as for tool-originated
 * commands. No `VELLUM_DEBUG` gate: the IPC socket is already the local trust
 * boundary, and every other IPC-only method map (`EVENTS_IPC_METHODS`, the
 * sync maps) is ungated.
 *
 * The result mirrors the tool-result shape rather than raw stdio fields:
 * `HostBashProxy.request` returns the merged, truncation-capped
 * `ToolExecutionResult` produced by `formatShellOutput`, so stdout/stderr and
 * the exit code are no longer separable at this layer.
 *
 * IPC-only: registered directly on the assistant IPC server (see
 * `assistant-server.ts`), never in the shared `ROUTES` array.
 */

import { z } from "zod";

import { HostBashProxy } from "../../daemon/host-bash-proxy.js";
import { HostProxyRequestError } from "../../daemon/host-proxy-base.js";
import type { RouteHandlerArgs } from "../../runtime/routes/types.js";
import { buildHostProxyPath } from "../../tools/host-terminal/host-shell.js";
import { getLogger } from "../../util/logger.js";
import { HOST_EXEC_IPC_METHOD } from "../host-exec-client.js";

const log = getLogger("host-exec-ipc-routes");

/**
 * Conversation id used when the caller does not supply one. The value is
 * carried through the `host_bash_request` envelope and the pending-interactions
 * registry (keyed by request id), which perform no conversation-existence
 * lookup, so a sentinel id for non-conversation traffic is safe.
 */
const HOST_EXEC_CONVERSATION_ID = "host-exec";

const HostExecParamsSchema = z.object({
  command: z.string().min(1),
  timeout_seconds: z.number().int().positive().optional(),
  working_dir: z.string().optional(),
  env: z.record(z.string(), z.string()).optional(),
  conversationId: z.string().optional(),
});

export type HostExecResult =
  | {
      ok: true;
      /** Merged stdout/stderr output (truncation-capped), as the tool sees it. */
      content: string;
      /** Machine-readable status tags (e.g. `<command_exit ... />`). */
      status?: string;
      /** True when the command failed or timed out on the host. */
      isError: boolean;
    }
  | { ok: false; error: string; timedOut?: boolean };

export async function handleHostExec({
  body = {},
}: RouteHandlerArgs): Promise<HostExecResult> {
  const { command, timeout_seconds, working_dir, env, conversationId } =
    HostExecParamsSchema.parse(body);

  // Apply the configured host shell PATH (hostShell.extraPath) so commands
  // resolve binaries in the same directories as host_bash, then layer any
  // caller-supplied env on top.
  const proxyPath = buildHostProxyPath();
  const proxyEnv =
    proxyPath != null ? { ...(env ?? {}), PATH: proxyPath } : env;

  try {
    const result = await HostBashProxy.instance.request(
      { command, timeout_seconds, working_dir, env: proxyEnv },
      conversationId ?? HOST_EXEC_CONVERSATION_ID,
    );
    return {
      ok: true,
      content: result.content,
      status: result.status,
      isError: result.isError,
    };
  } catch (err) {
    // `request` already converts its own timeout/abort rejections into
    // results; a thrown error here is an unexpected transport failure.
    if (err instanceof HostProxyRequestError) {
      return {
        ok: false,
        error: err.message,
        timedOut: err.reason === "timeout",
      };
    }
    const message = err instanceof Error ? err.message : String(err);
    log.error({ err, command }, "Host exec IPC request failed");
    return { ok: false, error: message };
  }
}

/**
 * IPC-only host-exec methods, keyed by operationId. Registered directly on the
 * assistant IPC server (see `assistant-server.ts`).
 */
export const HOST_EXEC_IPC_METHODS: Record<
  string,
  (args: RouteHandlerArgs) => unknown
> = {
  [HOST_EXEC_IPC_METHOD]: handleHostExec,
};
