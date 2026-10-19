/**
 * `assistant inference models` CLI namespace.
 *
 *   `assistant inference models list [--json]`
 *
 * Lists the gateway alias catalog so callers can discover valid aliases
 * instead of guessing. Delegates to the daemon via IPC (`llm_catalog_get`).
 */

import type { Command } from "commander";

import { cliIpcCall } from "../../ipc/cli-client.js";
import { subcommand } from "../lib/cli-command-help.js";
import { renderTable, writeCliError, writeLine } from "../lib/cli-output.js";

interface CatalogModel {
  alias: string;
  label: string;
  maxInputTokens?: number;
  maxOutputTokens?: number;
  supportsVision: boolean;
  supportsTools: boolean;
  mode: string;
}

export function attachModelsSubcommand(inference: Command): void {
  const models = subcommand(inference, "models");

  subcommand(models, "list").action(async (opts: { json?: boolean }) => {
    const ipcResult = await cliIpcCall<{ models: CatalogModel[] }>(
      "llm_catalog_get",
      {},
    );

    if (!ipcResult.ok) {
      writeCliError(ipcResult.error ?? "Unknown error", opts.json);
      return;
    }

    const rows = ipcResult.result!.models;

    if (opts.json) {
      process.stdout.write(JSON.stringify({ ok: true, models: rows }) + "\n");
      return;
    }

    if (rows.length === 0) {
      writeLine("No models found.");
      return;
    }

    renderTable(
      ["ALIAS", "MODE", "LABEL", "CONTEXT", "VISION", "TOOLS"],
      rows.map((m) => [
        m.alias,
        m.mode,
        m.label,
        m.maxInputTokens != null ? m.maxInputTokens.toLocaleString() : "-",
        m.supportsVision ? "yes" : "no",
        m.supportsTools ? "yes" : "no",
      ]),
    );
  });
}
