import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, test } from "bun:test";

import { dropInferenceProfilesMigration as MIG } from "../163-drop-inference-profiles.js";

let workspaceDir: string;
let configPath: string;

function write(obj: unknown): void {
  writeFileSync(configPath, JSON.stringify(obj, null, 2) + "\n");
}
function llm(): Record<string, unknown> {
  return (
    JSON.parse(readFileSync(configPath, "utf-8")) as {
      llm: Record<string, unknown>;
    }
  ).llm;
}

beforeEach(() => {
  workspaceDir = mkdtempSync(join(tmpdir(), "drop-inference-profiles-"));
  configPath = join(workspaceDir, "config.json");
});
afterEach(() => {
  rmSync(workspaceDir, { recursive: true, force: true });
});

describe("163-drop-inference-profiles", () => {
  test("has the expected id", () => {
    expect(MIG.id).toBe("163-drop-inference-profiles");
  });

  test("no-ops on an alias-era config", () => {
    write({
      llm: {
        defaultModel: "main",
        callSites: { mainAgent: {} },
        streamThinking: true,
      },
    });
    const before = readFileSync(configPath, "utf-8");

    MIG.run(workspaceDir);

    expect(readFileSync(configPath, "utf-8")).toBe(before);
  });

  test("maps profiles and tuning onto aliases", () => {
    write({
      llm: {
        profiles: {
          main: { provider: "openvpn", model: "main" },
          small: { provider: "openvpn", model: "small" },
        },
        activeProfile: "main",
        advisorProfile: "main",
        callSites: {
          mainAgent: { profile: "main" },
          conversationSummarization: { profile: "small" },
          inviteInstructionGenerator: {
            profile: "small",
            effort: "low",
            thinking: { enabled: false },
          },
          commitMessage: {
            profile: "small",
            maxTokens: 120,
            temperature: 0.2,
          },
          memoryV3SelectL2: {
            profile: "fast",
            temperature: 0,
            thinking: { enabled: false },
          },
          recall: {
            profile: "fast",
            maxTokens: 4096,
            temperature: 0,
            disableCache: true,
          },
          memoryRouter: {
            profile: "fast",
            contextWindow: { maxInputTokens: 1000000 },
          },
          vision: { profile: "main" },
          workflowLeaf: {
            profile: "main",
            effort: "low",
            thinking: { enabled: false },
          },
          emptyStateGreeting: { profile: "latency-optimized" },
          replySuggestion: {
            profile: "latency-optimized",
            disableCache: true,
          },
          conversationStarters: { profile: "latency-optimized" },
          guardianQuestionCopy: { profile: "latency-optimized" },
          homeGreeting: { profile: "latency-optimized", maxTokens: 60 },
          homeSuggestedPrompts: { profile: "latency-optimized" },
        },
      },
    });

    MIG.run(workspaceDir);
    const migrated = llm();

    expect(migrated.defaultModel).toBe("main");
    expect(migrated.streamThinking).toBe(true);
    expect(migrated.profiles).toBeUndefined();
    expect(migrated.activeProfile).toBeUndefined();
    expect(migrated.advisorProfile).toBeUndefined();
    expect(migrated.defaultProvider).toBeUndefined();
    expect(migrated.profileSession).toBeUndefined();
    expect(migrated.pricingOverrides).toBeUndefined();

    const callSites = migrated.callSites as Record<string, unknown>;
    expect(callSites.mainAgent).toEqual({});
    expect(callSites.conversationSummarization).toEqual({ model: "small" });
    expect(callSites.inviteInstructionGenerator).toEqual({ model: "fast" });
    expect(callSites.commitMessage).toEqual({ model: "title" });
    expect(callSites.memoryV3SelectL2).toEqual({ model: "recall" });
    expect(callSites.recall).toEqual({ model: "recall", disableCache: true });
    expect(callSites.memoryRouter).toEqual({
      model: "fast",
      contextWindow: { maxInputTokens: 1000000 },
    });
    expect(callSites.vision).toEqual({ model: "vision" });
    expect(callSites.workflowLeaf).toEqual({});
    expect(callSites.emptyStateGreeting).toEqual({ enabled: false });
    expect(callSites.replySuggestion).toEqual({ enabled: false });
    expect(callSites.conversationStarters).toBeUndefined();
    expect(callSites.guardianQuestionCopy).toBeUndefined();
    expect(callSites.homeGreeting).toBeUndefined();
    expect(callSites.homeSuggestedPrompts).toBeUndefined();
  });

  test("is idempotent", () => {
    write({
      llm: {
        profiles: { main: { provider: "openvpn", model: "main" } },
        activeProfile: "main",
        callSites: { conversationTitle: { profile: "main" } },
      },
    });
    MIG.run(workspaceDir);
    const once = readFileSync(configPath, "utf-8");
    MIG.run(workspaceDir);
    expect(readFileSync(configPath, "utf-8")).toBe(once);
  });
});
