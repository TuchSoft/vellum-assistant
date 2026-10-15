/**
 * `assistant host-exec` — run a shell command on the connected desktop host
 * through the assistant's host_bash proxy (IPC transport).
 *
 * No VELLUM_DEBUG gate: the IPC socket is already the local trust boundary,
 * and the desktop client applies its own risk classification and approval
 * flow to host commands regardless of how the request originated.
 */

import type { Command } from "commander";

import { requestHostExec } from "../../ipc/host-exec-client.js";
import { applyCommandHelp, commandSpec } from "../lib/cli-command-help.js";
import { registerCommand } from "../lib/register-command.js";
import { log } from "../logger.js";
import { hostExecHelp } from "./host-exec.help.js";

export function registerHostExecCommand(program: Command): void {
  registerCommand(program, {
    name: commandSpec(hostExecHelp),
    transport: "ipc",
    description: hostExecHelp.description,
    build: (cmd) => {
      applyCommandHelp(cmd, hostExecHelp);
      // Variadic positional so everything after `--` is captured verbatim.
      cmd.allowExcessArguments(false);
      cmd.action(async (commandParts: string[], opts: { timeout: string }) => {
        const timeoutSeconds = parseInt(opts.timeout, 10);
        if (!Number.isFinite(timeoutSeconds) || timeoutSeconds < 1) {
          log.error("Invalid timeout value. Must be a positive integer.");
          process.exitCode = 1;
          return;
        }

        const command = commandParts.join(" ").trim();
        if (!command) {
          log.error("Missing command. Usage: assistant host-exec -- <command>");
          process.exitCode = 1;
          return;
        }

        const data = await requestHostExec({
          command,
          timeout_seconds: timeoutSeconds,
        });

        if (!data.ok) {
          log.error(data.timedOut ? `Timed out: ${data.error}` : data.error);
          process.exitCode = 1;
          return;
        }

        if (data.content) {
          const out = data.content.endsWith("\n")
            ? data.content
            : `${data.content}\n`;
          // The proxy result merges stdout and stderr into one capped string,
          // so it goes to stdout; failure is conveyed by the exit code.
          process.stdout.write(out);
        }

        if (data.isError) {
          if (data.status) {
            log.info(`Status: ${data.status}`);
          }
          process.exitCode = 1;
        }
      });
    },
  });
}
