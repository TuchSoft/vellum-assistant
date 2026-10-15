/** Declarative help for the `assistant host-exec` command. */

import type { CliCommandHelp } from "../lib/cli-command-help.js";

export const hostExecHelp: CliCommandHelp = {
  name: "host-exec",
  args: "<command...>",
  description:
    "Execute a shell command on the connected desktop host via the assistant",
  options: [
    {
      flags: "-t, --timeout <seconds>",
      description: "Timeout in seconds for command execution on the host",
      defaultValue: "30",
    },
  ],
  helpText: `
Sends a shell command to the running assistant over the IPC socket, which
executes it on the connected desktop host through the same host_bash proxy
path the assistant's tools use. The desktop client applies its normal risk
classification and approval flow for host commands.

Usage:
  $ assistant host-exec -- <command>

The command after \`--\` is passed verbatim (including any flags) to the host
shell. Output (stdout/stderr, merged as the assistant sees it) is printed to
the terminal; the process exits non-zero when the command fails or times out.

Arguments:
  command   The shell command string to execute on the desktop host
            (e.g. "ls -la", "git status"). Use \`--\` so flags are not
            parsed by this CLI.

Examples:
  $ assistant host-exec -- ls -la
  $ assistant host-exec -- git -C ~/project status
  $ assistant host-exec -- "sleep 60 && echo done" --timeout 90`,
};
