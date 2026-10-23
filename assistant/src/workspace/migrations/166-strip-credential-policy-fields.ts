import { existsSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { getLogger } from "../../util/logger.js";
import type { WorkspaceMigration } from "./types.js";

const log = getLogger("workspace-migration-166");

const POLICY_KEYS = ["allowedTools", "allowedDomains"] as const;

/**
 * Strip the retired credential policy fields from the leftover workspace
 * `data/credentials/metadata.json` file.
 *
 * CES owns credential records now and ignores this file, but a record copied
 * there by the historical import can still carry the fields. Removing them
 * keeps the leftover file consistent with the current record contract.
 * Re-running is a no-op once the fields are gone.
 */
export const stripCredentialPolicyFieldsMigration: WorkspaceMigration = {
  id: "166-strip-credential-policy-fields",
  description:
    "Strip allowedTools and allowedDomains from data/credentials/metadata.json",
  run(workspaceDir: string): void {
    const metadataPath = join(
      workspaceDir,
      "data",
      "credentials",
      "metadata.json",
    );
    if (!existsSync(metadataPath)) {
      return;
    }

    let parsed: unknown;
    try {
      parsed = JSON.parse(readFileSync(metadataPath, "utf-8"));
    } catch {
      return;
    }
    if (!isRecord(parsed) || !Array.isArray(parsed.credentials)) {
      return;
    }

    let changed = false;
    for (const entry of parsed.credentials) {
      if (!isRecord(entry)) {
        continue;
      }
      for (const key of POLICY_KEYS) {
        if (Object.hasOwn(entry, key)) {
          delete entry[key];
          changed = true;
        }
      }
    }

    if (!changed) {
      return;
    }

    const tmpPath = `${metadataPath}.migration-166.tmp`;
    writeFileSync(tmpPath, JSON.stringify(parsed, null, 2));
    renameSync(tmpPath, metadataPath);
    log.info("Stripped credential policy fields from metadata.json");
  },
  retryFailedCheckpoint: true,
  down(_workspaceDir: string): void {
    // Forward-only: the fields are no longer in the record contract.
  },
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
