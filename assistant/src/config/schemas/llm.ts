import { z } from "zod";

/**
 * Unified LLM configuration schema.
 *
 * Every inference call goes through the LLM gateway, and the gateway owns the
 * model aliases and their tuning. This block therefore carries only what is
 * Vellum's own concern: which alias each call site uses, whether a call site
 * is enabled, per-call-site budgeting, and the conversation-level reasoning
 * stream toggle. Model parameters (max tokens, temperature, reasoning effort)
 * are shipped defaults on the gateway alias; sending them from here would
 * override those defaults on every request.
 */

// ---------------------------------------------------------------------------
// Call-site enum
// ---------------------------------------------------------------------------

/**
 * The complete set of LLM call-site identifiers the assistant emits.
 *
 * Each ID corresponds to a logical place in the codebase that produces an LLM
 * request. Adding or removing a call site is a config-schema change; keep this
 * list in sync with the resolver defaults and the call-site catalog.
 */
export const LLMCallSiteEnum = z.enum([
  "mainAgent",
  "subagentSpawn",
  "heartbeatAgent",
  "filingAgent",
  "compactionAgent",
  "callAgent",
  "memoryExtraction",
  "memoryConsolidation",
  "memoryRetrieval",
  "memoryV2Migration",
  "memoryV2Sweep",
  "memoryRouter",
  "memoryV3SelectL2",
  "memoryV2Consolidation",
  "memoryRetrospective",
  "recall",
  "narrativeRefinement",
  "patternScan",
  "conversationSummarization",
  "replySuggestion",
  "conversationTitle",
  "commitMessage",
  "identityIntro",
  "emptyStateGreeting",
  "notificationDecision",
  "preferenceExtraction",
  "approvalCopy",
  "approvalConversation",
  "interactionClassifier",
  "styleAnalyzer",
  "inviteInstructionGenerator",
  "skillCategoryInference",
  "inference",
  "vision",
  "voiceProgressNarration",
  "voiceFrontDoor",
  "voiceEscalationJudge",
  "voiceContinuationJudge",
  "voiceContinuationLabel",
  "trustRuleSuggestion",
  "workflowLeaf",
]);
export type LLMCallSite = z.infer<typeof LLMCallSiteEnum>;

const KNOWN_CALL_SITE_IDS = new Set<string>(LLMCallSiteEnum.options);

/**
 * Drop call-site keys the running enum does not know. A different assistant
 * version may have written them, and failing the whole `callSites` record for
 * one unknown sibling key would discard the user's other valid entries.
 */
export function dropUnknownCallSiteKeys(value: unknown): unknown {
  if (value == null || typeof value !== "object" || Array.isArray(value)) {
    return value;
  }
  const out: Record<string, unknown> = {};
  for (const [key, entry] of Object.entries(value as Record<string, unknown>)) {
    if (KNOWN_CALL_SITE_IDS.has(key)) {
      out[key] = entry;
    }
  }
  return out;
}

// ---------------------------------------------------------------------------
// Reasoning effort
// ---------------------------------------------------------------------------

/**
 * Conversation-level reasoning effort tier. `"none"` disables provider-side
 * reasoning. Absent means Vellum sends no `reasoning_effort` at all, so the
 * gateway alias default applies.
 */
export const ReasoningEffortEnum = z.enum([
  "none",
  "low",
  "medium",
  "high",
  "xhigh",
  "max",
]);
export type ReasoningEffort = z.infer<typeof ReasoningEffortEnum>;

// ---------------------------------------------------------------------------
// Thinking levels
// ---------------------------------------------------------------------------

/**
 * Gemini-style thinking depth knob. Retained for the Gemini provider module;
 * the gateway path does not consume it.
 */
export const THINKING_LEVELS = ["minimal", "low", "medium", "high"] as const;
export type ThinkingLevel = (typeof THINKING_LEVELS)[number];
const ThinkingLevelSchema = z.enum(THINKING_LEVELS);

export const ThinkingSchema = z.object({
  enabled: z.boolean().default(true),
  streamThinking: z.boolean().default(true),
  level: ThinkingLevelSchema.optional(),
});

export type ThinkingConfig = z.infer<typeof ThinkingSchema>;

// ---------------------------------------------------------------------------
// Context window (budgeting, not a model parameter)
// ---------------------------------------------------------------------------

const OverflowEnabledSchema = z.boolean();
const OverflowSafetyMarginRatioSchema = z.number().finite().gt(0).lt(1);
const OverflowMaxAttemptsSchema = z.number().int().positive();
const OverflowLatestTurnCompressionSchema = z.enum([
  "truncate",
  "summarize",
  "drop",
]);

const ContextOverflowRecoverySchema = z.object({
  enabled: OverflowEnabledSchema.default(true),
  safetyMarginRatio: OverflowSafetyMarginRatioSchema.default(0.05),
  maxAttempts: OverflowMaxAttemptsSchema.default(3),
  interactiveLatestTurnCompression:
    OverflowLatestTurnCompressionSchema.default("summarize"),
  nonInteractiveLatestTurnCompression:
    OverflowLatestTurnCompressionSchema.default("truncate"),
});

const ContextOverflowRecoveryFragmentSchema = z.object({
  enabled: OverflowEnabledSchema.optional(),
  safetyMarginRatio: OverflowSafetyMarginRatioSchema.optional(),
  maxAttempts: OverflowMaxAttemptsSchema.optional(),
  interactiveLatestTurnCompression:
    OverflowLatestTurnCompressionSchema.optional(),
  nonInteractiveLatestTurnCompression:
    OverflowLatestTurnCompressionSchema.optional(),
});

/** Conservative input budget used when the catalog carries no window. */
export const DEFAULT_CONTEXT_WINDOW_MAX_INPUT_TOKENS = 200000;

const ContextEnabledSchema = z.boolean();
const ContextMaxInputTokensSchema = z.number().int().positive();
const ContextTargetBudgetRatioSchema = z.number().finite().gt(0).lte(1);
const ContextCompactThresholdSchema = z.number().finite().gt(0).lte(1);
const ContextSummaryBudgetRatioSchema = z.number().finite().gt(0).lte(1);

export const ContextWindowSchema = z.object({
  enabled: ContextEnabledSchema.default(true),
  maxInputTokens: ContextMaxInputTokensSchema.default(
    DEFAULT_CONTEXT_WINDOW_MAX_INPUT_TOKENS,
  ),
  targetBudgetRatio: ContextTargetBudgetRatioSchema.default(0.3),
  compactThreshold: ContextCompactThresholdSchema.default(0.8),
  summaryBudgetRatio: ContextSummaryBudgetRatioSchema.default(0.05),
  overflowRecovery: ContextOverflowRecoverySchema.default(
    ContextOverflowRecoverySchema.parse({}),
  ),
});
export type ContextWindow = z.infer<typeof ContextWindowSchema>;

const ContextWindowDeepPartialSchema = z
  .object({
    enabled: ContextEnabledSchema.optional(),
    maxInputTokens: ContextMaxInputTokensSchema.optional(),
    targetBudgetRatio: ContextTargetBudgetRatioSchema.optional(),
    compactThreshold: ContextCompactThresholdSchema.optional(),
    summaryBudgetRatio: ContextSummaryBudgetRatioSchema.optional(),
    overflowRecovery: ContextOverflowRecoveryFragmentSchema.optional(),
  })
  .superRefine((cw, ctx) => {
    if (
      cw.targetBudgetRatio != null &&
      cw.compactThreshold != null &&
      cw.targetBudgetRatio >= cw.compactThreshold
    ) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["targetBudgetRatio"],
        message:
          "contextWindow.targetBudgetRatio must be less than contextWindow.compactThreshold",
      });
    }
    if (
      cw.targetBudgetRatio != null &&
      cw.summaryBudgetRatio != null &&
      cw.targetBudgetRatio <= cw.summaryBudgetRatio
    ) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["targetBudgetRatio"],
        message:
          "contextWindow.targetBudgetRatio must be greater than contextWindow.summaryBudgetRatio",
      });
    }
  });

// ---------------------------------------------------------------------------
// Per-call-site config and workspace catalog overrides
// ---------------------------------------------------------------------------

/**
 * Per-call-site config. Absent `model` inherits the interactive chat selection
 * and then `defaultModel`; absent `enabled` means enabled.
 */
export const LLMCallSiteConfig = z
  .object({
    enabled: z.boolean().optional(),
    model: z.string().min(1).optional(),
    disableCache: z.boolean().optional(),
    contextWindow: ContextWindowDeepPartialSchema.optional(),
  })
  .meta({ id: "LLMCallSiteConfig" });
export type LLMCallSiteConfig = z.infer<typeof LLMCallSiteConfig>;

/**
 * Manual capability/limit override for an alias the gateway does not describe.
 * Used only when the catalog has no entry for the alias.
 */
const CatalogOverrideSchema = z.object({
  maxInputTokens: ContextMaxInputTokensSchema.optional(),
  maxOutputTokens: z.number().int().positive().optional(),
  supportsVision: z.boolean().optional(),
  supportsTools: z.boolean().optional(),
  supportsReasoning: z.boolean().optional(),
});
export type CatalogOverride = z.infer<typeof CatalogOverrideSchema>;

export const LLMSchema = z
  .object({
    defaultModel: z.string().min(1).default("main"),
    callSites: z.preprocess(
      dropUnknownCallSiteKeys,
      z.partialRecord(LLMCallSiteEnum, LLMCallSiteConfig).default({}),
    ),
    streamThinking: z.boolean().default(true),
    catalogOverrides: z
      .record(z.string().min(1), CatalogOverrideSchema)
      .default({}),
  })
  .superRefine((config, ctx) => {
    for (const [siteId, site] of Object.entries(config.callSites ?? {})) {
      if (site?.enabled === false && site.model != null) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ["callSites", siteId, "model"],
          message: "A disabled call site cannot pin an alias",
        });
      }
    }
    if (config.callSites?.mainAgent?.enabled === false) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["callSites", "mainAgent", "enabled"],
        message: "The main agent call site cannot be disabled",
      });
    }
  });

export type LLMConfig = z.infer<typeof LLMSchema>;
