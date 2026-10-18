/**
 * `assistant memory v2` CLI subgroup.
 *
 * Operator-facing subcommands for the concept-page substrate. The namespace
 * keeps its historical `v2` spelling because the IPC routes and wire contracts
 * it drives (`memory/v2/*`) are frozen surface; the operations themselves are
 * tier-agnostic concept-page maintenance.
 *
 * Subcommands:
 *
 *   - `reembed` — enqueue an `embed_concept_page` job per page slug to
 *     refresh dense + sparse vectors in Qdrant.
 *   - `reembed-skills` — synchronously re-seed concept-page skill catalog
 *     entries from the current skill set.
 *   - `validate`: {@link runMemoryValidate}, also registered as the top-level
 *     `memory validate` (`memory-validate.ts`).
 */

import type { Command } from "commander";

import { cliIpcCall } from "../../../ipc/cli-client.js";
import type {
  MemoryV2BackfillOp,
  MemoryV2BackfillResult,
  MemoryV2ReembedSkillsResult,
  MemoryV2ValidateResult,
} from "../../../plugins/defaults/memory/src/memory-substrate-routes.js";
import { subcommand } from "../../lib/cli-command-help.js";
import { log } from "../../logger.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Issue a backfill IPC call, log the resulting `jobId`, and set a non-zero
 * exit code on failure.
 */
async function runBackfillOp(op: MemoryV2BackfillOp): Promise<void> {
  const result = await cliIpcCall<MemoryV2BackfillResult>(
    "memory_v2_backfill",
    { body: { op } },
  );

  if (!result.ok) {
    log.error(result.error ?? `Failed to enqueue ${op} job`);
    process.exitCode = 1;
    return;
  }

  log.info(`Queued ${op} job: ${result.result!.jobId}`);
}

/**
 * Print the validate report; sets a non-zero exit code on any violation.
 * Registered as `memory validate` (`memory-validate.ts`) and `memory v2
 * validate`.
 */
export async function runMemoryValidate(): Promise<void> {
  const result = await cliIpcCall<MemoryV2ValidateResult>(
    "memory_v2_validate",
    { body: {} },
  );

  if (!result.ok) {
    log.error(result.error ?? "Failed to validate memory state");
    process.exitCode = 1;
    return;
  }

  const report = result.result!;
  log.info(`Pages: ${report.pageCount}`);
  log.info(`Edges: ${report.edgeCount}`);
  log.info(
    `Dangling links: ${
      report.danglingLinks.length === 0 ? "none" : report.danglingLinks.length
    }`,
  );
  for (const d of report.danglingLinks) {
    log.info(`  - ${d.from} → ${d.to} (${d.kind})`);
  }
  log.info(
    `Oversized pages: ${
      report.oversizedPages.length === 0 ? "none" : report.oversizedPages.length
    }`,
  );
  for (const p of report.oversizedPages) {
    log.info(`  - ${p.slug}: ${p.chars} chars`);
  }
  log.info(
    `Parse failures: ${
      report.parseFailures.length === 0 ? "none" : report.parseFailures.length
    }`,
  );
  for (const p of report.parseFailures) {
    log.info(`  - ${p.slug}: ${p.error}`);
  }

  if (
    report.danglingLinks.length > 0 ||
    report.oversizedPages.length > 0 ||
    report.parseFailures.length > 0
  ) {
    process.exitCode = 1;
  }
}

// ---------------------------------------------------------------------------
// Registration
// ---------------------------------------------------------------------------

export function registerMemoryV2Command(memory: Command): void {
  const v2 = subcommand(memory, "v2");

  // ── reembed ───────────────────────────────────────────────────────────

  subcommand(v2, "reembed").action(async () => {
    await runBackfillOp("reembed");
  });

  // ── reembed-skills ────────────────────────────────────────────────────

  subcommand(v2, "reembed-skills").action(async () => {
    const result = await cliIpcCall<MemoryV2ReembedSkillsResult>(
      "memory_v2_reembed_skills",
      { body: {} },
    );

    if (!result.ok) {
      log.error(result.error ?? "Failed to re-seed concept-page skills");
      process.exitCode = 1;
      return;
    }

    log.info("Skill re-seed complete.");
  });

  // ── validate ──────────────────────────────────────────────────────────

  subcommand(v2, "validate").action(runMemoryValidate);
}
