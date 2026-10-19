/**
 * `assistant inference callsites` CLI namespace.
 *
 *   callsites list          — effective resolution for every call site
 *   callsites get <site>    — resolution detail + chain for one call site
 *
 * Read-only. Delegates to the daemon (`inference_callsites_*`), which computes
 * resolution via the shared `resolveCallSiteConfig` / `selectWinningProfile`
 * machinery. Output is deliberately compact and aligned — it is mostly read by
 * the assistant itself.
 */

import type { Command } from "commander";

import { cliIpcCall } from "../../ipc/cli-client.js";
import { subcommand } from "../lib/cli-command-help.js";
import { renderTable, writeCliError, writeLine } from "../lib/cli-output.js";

type Source = "pinned" | "call_site" | "chat" | "default" | "disabled";

interface CallSiteSummary {
  callSite: string;
  model: string | null;
  source: Source;
  maxInputTokens?: number;
}

interface CallSiteDetail {
  callSite: string;
  winner: { model: string | null; source: Source };
  resolved: {
    model: string;
    maxInputTokens: number;
    disableCache: boolean;
  } | null;
  resolutionChain: { requested: string; reason: string }[];
  shippedDefault: Record<string, unknown>;
  userPin: Record<string, unknown> | null;
  resolutionError?: { reason: string; message: string };
}

const SOURCE_LABEL: Record<Source, string> = {
  pinned: "pin",
  call_site: "call-site",
  chat: "chat",
  default: "default",
  disabled: "disabled",
};

function formatCtxIn(tokens: number | undefined): string {
  if (tokens == null) {
    return "-";
  }
  if (tokens >= 1_000_000 && tokens % 1_000_000 === 0) {
    return `${tokens / 1_000_000}M`;
  }
  return tokens.toLocaleString();
}

export function attachCallsitesSubcommand(inference: Command): void {
  const callsites = subcommand(inference, "callsites");

  subcommand(callsites, "list").action(async (opts: { json?: boolean }) => {
    const ipcResult = await cliIpcCall<{ callSites: CallSiteSummary[] }>(
      "inference_callsites_list",
      {},
    );
    if (!ipcResult.ok) {
      writeCliError(ipcResult.error ?? "Unknown error", opts.json);
      return;
    }
    const rows = ipcResult.result!.callSites;
    if (opts.json) {
      process.stdout.write(
        JSON.stringify({ ok: true, callSites: rows }) + "\n",
      );
      return;
    }
    renderTable(
      ["CALL SITE", "MODEL", "SRC", "CTX-IN"],
      rows.map((r) => [
        r.callSite,
        r.model ?? "(disabled)",
        SOURCE_LABEL[r.source],
        formatCtxIn(r.maxInputTokens),
      ]),
    );
  });

  subcommand(callsites, "get").action(
    async (site: string, opts: { json?: boolean }) => {
      const ipcResult = await cliIpcCall<CallSiteDetail>(
        "inference_callsites_get",
        { pathParams: { site } },
      );
      if (!ipcResult.ok) {
        writeCliError(ipcResult.error ?? "Unknown error", opts.json);
        return;
      }
      const d = ipcResult.result!;
      if (opts.json) {
        process.stdout.write(JSON.stringify({ ok: true, ...d }) + "\n");
        return;
      }
      writeLine(`call site: ${d.callSite}`);
      writeLine(
        `  winner: ${d.winner.model ?? "(disabled)"} [${SOURCE_LABEL[d.winner.source]}]`,
      );
      if (d.resolved != null) {
        writeLine(
          `  resolved: ${d.resolved.model} ctxIn=${formatCtxIn(d.resolved.maxInputTokens)}` +
            (d.resolved.disableCache ? " cache=off" : ""),
        );
      }
      if (d.resolutionChain.length > 0) {
        writeLine("  resolution chain (skipped rungs):");
        for (const step of d.resolutionChain) {
          writeLine(`    - ${step.requested}: ${step.reason}`);
        }
      }
      writeLine(`  shipped default: ${JSON.stringify(d.shippedDefault)}`);
      writeLine(
        `  user pin: ${d.userPin ? JSON.stringify(d.userPin) : "(none)"}`,
      );
      if (d.resolutionError) {
        writeLine(
          `  resolution error [${d.resolutionError.reason}]: ${d.resolutionError.message}`,
        );
      }
    },
  );
}
