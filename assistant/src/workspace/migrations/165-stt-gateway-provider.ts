import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { STT_ROLE_REQUIREMENTS, STT_ROLES } from "../../stt/roles.js";
import { getLogger } from "../../util/logger.js";
import type { WorkspaceMigration } from "./types.js";

const log = getLogger("workspace-migration-165");

/** Catalog alias the gateway runs for speech-to-text. */
const GATEWAY_STT_MODEL = "stt";

/**
 * Provider the streaming and telephony roles keep.
 *
 * `services.stt.provider` is the fallback for every role that has no explicit
 * selection, so moving the global to the batch-only gateway would silently
 * leave live voice, dictation, watch and telephony without a transcriber.
 */
const STREAMING_PROVIDER = "vellum";

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return value != null && typeof value === "object" && !Array.isArray(value);
}

/**
 * Point speech-to-text at the LLM gateway.
 *
 * The gateway is the single provider and the single credential for every
 * modality, so batch transcription rides the same connection as chat and
 * embeddings. Streaming and telephony cannot: the gateway exposes only the
 * batch endpoint. Their roles are therefore pinned to the managed provider
 * explicitly instead of inheriting the new global and resolving no
 * transcriber.
 *
 * An existing explicit role selection is never overwritten: a user who chose
 * a streaming provider keeps it, and config validation is where an
 * incompatible choice surfaces.
 */
export const sttGatewayProviderMigration: WorkspaceMigration = {
  id: "165-stt-gateway-provider",
  description:
    "Use the LLM gateway (catalog alias 'stt') for batch speech-to-text, keeping streaming and telephony roles on their own provider",

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

    const services = isPlainObject(config.services) ? config.services : {};
    const stt = isPlainObject(services.stt) ? services.stt : {};
    const providers = isPlainObject(stt.providers) ? stt.providers : {};
    const gateway = isPlainObject(providers.gateway) ? providers.gateway : {};
    const roles = isPlainObject(stt.roles) ? stt.roles : {};

    const nextRoles: Record<string, unknown> = { ...roles };
    for (const role of STT_ROLES) {
      const requirements = STT_ROLE_REQUIREMENTS[role];
      const needsStreaming =
        requirements.requiresTelephony ||
        requirements.boundaries.includes("daemon-streaming");
      if (needsStreaming && nextRoles[role] === undefined) {
        nextRoles[role] = { provider: STREAMING_PROVIDER };
      }
    }

    const alreadyApplied =
      stt.provider === "gateway" &&
      gateway.model === GATEWAY_STT_MODEL &&
      JSON.stringify(roles) === JSON.stringify(nextRoles);
    if (alreadyApplied) {
      return;
    }

    stt.provider = "gateway";
    providers.gateway = { ...gateway, model: GATEWAY_STT_MODEL };
    stt.providers = providers;
    stt.roles = nextRoles;
    services.stt = stt;
    config.services = services;

    writeFileSync(configPath, JSON.stringify(config, null, 2) + "\n");
    log.info(
      "Pointed batch speech-to-text at the LLM gateway and pinned streaming roles",
    );
  },

  down(workspaceDir: string): void {
    // The pre-migration provider cannot be recovered, so fall back to the
    // managed provider every streaming role already names. Role entries are
    // left in place: they remain valid and deleting them could discard an
    // explicit user selection.
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
    if (!isPlainObject(config.services)) {
      return;
    }
    const services = config.services;
    if (!isPlainObject(services.stt)) {
      return;
    }
    const stt = services.stt;
    stt.provider = STREAMING_PROVIDER;
    if (isPlainObject(stt.providers)) {
      delete stt.providers.gateway;
    }
    writeFileSync(configPath, JSON.stringify(config, null, 2) + "\n");
  },
};
