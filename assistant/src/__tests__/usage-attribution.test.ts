import { describe, expect, mock, test } from "bun:test";

import { LLMSchema } from "../config/schemas/llm.js";

const config = {
  llm: LLMSchema.parse({
    defaultModel: "main",
    callSites: {
      conversationTitle: { model: "title" },
      vision: { model: "vision" },
      replySuggestion: { enabled: false },
    },
  }),
};

mock.module("../config/loader.js", () => ({
  getConfig: () => config,
  getConfigReadOnly: () => config,
}));

const { resolveUsageAttribution, toAttributionColumns } =
  await import("../usage/attribution.js");

describe("resolveUsageAttribution", () => {
  test("attributes the call-site alias and rung", () => {
    const snapshot = resolveUsageAttribution({
      callSite: "conversationTitle",
    });
    expect(snapshot.model).toBe("title");
    expect(snapshot.modelSource).toBe("call_site");
    expect(snapshot.resolvedProvider).toBe("llm-gateway");
  });

  test("an explicit pin wins and is reported as pinned", () => {
    const snapshot = resolveUsageAttribution({
      callSite: "conversationTitle",
      model: "main",
    });
    expect(snapshot.model).toBe("main");
    expect(snapshot.modelSource).toBe("pinned");
  });

  test("the conversation selection applies below the call-site pin", () => {
    const snapshot = resolveUsageAttribution({
      callSite: "mainAgent",
      conversationModel: "main-pro",
    });
    expect(snapshot.model).toBe("main-pro");
    expect(snapshot.modelSource).toBe("chat");
  });

  test("a disabled call site resolves no model", () => {
    const snapshot = resolveUsageAttribution({
      callSite: "replySuggestion",
    });
    expect(snapshot.model).toBeNull();
    expect(snapshot.modelSource).toBe("unknown");
  });

  test("maps to the shared telemetry columns", () => {
    expect(
      toAttributionColumns({
        callSite: "mainAgent",
        model: "main",
        modelSource: "default",
        resolvedProvider: "llm-gateway",
        resolvedModel: "main",
      }),
    ).toEqual({
      provider: "llm-gateway",
      model: "main",
      modelSource: "default",
    });
  });
});
