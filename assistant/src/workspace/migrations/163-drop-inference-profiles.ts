import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { getLogger } from "../../util/logger.js";
import type { WorkspaceMigration } from "./types.js";

const log = getLogger("workspace-migration-163");

/** Legacy profile key to gateway alias. */
const PROFILE_TO_ALIAS: Record<string, string> = {
  balanced: "main",
  "quality-optimized": "main-pro",
  "cost-optimized": "small",
  "latency-optimized": "fast",
  "jev-managed": "fast",
  main: "main",
  "main-pro": "main-pro",
  small: "small",
  fast: "fast",
};

/** Call sites whose design maps them to a dedicated alias. */
const SPECIAL_ALIAS: Record<string, string> = {
  commitMessage: "title",
  memoryV3SelectL2: "recall",
  recall: "recall",
  vision: "vision",
  inviteInstructionGenerator: "fast",
  skillCategoryInference: "fast",
};

/** Call sites removed with the feature they served. */
const REMOVED_CALL_SITES = new Set([
  "conversationStarters",
  "guardianQuestionCopy",
  "homeGreeting",
  "homeSuggestedPrompts",
  "autoProfileRouter",
]);

/** Call sites kept but disabled. */
const DISABLED_CALL_SITES = new Set(["emptyStateGreeting", "replySuggestion"]);

const KNOWN_ALIASES = new Set([
  "main",
  "main-pro",
  "small",
  "fast",
  "recall",
  "title",
  "vision",
  "embed",
]);

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return value != null && typeof value === "object" && !Array.isArray(value);
}

function aliasForProfile(
  llm: Record<string, unknown>,
  profileKey: string,
): string | undefined {
  const mapped = PROFILE_TO_ALIAS[profileKey];
  if (mapped != null) {
    return mapped;
  }
  const profiles = isPlainObject(llm.profiles) ? llm.profiles : {};
  const entry = isPlainObject(profiles[profileKey])
    ? (profiles[profileKey] as Record<string, unknown>)
    : undefined;
  const model = entry?.model;
  return typeof model === "string" && KNOWN_ALIASES.has(model)
    ? model
    : undefined;
}

function aliasForCallSite(
  llm: Record<string, unknown>,
  callSite: string,
  site: Record<string, unknown>,
): string | undefined {
  const special = SPECIAL_ALIAS[callSite];
  if (special != null) {
    return special;
  }
  const profile = site.profile;
  return typeof profile === "string"
    ? aliasForProfile(llm, profile)
    : undefined;
}

function isLegacyConfig(llm: Record<string, unknown>): boolean {
  if (
    isPlainObject(llm.profiles) ||
    typeof llm.activeProfile === "string" ||
    typeof llm.advisorProfile === "string"
  ) {
    return true;
  }
  if (llm.callSites != null && isPlainObject(llm.callSites)) {
    return Object.values(llm.callSites).some(
      (site) => isPlainObject(site) && typeof site.profile === "string",
    );
  }
  return false;
}

/**
 * Replace the inference-profile configuration with gateway aliases.
 *
 * Runs only when the config still carries legacy profile state, so it is a
 * no-op on an already-migrated workspace and on a fresh install (whose
 * schema defaults already express the alias model).
 */
export const dropInferenceProfilesMigration: WorkspaceMigration = {
  id: "163-drop-inference-profiles",
  description:
    "Replace inference profiles with gateway aliases: defaultModel, per-call-site model/enabled, and removed profile state",
  retryFailedCheckpoint: true,

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
    if (!isPlainObject(config) || !isPlainObject(config.llm)) {
      return;
    }
    const llm = config.llm;
    if (!isLegacyConfig(llm)) {
      return;
    }

    const activeProfile =
      typeof llm.activeProfile === "string" ? llm.activeProfile : undefined;
    const defaultModel =
      (activeProfile != null
        ? aliasForProfile(llm, activeProfile)
        : undefined) ?? "main";
    llm.defaultModel = defaultModel;
    llm.streamThinking = resolveStreamThinking(llm);

    const callSites = isPlainObject(llm.callSites) ? llm.callSites : {};
    const nextCallSites: Record<string, unknown> = {};
    for (const [callSite, rawSite] of Object.entries(callSites)) {
      if (!isPlainObject(rawSite)) {
        continue;
      }
      if (REMOVED_CALL_SITES.has(callSite)) {
        continue;
      }
      if (DISABLED_CALL_SITES.has(callSite)) {
        nextCallSites[callSite] = { enabled: false };
        continue;
      }
      if (callSite === "mainAgent" || callSite === "workflowLeaf") {
        // These sites follow the conversation's own model selection when one
        // is active, never a workspace-level pin.
        nextCallSites[callSite] = {};
        continue;
      }
      const model = aliasForCallSite(llm, callSite, rawSite);
      if (model == null) {
        // An entry with no resolvable profile is an inherit entry.
        nextCallSites[callSite] = {};
        continue;
      }
      const next: Record<string, unknown> = { model };
      if (rawSite.disableCache === true) {
        next.disableCache = true;
      }
      const contextWindow = rawSite.contextWindow;
      if (
        isPlainObject(contextWindow) &&
        typeof contextWindow.maxInputTokens === "number"
      ) {
        next.contextWindow = { maxInputTokens: contextWindow.maxInputTokens };
      }
      nextCallSites[callSite] = next;
    }
    llm.callSites = nextCallSites;

    delete llm.profiles;
    delete llm.profileOrder;
    delete llm.activeProfile;
    delete llm.advisorProfile;
    delete llm.defaultProvider;
    delete llm.profileSession;
    delete llm.pricingOverrides;

    writeFileSync(configPath, JSON.stringify(config, null, 2) + "\n");
    log.info("Migrated inference profiles to gateway aliases");
  },

  down(workspaceDir: string): void {
    // The old profile bodies and tuning are collapsed by design, so the
    // reverse rebuilds only the shape, never the lost configuration.
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
    if (!isPlainObject(config) || !isPlainObject(config.llm)) {
      return;
    }
    const llm = config.llm;
    llm.profiles = {};
    llm.profileOrder = [];
    llm.activeProfile = llm.defaultModel ?? "main";
    delete llm.defaultModel;
    delete llm.streamThinking;
    writeFileSync(configPath, JSON.stringify(config, null, 2) + "\n");
  },
};

function resolveStreamThinking(llm: Record<string, unknown>): boolean {
  if (typeof llm.streamThinking === "boolean") {
    return llm.streamThinking;
  }
  const callSites = isPlainObject(llm.callSites) ? llm.callSites : {};
  const mainAgent = isPlainObject(callSites.mainAgent)
    ? callSites.mainAgent
    : {};
  const thinking = isPlainObject(mainAgent.thinking) ? mainAgent.thinking : {};
  return typeof thinking.streamThinking === "boolean"
    ? thinking.streamThinking
    : true;
}
