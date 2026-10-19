import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";

import type { AssistantConfig } from "../../config/types.js";
import {
  clearEmbeddingBackendCache,
  selectEmbeddingBackend,
} from "./embedding-backend.js";
import {
  GatewayEmbeddingBackend,
  gatewayTargetCacheExtras,
  resolveGatewayEmbeddingTarget,
  trimGatewayBaseUrl,
} from "./embedding-gateway.js";

const ENV_URL = "VELLUM_LLM_GATEWAY_URL";
const ENV_KEY = "VELLUM_LLM_GATEWAY_API_KEY";
const originalFetch = globalThis.fetch;
const originalEnv = {
  url: process.env[ENV_URL],
  key: process.env[ENV_KEY],
};

function restoreEnv(): void {
  if (originalEnv.url === undefined) {
    delete process.env[ENV_URL];
  } else {
    process.env[ENV_URL] = originalEnv.url;
  }
  if (originalEnv.key === undefined) {
    delete process.env[ENV_KEY];
  } else {
    process.env[ENV_KEY] = originalEnv.key;
  }
}

beforeEach(() => {
  delete process.env[ENV_URL];
  delete process.env[ENV_KEY];
  clearEmbeddingBackendCache();
});

afterEach(() => {
  globalThis.fetch = originalFetch;
  restoreEnv();
  clearEmbeddingBackendCache();
});

describe("trimGatewayBaseUrl", () => {
  test("trims whitespace and trailing slashes", () => {
    expect(trimGatewayBaseUrl("  http://llm-gateway:4000/v1/  ")).toBe(
      "http://llm-gateway:4000/v1",
    );
  });
});

describe("resolveGatewayEmbeddingTarget", () => {
  test("rejects an empty alias", async () => {
    const resolution = await resolveGatewayEmbeddingTarget("   ");
    expect(resolution.ok).toBe(false);
    if (!resolution.ok) {
      expect(resolution.error).toMatch(/gatewayModel/);
    }
  });

  test("fails clearly when no gateway connection resolves", async () => {
    const resolution = await resolveGatewayEmbeddingTarget("embed");
    expect(resolution.ok).toBe(false);
    if (!resolution.ok) {
      expect(resolution.error).toMatch(/LLM gateway connection/);
    }
  });

  test("resolves the gateway env endpoint with its auth header", async () => {
    process.env[ENV_URL] = "http://llm-gateway:4000/v1/";
    process.env[ENV_KEY] = "gw-key";

    const resolution = await resolveGatewayEmbeddingTarget("embed", 1024);

    expect(resolution.ok).toBe(true);
    if (resolution.ok) {
      expect(resolution.target.baseUrl).toBe("http://llm-gateway:4000/v1");
      expect(resolution.target.model).toBe("embed");
      expect(resolution.target.dimensions).toBe(1024);
      expect(resolution.target.headers.Authorization).toBe("Bearer gw-key");
    }
  });
});

describe("GatewayEmbeddingBackend", () => {
  const target = {
    baseUrl: "http://llm-gateway:4000/v1",
    model: "embed",
    headers: { Authorization: "Bearer gw-key" },
  };

  test("posts every input in one OpenAI-compatible request", async () => {
    const fetchMock = mock(
      async () =>
        new Response(
          JSON.stringify({
            data: [{ embedding: [0.1, 0.2] }, { embedding: [0.3, 0.4] }],
          }),
          { status: 200, headers: { "Content-Type": "application/json" } },
        ),
    );
    globalThis.fetch = fetchMock as unknown as typeof fetch;

    const backend = new GatewayEmbeddingBackend(target);
    const vectors = await backend.embed(["hello", "world"]);

    expect(vectors).toEqual([
      [0.1, 0.2],
      [0.3, 0.4],
    ]);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0] as unknown as [
      string,
      RequestInit,
    ];
    expect(url).toBe("http://llm-gateway:4000/v1/embeddings");
    expect(init.method).toBe("POST");
    expect((init.headers as Record<string, string>).Authorization).toBe(
      "Bearer gw-key",
    );
    expect(JSON.parse(String(init.body))).toEqual({
      model: "embed",
      input: ["hello", "world"],
    });
  });

  test("forwards the configured dimensions", async () => {
    const fetchMock = mock(
      async () =>
        new Response(JSON.stringify({ data: [{ embedding: [0.1] }] }), {
          status: 200,
        }),
    );
    globalThis.fetch = fetchMock as unknown as typeof fetch;

    const backend = new GatewayEmbeddingBackend({
      ...target,
      dimensions: 1024,
    });
    await backend.embed(["hello"]);

    const [, init] = fetchMock.mock.calls[0] as unknown as [
      string,
      RequestInit,
    ];
    expect(JSON.parse(String(init.body))).toEqual({
      model: "embed",
      input: ["hello"],
      dimensions: 1024,
    });
  });

  test("returns no vectors without a request for empty input", async () => {
    const fetchMock = mock(async () => new Response("{}", { status: 200 }));
    globalThis.fetch = fetchMock as unknown as typeof fetch;

    const backend = new GatewayEmbeddingBackend(target);

    expect(await backend.embed([])).toEqual([]);
    expect(fetchMock).toHaveBeenCalledTimes(0);
  });

  test("throws a clear error on a non-ok response", async () => {
    globalThis.fetch = mock(
      async () => new Response("no capacity", { status: 429 }),
    ) as unknown as typeof fetch;

    const backend = new GatewayEmbeddingBackend(target);

    await expect(backend.embed(["hello"])).rejects.toThrow(
      /Gateway embeddings request failed \(429\): no capacity/,
    );
  });

  test("throws when the response has no vectors", async () => {
    globalThis.fetch = mock(
      async () => new Response(JSON.stringify({}), { status: 200 }),
    ) as unknown as typeof fetch;

    const backend = new GatewayEmbeddingBackend(target);

    await expect(backend.embed(["hello"])).rejects.toThrow(/missing vectors/);
  });

  test("rejects non-text input", async () => {
    const backend = new GatewayEmbeddingBackend(target);

    await expect(
      backend.embed([
        {
          type: "image",
          data: Buffer.from("x"),
          mimeType: "image/png",
        },
      ]),
    ).rejects.toThrow(/only supports text inputs/);
  });
});

describe("GatewayEmbeddingBackend batching", () => {
  test("splits 40 inputs into sequential requests and preserves order", async () => {
    const texts = Array.from({ length: 40 }, (_, i) => `t${i}`);
    const fetchMock = mock(async (_url: string, init: RequestInit) => {
      const body = JSON.parse(String(init.body)) as { input: string[] };
      return new Response(
        JSON.stringify({
          data: body.input.map((text) => ({
            embedding: [Number(text.slice(1))],
          })),
        }),
        { status: 200, headers: { "Content-Type": "application/json" } },
      );
    });
    globalThis.fetch = fetchMock as unknown as typeof fetch;

    const backend = new GatewayEmbeddingBackend({
      baseUrl: "http://llm-gateway:4000/v1",
      model: "embed",
      headers: { Authorization: "Bearer gw-key" },
    });
    const vectors = await backend.embed(texts);

    expect(fetchMock).toHaveBeenCalledTimes(3);
    const batchSizes = fetchMock.mock.calls.map((call) => {
      const init = call[1] as RequestInit;
      const body = JSON.parse(String(init.body)) as { input: string[] };
      expect(body.input.length).toBeLessThanOrEqual(16);
      return body.input.length;
    });
    expect(batchSizes).toEqual([16, 16, 8]);
    expect(vectors).toHaveLength(40);
    expect(vectors.map((vector) => vector[0])).toEqual(
      Array.from({ length: 40 }, (_, i) => i),
    );
  });

  test("sends a single over-budget input alone without splitting its text", async () => {
    const big = "x".repeat(9_000);
    const texts = [big, "small"];
    const fetchMock = mock(async (_url: string, init: RequestInit) => {
      const body = JSON.parse(String(init.body)) as { input: string[] };
      return new Response(
        JSON.stringify({
          data: body.input.map((text) => ({ embedding: [text.length] })),
        }),
        { status: 200, headers: { "Content-Type": "application/json" } },
      );
    });
    globalThis.fetch = fetchMock as unknown as typeof fetch;

    const backend = new GatewayEmbeddingBackend({
      baseUrl: "http://llm-gateway:4000/v1",
      model: "embed",
      headers: { Authorization: "Bearer gw-key" },
    });
    const vectors = await backend.embed(texts);

    expect(fetchMock).toHaveBeenCalledTimes(2);
    const batches = fetchMock.mock.calls.map((call) => {
      const init = call[1] as RequestInit;
      return (JSON.parse(String(init.body)) as { input: string[] }).input;
    });
    expect(batches[0]).toEqual([big]);
    expect(batches[1]).toEqual(["small"]);
    expect(vectors).toEqual([[9_000], [5]]);
  });

  test("keeps a batch within the character budget when inputs are large", async () => {
    const texts = ["a".repeat(4_500), "b".repeat(4_500), "c".repeat(4_500)];
    const fetchMock = mock(async (_url: string, init: RequestInit) => {
      const body = JSON.parse(String(init.body)) as { input: string[] };
      return new Response(
        JSON.stringify({
          data: body.input.map(() => ({ embedding: [1] })),
        }),
        { status: 200, headers: { "Content-Type": "application/json" } },
      );
    });
    globalThis.fetch = fetchMock as unknown as typeof fetch;

    const backend = new GatewayEmbeddingBackend({
      baseUrl: "http://llm-gateway:4000/v1",
      model: "embed",
      headers: { Authorization: "Bearer gw-key" },
    });
    await backend.embed(texts);

    expect(fetchMock).toHaveBeenCalledTimes(3);
  });
});

describe("gatewayTargetCacheExtras", () => {
  test("folds base URL and dimensions into the identity", () => {
    expect(
      gatewayTargetCacheExtras({
        baseUrl: "http://llm-gateway:4000/v1",
        dimensions: 1024,
      }),
    ).toEqual(["url=http://llm-gateway:4000/v1", "dim=1024"]);
  });
});

describe("selectEmbeddingBackend gateway provider", () => {
  test("selects the gateway backend from the resolved connection", async () => {
    process.env[ENV_URL] = "http://llm-gateway:4000/v1";
    process.env[ENV_KEY] = "gw-key";

    const config = {
      memory: {
        embeddings: {
          provider: "gateway",
          gatewayModel: "embed",
          gatewayDimensions: 1024,
        },
      },
    } as unknown as AssistantConfig;

    const { backend, reason } = await selectEmbeddingBackend(config);

    expect(reason).toBeNull();
    expect(backend).toBeInstanceOf(GatewayEmbeddingBackend);
    expect(backend?.provider).toBe("gateway");
    expect(backend?.model).toBe("embed");
  });

  test("reports the resolution error instead of a backend", async () => {
    const config = {
      memory: {
        embeddings: { provider: "gateway", gatewayModel: "embed" },
      },
    } as unknown as AssistantConfig;

    const { backend, reason } = await selectEmbeddingBackend(config);

    expect(backend).toBeNull();
    expect(reason).toMatch(/LLM gateway connection/);
  });
});
