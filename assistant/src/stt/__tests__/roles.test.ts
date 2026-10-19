/**
 * Per-consumer STT role selection.
 *
 * These cover the two pure functions every consumer routes through: which
 * `{provider, model}` pair a role names, and which catalog row that pair
 * resolves to. The resolvers, the config schema and the capability gate all
 * read the same pair, so a drift here is a drift everywhere.
 */
import { describe, expect, test } from "bun:test";

import {
  sttCatalogKeyForRole,
  sttRoleCapabilityGap,
  sttSelectionForRole,
} from "../roles.js";

describe("sttSelectionForRole", () => {
  test("a role's own entry wins over the global provider", () => {
    expect(
      sttSelectionForRole(
        {
          provider: "openai-whisper",
          roles: { dictation: { provider: "deepgram" } },
        },
        "dictation",
      ),
    ).toEqual({ provider: "deepgram" });
  });

  test("an unset role falls back to the global provider and its family", () => {
    expect(
      sttSelectionForRole(
        {
          provider: "deepgram",
          providers: { deepgram: { model: "flux" } },
          roles: { dictation: { provider: "openai-whisper" } },
        },
        "liveVoice",
      ),
    ).toEqual({ provider: "deepgram", model: "flux" });
  });

  test("a roleless caller reads the global provider", () => {
    expect(
      sttSelectionForRole(
        {
          provider: "openai-whisper",
          roles: { dictation: { provider: "deepgram" } },
        },
        undefined,
      ),
    ).toEqual({ provider: "openai-whisper" });
  });

  test("a role override does not inherit the global provider's family", () => {
    // The override names the whole pair. Carrying `flux` across from the
    // global would pin the override to a family it never asked for.
    expect(
      sttSelectionForRole(
        {
          provider: "deepgram",
          providers: { deepgram: { model: "flux" } },
          roles: { batch: { provider: "deepgram" } },
        },
        "batch",
      ),
    ).toEqual({ provider: "deepgram" });
  });
});

describe("sttCatalogKeyForRole", () => {
  test("a role's family selects the variant row", () => {
    expect(
      sttCatalogKeyForRole(
        {
          provider: "deepgram",
          roles: { liveVoice: { provider: "deepgram", model: "flux" } },
        },
        "liveVoice",
      ),
    ).toBe("deepgram-flux");
  });

  test("two roles on one provider resolve to different rows", () => {
    const stt = {
      provider: "deepgram",
      roles: {
        liveVoice: { provider: "deepgram", model: "flux" },
        batch: { provider: "deepgram" },
      },
    };

    expect(sttCatalogKeyForRole(stt, "liveVoice")).toBe("deepgram-flux");
    expect(sttCatalogKeyForRole(stt, "batch")).toBe("deepgram");
  });

  test("the migrated config routes batch to the gateway and streaming to vellum", () => {
    const stt = {
      provider: "gateway",
      providers: { gateway: { model: "stt" } },
      roles: {
        liveVoice: { provider: "vellum" },
        telephony: { provider: "vellum" },
        dictation: { provider: "vellum" },
        watch: { provider: "vellum" },
      },
    };

    expect(sttCatalogKeyForRole(stt, "batch")).toBe("gateway");
    expect(sttCatalogKeyForRole(stt, undefined)).toBe("gateway");
    for (const role of [
      "liveVoice",
      "telephony",
      "dictation",
      "watch",
    ] as const) {
      expect(sttCatalogKeyForRole(stt, role)).toBe("vellum");
    }
  });
});

describe("sttRoleCapabilityGap", () => {
  test("batch accepts the gateway", () => {
    expect(sttRoleCapabilityGap("batch", { provider: "gateway" })).toBeNull();
  });

  test("live voice rejects the gateway, which has no streaming boundary", () => {
    const gap = sttRoleCapabilityGap("liveVoice", { provider: "gateway" });
    expect(gap).toContain("gateway");
    expect(gap).toContain("daemon-streaming");
  });

  test("telephony rejects the gateway, which has no telephony mode", () => {
    const gap = sttRoleCapabilityGap("telephony", { provider: "gateway" });
    expect(gap).not.toBeNull();
  });
  test("live voice accepts a streaming-only family", () => {
    expect(
      sttRoleCapabilityGap("liveVoice", {
        provider: "deepgram",
        model: "flux",
      }),
    ).toBeNull();
  });

  test("batch rejects the same family, which has no batch endpoint", () => {
    const gap = sttRoleCapabilityGap("batch", {
      provider: "deepgram",
      model: "flux",
    });

    expect(gap).toContain("deepgram-flux");
    expect(gap).toContain("batch");
  });

  test("capability is judged on the resolved row, not the bare provider", () => {
    // The pair is what distinguishes them: base deepgram batches and the
    // flux family does not, under one provider id.
    expect(sttRoleCapabilityGap("batch", { provider: "deepgram" })).toBeNull();
  });

  test("telephony rejects a provider that does not transcribe calls", () => {
    const gap = sttRoleCapabilityGap("telephony", {
      provider: "deepgram",
      model: "flux",
    });

    expect(gap).not.toBeNull();
  });

  test("watch accepts a streaming-only family, having no batch leg", () => {
    // Watch shares dictation's transport but not its batch fallback, so a
    // family dictation must reject is legal here.
    expect(
      sttRoleCapabilityGap("watch", { provider: "deepgram", model: "flux" }),
    ).toBeNull();
    expect(
      sttRoleCapabilityGap("dictation", {
        provider: "deepgram",
        model: "flux",
      }),
    ).not.toBeNull();
  });

  test("an unknown provider is named rather than silently accepted", () => {
    expect(sttRoleCapabilityGap("batch", { provider: "not-a-provider" })).toBe(
      '"not-a-provider" is not in the STT provider catalog',
    );
  });
});
