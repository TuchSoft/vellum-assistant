import { afterEach, beforeEach, describe, expect, test } from "bun:test";

import {
  __setCatalogSnapshotForTests,
  type CatalogSnapshot,
} from "../llm-catalog.js";
import {
  isCallSiteDisabled,
  ModelNotInCatalogError,
  resolveCallSite,
  resolveCallSiteConfig,
  resolveEffectiveModel,
} from "../llm-resolver.js";
import { LLMSchema } from "../schemas/llm.js";

const catalog: CatalogSnapshot = {
  fetchedAt: 1,
  source: "gateway",
  entries: [
    {
      alias: "main",
      label: "Main",
      maxInputTokens: 200000,
      maxOutputTokens: 64000,
      supportsVision: false,
      supportsTools: true,
      mode: "chat",
    },
    {
      alias: "main-pro",
      label: "Main Pro",
      maxInputTokens: 200000,
      maxOutputTokens: 64000,
      supportsVision: false,
      supportsTools: true,
      mode: "chat",
    },
    {
      alias: "fast",
      label: "Fast",
      maxInputTokens: 200000,
      maxOutputTokens: 16000,
      supportsVision: false,
      supportsTools: true,
      mode: "chat",
    },
    {
      alias: "title",
      label: "Title",
      maxInputTokens: 200000,
      maxOutputTokens: 120,
      supportsVision: false,
      supportsTools: false,
      mode: "chat",
    },
  ],
};

beforeEach(() => {
  __setCatalogSnapshotForTests(catalog);
});
afterEach(() => {
  __setCatalogSnapshotForTests(undefined);
});

const llm = (input: unknown = {}) => LLMSchema.parse(input);

describe("resolveCallSite", () => {
  test("uses the shipped call-site default", () => {
    const resolution = resolveCallSite("conversationTitle", llm());
    expect(resolution.status).toBe("ok");
    if (resolution.status !== "ok") {
      return;
    }
    expect(resolution.model).toBe("fast");
    expect(resolution.source).toBe("call_site");
    expect(resolution.config.disableCache).toBe(true);
  });

  test("workspace model overrides the shipped default", () => {
    const resolution = resolveCallSite(
      "conversationTitle",
      llm({ callSites: { conversationTitle: { model: "main" } } }),
    );
    expect(resolution.status === "ok" && resolution.model).toBe("main");
  });

  test("an explicit pin outranks the call-site default", () => {
    const resolution = resolveCallSite("conversationTitle", llm(), {
      model: "main",
    });
    expect(resolution.status === "ok" && resolution.source).toBe("pinned");
    expect(resolution.status === "ok" && resolution.model).toBe("main");
  });

  test("the chat selection applies below the call-site pin and above the default", () => {
    const noPin = resolveCallSite("mainAgent", llm(), {
      conversationModel: "main-pro",
    });
    expect(noPin.status === "ok" && noPin.model).toBe("main-pro");
    expect(noPin.status === "ok" && noPin.source).toBe("chat");

    const pinned = resolveCallSite("conversationTitle", llm(), {
      conversationModel: "main-pro",
    });
    expect(pinned.status === "ok" && pinned.model).toBe("fast");
  });

  test("falls back to defaultModel when the call site inherits", () => {
    const resolution = resolveCallSite(
      "mainAgent",
      llm({ defaultModel: "main-pro" }),
    );
    expect(resolution.status === "ok" && resolution.model).toBe("main-pro");
    expect(resolution.status === "ok" && resolution.source).toBe("default");
  });

  test("a disabled call site resolves to the disabled outcome", () => {
    expect(resolveCallSite("replySuggestion", llm()).status).toBe("disabled");
    expect(isCallSiteDisabled("replySuggestion", llm())).toBe(true);
    expect(() => resolveCallSiteConfig("replySuggestion", llm())).toThrow();
  });

  test("an unknown explicit pin is a hard error", () => {
    expect(() =>
      resolveCallSite("mainAgent", llm(), { model: "missing" }),
    ).toThrow(ModelNotInCatalogError);
  });

  test("an unknown call-site alias falls through with a report", () => {
    const reported: string[] = [];
    const resolution = resolveCallSite(
      "conversationTitle",
      llm({ callSites: { conversationTitle: { model: "missing" } } }),
      {
        onResolutionFallback: ({ requested }) => reported.push(requested),
      },
    );
    expect(resolution.status === "ok" && resolution.model).toBe("main");
    expect(reported).toEqual(["missing"]);
  });

  test("resolveEffectiveModel reports null for a disabled site", () => {
    expect(resolveEffectiveModel("replySuggestion", llm())).toBeNull();
  });
});

describe("LLMSchema", () => {
  test("a disabled call site cannot pin an alias", () => {
    const parsed = LLMSchema.safeParse({
      callSites: { replySuggestion: { enabled: false, model: "main" } },
    });
    expect(parsed.success).toBe(false);
  });

  test("the main agent cannot be disabled", () => {
    const parsed = LLMSchema.safeParse({
      callSites: { mainAgent: { enabled: false } },
    });
    expect(parsed.success).toBe(false);
  });

  test("unknown call-site keys are dropped", () => {
    const parsed = LLMSchema.parse({
      callSites: { notACallSite: { model: "main" } },
    });
    expect(
      (parsed.callSites as Record<string, unknown>).notACallSite,
    ).toBeUndefined();
  });
});
