/**
 * `assistant db` — inspect the assistant Postgres database directly from the
 * CLI.
 *
 * The subcommand declares `transport: "local"` so it works when the daemon is
 * down — which is precisely the failure mode this surface is most useful in.
 * It opens its own short-lived connection from `VELLUM_DATABASE_URL` and never
 * goes through IPC.
 */

import type { Command } from "commander";

import { applyCommandHelp } from "../../lib/cli-command-help.js";
import { registerCommand } from "../../lib/register-command.js";
import { dbHelp } from "./index.help.js";
import { registerDbStatus } from "./status.js";

export function registerDbCommand(program: Command): void {
  registerCommand(program, {
    name: dbHelp.name,
    transport: "local",
    description: dbHelp.description,
    build: (db) => {
      applyCommandHelp(db, dbHelp);
      registerDbStatus(db);
    },
  });
}
