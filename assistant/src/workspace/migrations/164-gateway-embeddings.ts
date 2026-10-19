import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { getLogger } from "../../util/logger.js";
import type { WorkspaceMigration } from "./types.js";

const log = getLogger("workspace-migration-164");

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return value != null && typeof value === "object" && !Array.isArray(value);
}

/**
 * Point memory embeddings at the LLM gateway.
 *
 * The gateway is the single provider and the single credential for every
 * modality, so embeddings ride the same connection as chat. Legacy
 * provider-specific fields are left untouched: this migration only flips the
 * provider and names the catalog alias.
 */
export const gatewayEmbeddingsMigration: WorkspaceMigration = {
  id: "164-gateway-embeddings",
  description:
    "Use the LLM gateway (catalog alias 'embed') for memory embeddings instead of an embedding-specific provider",

  run(workspaceDir: string): void {
    const configPath = join(workspaceDir, "config.json");
    if (!existsSync(configPath)) {
      return;
    }
    let config: unknown;
    try {
      config = JSON.parse(readFileSync(configPath, "utf-8"));
    } catch (err) {
      log.warn({ err }, "Could not parse config.json; skipping migration");
      return;
    }
    if (!isPlainObject(config)) {
      return;
    }

    const memory = isPlainObject(config.memory) ? config.memory : {};
    const embeddings = isPlainObject(memory.embeddings)
      ? memory.embeddings
      : {};

    if (
      embeddings.provider === "gateway" &&
      embeddings.gatewayModel === "embed"
    ) {
      return;
    }

    embeddings.provider = "gateway";
    embeddings.gatewayModel = "embed";
    memory.embeddings = embeddings;
    config.memory = memory;

    writeFileSync(configPath, JSON.stringify(config, null, 2) + "\n");
    log.info("Pointed memory embeddings at the LLM gateway");
  },

  down(workspaceDir: string): void {
    // The previous provider cannot be recovered (the migration intentionally
    // discards no data), so fall back to the schema default.
    const configPath = join(workspaceDir, "config.json");
    if (!existsSync(configPath)) {
      return;
    }
    let config: unknown;
    try {
      config = JSON.parse(readFileSync(configPath, "utf-8"));
    } catch {
      return;
    }
    if (!isPlainObject(config)) {
      return;
    }
    if (!isPlainObject(config.memory)) {
      return;
    }
    const memory = config.memory;
    if (!isPlainObject(memory.embeddings)) {
      return;
    }
    const embeddings = memory.embeddings;
    embeddings.provider = "auto";
    delete embeddings.gatewayModel;
    writeFileSync(configPath, JSON.stringify(config, null, 2) + "\n");
  },
};
