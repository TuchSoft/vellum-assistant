/**
 * Call-site settings routes.
 *
 *   GET   /v1/config/llm/call-sites        - configured + effective alias
 *   PATCH /v1/config/llm/call-sites/:site  - pin or clear the alias, toggle
 *
 * The write path is exercised with the config loader and the shared config
 * commit stubbed, so the tests cover validation and payload shape without
 * touching the workspace or reinitializing providers.
 */

import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";

import {
  __setCatalogSnapshotForTests,
  type CatalogSnapshot,
} from "../../../config/llm-catalog.js";
import { __resetDegradationLogForTests } from "../../../config/llm-resolver.js";
import { LLMSchema } from "../../../config/schemas/llm.js";
import { BadRequestError } from "../errors.js";
import type { RouteDefinition, RouteHandlerArgs } from "../types.js";

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

let rawConfig: Record<string, unknown> = {};
let committed: { label: string } | null = null;

const actualLoader = await import("../../../config/loader.js");

mock.module("../../../config/loader.js", () => ({
  ...actualLoader,
  loadRawConfig: () => rawConfig,
  loadConfig: () => ({ llm: LLMSchema.parse(rawConfig.llm ?? {}) }),
}));

mock.module("../conversation-query-routes.js", () => ({
  commitConfigWrite: async (raw: Record<string, unknown>, label: string) => {
    rawConfig = raw;
    committed = { label };
  },
}));

const { ROUTES, applyCallSitePatch } =
  await import("../llm-call-sites-routes.js");

function route(operationId: string): RouteDefinition {
  const found = ROUTES.find((r) => r.operationId === operationId);
  if (!found) {
    throw new Error(`Route ${operationId} not found`);
  }
  return found;
}

function call(operationId: string, args: RouteHandlerArgs): Promise<unknown> {
  return Promise.resolve(route(operationId).handler(args));
}

type CatalogResponse = {
  catalogAvailable: boolean;
  callSites: {
    id: string;
    enabled: boolean;
    configuredModel: string | null;
    effectiveModel: string | null;
    degraded: boolean;
    reason: string | null;
    source?: string;
  }[];
};

function siteIn(response: unknown, id: string) {
  const catalogResponse = response as CatalogResponse;
  const site = catalogResponse.callSites.find((entry) => entry.id === id);
  if (!site) {
    throw new Error(`Call site ${id} missing from the response`);
  }
  return site;
}

beforeEach(() => {
  __setCatalogSnapshotForTests(catalog);
  __resetDegradationLogForTests();
  rawConfig = {
    llm: {
      defaultModel: "main",
      callSites: { conversationTitle: { model: "fast" } },
    },
  };
  committed = null;
});

afterEach(() => {
  __setCatalogSnapshotForTests(undefined);
});

describe("GET config/llm/call-sites", () => {
  test("exposes the configured alias, the effective alias and the catalog flag", async () => {
    const response = (await call("llm_call_sites_list", {})) as CatalogResponse;
    expect(response.catalogAvailable).toBe(true);
    const site = siteIn(response, "conversationTitle");
    expect(site.configuredModel).toBe("fast");
    expect(site.effectiveModel).toBe("fast");
    expect(site.degraded).toBe(false);
    expect(site.reason).toBeNull();
  });

  test("reports degradation when the pinned alias disappeared from the catalog", async () => {
    rawConfig = {
      llm: {
        defaultModel: "main",
        callSites: { conversationTitle: { model: "retired-alias" } },
      },
    };
    const response = (await call("llm_call_sites_list", {})) as CatalogResponse;
    const site = siteIn(response, "conversationTitle");
    expect(site.configuredModel).toBe("retired-alias");
    expect(site.effectiveModel).toBe("main");
    expect(site.degraded).toBe(true);
    expect(site.reason).toBe("call_site_alias_missing");
  });
});

describe("PATCH config/llm/call-sites/:site", () => {
  test("pins a catalog alias and commits through the shared config write", async () => {
    const response = (await call("llm_call_sites_update", {
      pathParams: { site: "conversationTitle" },
      body: { model: "main" },
    })) as CatalogResponse;

    const site = siteIn(response, "conversationTitle");
    expect(site.configuredModel).toBe("main");
    expect(site.effectiveModel).toBe("main");
    expect(site.degraded).toBe(false);
    expect(committed?.label).toBe("update call site");
    const llm = rawConfig.llm as {
      callSites: Record<string, { model?: string }>;
    };
    expect(llm.callSites.conversationTitle.model).toBe("main");
  });

  test("clears the alias so the call site inherits", async () => {
    const response = (await call("llm_call_sites_update", {
      pathParams: { site: "conversationTitle" },
      body: { model: null },
    })) as CatalogResponse;

    const site = siteIn(response, "conversationTitle");
    expect(site.configuredModel).toBeNull();
    expect(site.effectiveModel).toBe("fast");
    expect(site.source).toBe("call_site");
  });

  test("rejects an alias the catalog does not know", async () => {
    await expect(
      call("llm_call_sites_update", {
        pathParams: { site: "conversationTitle" },
        body: { model: "not-an-alias" },
      }),
    ).rejects.toBeInstanceOf(BadRequestError);
    expect(committed).toBeNull();
  });

  test("toggles enabled and reports a null effective alias when disabled", async () => {
    const response = (await call("llm_call_sites_update", {
      pathParams: { site: "conversationTitle" },
      body: { enabled: false, model: null },
    })) as CatalogResponse;

    const site = siteIn(response, "conversationTitle");
    expect(site.enabled).toBe(false);
    expect(site.effectiveModel).toBeNull();
    expect(site.degraded).toBe(false);
  });

  test("rejects disabling a call site that still pins an alias", async () => {
    await expect(
      call("llm_call_sites_update", {
        pathParams: { site: "conversationTitle" },
        body: { enabled: false },
      }),
    ).rejects.toBeInstanceOf(BadRequestError);
    expect(committed).toBeNull();
  });

  test("rejects disabling the main agent", async () => {
    await expect(
      call("llm_call_sites_update", {
        pathParams: { site: "mainAgent" },
        body: { enabled: false },
      }),
    ).rejects.toBeInstanceOf(BadRequestError);
  });

  test("rejects an unknown call site", async () => {
    await expect(
      call("llm_call_sites_update", {
        pathParams: { site: "not-a-site" },
        body: { model: "main" },
      }),
    ).rejects.toBeInstanceOf(BadRequestError);
  });

  test("requires at least one field", async () => {
    await expect(
      call("llm_call_sites_update", {
        pathParams: { site: "conversationTitle" },
        body: {},
      }),
    ).rejects.toBeInstanceOf(BadRequestError);
  });

  test("declares the settings.write scope", () => {
    expect(route("llm_call_sites_update").policy?.requiredScopes).toEqual([
      "settings.write",
    ]);
  });
});

describe("applyCallSitePatch", () => {
  test("preserves call-site fields the patch does not touch", () => {
    const raw: Record<string, unknown> = {
      llm: {
        callSites: {
          conversationTitle: { enabled: true, disableCache: true },
        },
      },
    };
    applyCallSitePatch({
      raw,
      site: "conversationTitle",
      patch: { model: "main" },
      availableAliases: ["main"],
    });
    const llm = raw.llm as {
      callSites: Record<string, { disableCache?: boolean; model?: string }>;
    };
    expect(llm.callSites.conversationTitle.disableCache).toBe(true);
    expect(llm.callSites.conversationTitle.model).toBe("main");
  });
});
