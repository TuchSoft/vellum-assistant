import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  afterAll,
  afterEach,
  beforeEach,
  describe,
  expect,
  test,
} from "bun:test";

import {
  __setCatalogSnapshotForTests,
  catalogSnapshotPath,
  getCatalogEntry,
  getCatalogSnapshot,
  isKnownAlias,
  listCatalogEntries,
  LLM_GATEWAY_URL_ENV,
  refreshCatalog,
} from "../llm-catalog.js";

const originalWorkspaceDir = process.env.VELLUM_WORKSPACE_DIR;
const originalGatewayUrl = process.env[LLM_GATEWAY_URL_ENV];
const originalFetch = globalThis.fetch;
let workspaceDir: string;

function modelInfoResponse() {
  return {
    data: [
      {
        model_name: "main",
        model_info: {
          max_input_tokens: 1050000,
          max_output_tokens: 393216,
          supports_vision: false,
          supports_function_calling: true,
          supports_reasoning: true,
          mode: "chat",
        },
      },
      {
        model_name: "embed",
        model_info: {
          max_input_tokens: 8192,
          supports_vision: null,
          supports_function_calling: null,
          mode: "embedding",
        },
      },
    ],
  };
}

function mockFetch(payload: unknown) {
  globalThis.fetch = (async () =>
    new Response(JSON.stringify(payload), {
      status: 200,
      headers: { "content-type": "application/json" },
    })) as unknown as typeof fetch;
}

beforeEach(() => {
  workspaceDir = mkdtempSync(join(tmpdir(), "llm-catalog-"));
  process.env.VELLUM_WORKSPACE_DIR = workspaceDir;
  process.env[LLM_GATEWAY_URL_ENV] = "http://gateway.test/v1";
  __setCatalogSnapshotForTests(undefined);
});

afterEach(() => {
  globalThis.fetch = originalFetch;
  __setCatalogSnapshotForTests(undefined);
  rmSync(workspaceDir, { recursive: true, force: true });
});

afterAll(() => {
  if (originalWorkspaceDir === undefined) {
    delete process.env.VELLUM_WORKSPACE_DIR;
  } else {
    process.env.VELLUM_WORKSPACE_DIR = originalWorkspaceDir;
  }
  if (originalGatewayUrl === undefined) {
    delete process.env[LLM_GATEWAY_URL_ENV];
  } else {
    process.env[LLM_GATEWAY_URL_ENV] = originalGatewayUrl;
  }
  globalThis.fetch = originalFetch;
});

describe("gateway catalog", () => {
  test("parses model_info into entries and writes the disk snapshot", async () => {
    mockFetch(modelInfoResponse());

    await refreshCatalog(true);

    const snapshot = getCatalogSnapshot();
    expect(snapshot.source).toBe("gateway");
    expect(snapshot.entries.map((entry) => entry.alias)).toEqual([
      "main",
      "embed",
    ]);

    const main = getCatalogEntry("main");
    expect(main?.maxInputTokens).toBe(1050000);
    expect(main?.maxOutputTokens).toBe(393216);
    expect(main?.supportsTools).toBe(true);
    expect(main?.supportsReasoning).toBe(true);
    expect(main?.mode).toBe("chat");

    const embed = getCatalogEntry("embed");
    expect(embed?.supportsVision).toBe(false);
    expect(embed?.supportsTools).toBe(false);
    expect(embed?.mode).toBe("embedding");
    expect(listCatalogEntries("embedding")).toHaveLength(1);

    const onDisk = JSON.parse(readFileSync(catalogSnapshotPath(), "utf-8"));
    expect(onDisk.entries).toHaveLength(2);
  });

  test("reads the disk snapshot after the in-memory copy is gone", async () => {
    mockFetch(modelInfoResponse());
    await refreshCatalog(true);

    __setCatalogSnapshotForTests(undefined);
    const hydrated = getCatalogSnapshot();
    expect(hydrated.source).toBe("disk");
    expect(hydrated.entries.map((entry) => entry.alias)).toEqual([
      "main",
      "embed",
    ]);
  });

  test("merges an id-only /models response with code-owned capabilities", async () => {
    globalThis.fetch = (async (input: unknown) => {
      const url = String(input);
      if (url.endsWith("/model/info")) {
        return new Response("not found", { status: 404 });
      }
      return new Response(
        JSON.stringify({ data: [{ id: "main" }, { id: "new-alias" }] }),
        { status: 200, headers: { "content-type": "application/json" } },
      );
    }) as unknown as typeof fetch;

    await refreshCatalog(true);

    expect(getCatalogEntry("main")?.maxOutputTokens).toBe(64000);
    const unknown = getCatalogEntry("new-alias");
    expect(unknown?.supportsTools).toBe(true);
    expect(unknown?.supportsVision).toBe(false);
  });

  test("falls back to the code-owned table when the gateway is unreachable", () => {
    globalThis.fetch = (async () => {
      throw new Error("offline");
    }) as unknown as typeof fetch;

    const snapshot = getCatalogSnapshot();
    expect(snapshot.source).toBe("fallback");
    expect(isKnownAlias("main")).toBe(true);
    expect(isKnownAlias("title")).toBe(true);
    expect(isKnownAlias("missing-alias")).toBe(false);
    expect(getCatalogEntry("vision")?.supportsVision).toBe(true);
  });
});
