/** Declarative help for the `assistant db` command. */

import type { CliCommandHelp } from "../../lib/cli-command-help.js";

export const dbHelp: CliCommandHelp = {
  name: "db",
  description: "Inspect the assistant Postgres database",
  options: [
    { flags: "--json", description: "Machine-readable compact JSON output" },
  ],
  subcommands: [
    {
      name: "status",
      description:
        "Show database name, size, server version, connection count, and the largest tables by rows and by size",
    },
  ],
};
