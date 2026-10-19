import type { LLMCallSite } from "./schemas/llm.js";

/**
 * Code-owned alias defaults, one entry per call site.
 *
 * The workspace `llm.callSites` entry layers over these field by field, so an
 * entry that only pins a model repoints the selection without discarding the
 * shipped budgeting behavior.
 */
export interface CallSiteDefaultConfig {
  /** Absent means enabled. */
  enabled?: boolean;
  /** Gateway alias. Absent inherits the chat selection, then `defaultModel`. */
  model?: string;
  /**
   * Opt the call site out of prompt caching. Set for one-shot call sites whose
   * prompts never repeat.
   */
  disableCache?: boolean;
  /** Manual input budget cap; the catalog window is the other bound. */
  contextWindow?: { maxInputTokens?: number };
}

export const CALL_SITE_DEFAULTS: Record<LLMCallSite, CallSiteDefaultConfig> = {
  // The interactive turn. No model default: it inherits the conversation's
  // model selection, then `defaultModel`.
  mainAgent: {},

  subagentSpawn: { model: "main" },
  heartbeatAgent: { model: "main" },
  filingAgent: { model: "main" },
  compactionAgent: { model: "main" },
  callAgent: { model: "main" },
  memoryExtraction: { model: "main" },
  memoryV2Migration: { model: "main" },
  memoryV2Sweep: { model: "main" },
  memoryV2Consolidation: { model: "main" },
  memoryRetrospective: { model: "main" },
  narrativeRefinement: { model: "main" },
  patternScan: { model: "main" },
  identityIntro: { model: "main" },
  memoryConsolidation: { model: "main", disableCache: true },

  conversationSummarization: { model: "small" },
  approvalCopy: { model: "small" },
  styleAnalyzer: { model: "small" },
  inference: { model: "small" },

  inviteInstructionGenerator: { model: "fast" },
  skillCategoryInference: { model: "fast" },

  commitMessage: { model: "title" },

  memoryRetrieval: { model: "fast" },
  approvalConversation: { model: "fast" },
  trustRuleSuggestion: { model: "fast" },
  conversationTitle: { model: "fast", disableCache: true },
  notificationDecision: { model: "fast" },
  preferenceExtraction: { model: "fast" },
  interactionClassifier: { model: "fast" },
  voiceFrontDoor: { model: "fast" },
  voiceProgressNarration: { model: "fast" },
  voiceEscalationJudge: { model: "fast" },
  voiceContinuationJudge: { model: "small" },
  voiceContinuationLabel: { model: "small", disableCache: true },

  memoryRouter: {
    model: "fast",
    contextWindow: { maxInputTokens: 1000000 },
  },
  memoryV3SelectL2: { model: "recall" },
  recall: { model: "recall", disableCache: true },

  vision: { model: "vision" },

  // Inherits the chat selection inside a conversation, `defaultModel`
  // otherwise.
  workflowLeaf: {},

  emptyStateGreeting: { enabled: false },
  replySuggestion: { enabled: false },
};
