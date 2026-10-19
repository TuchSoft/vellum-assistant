import { describe, expect, test } from "bun:test";

import { selectGatewayConnection } from "../gateway.js";
import type { ProviderConnection } from "../inference/auth.js";

function connection(
  name: string,
  baseUrl: string | null,
  modelIds: string[] = [],
): ProviderConnection {
  return {
    name,
    provider: "openai-compatible",
    auth: { type: "api_key", credential: `credential/${name}/api_key` },
    label: null,
    baseUrl,
    models: modelIds.map((id) => ({ id })),
    createdAt: 0,
    updatedAt: 0,
    isManaged: false,
  };
}

/**
 * Mirrors the production rows: five openai-compatible connections, the first
 * one a dead OmniRoute endpoint, the last one the LLM gateway the chat uses.
 */
function productionRows(): ProviderConnection[] {
  return [
    connection(
      "openai-compatible-personal",
      "http://host.docker.internal:20128/v1",
      ["deepseek-v4-flash"],
    ),
    connection("openai-compatible-personal-2", "https://api.llmgateway.io/v1", [
      "deepseek-v4-flash",
    ]),
    connection(
      "openai-compatible-personal-3",
      "https://api.kimi.com/coding/v1",
      ["kimi-for-coding"],
    ),
    connection("openai-compatible-personal-4", "https://api.entrim.ai/v1", [
      "entrim-1",
    ]),
    connection("openai-compatible-personal-5", "http://llm-gateway:4000/v1", [
      "deepseek-v4-flash",
      "main",
      "main-pro",
      "small",
      "fast",
    ]),
  ];
}

describe("selectGatewayConnection", () => {
  test("picks the connection that declares the chat's main-agent model", () => {
    const selected = selectGatewayConnection(productionRows(), "main");
    expect(selected?.name).toBe("openai-compatible-personal-5");
    expect(selected?.baseUrl).toBe("http://llm-gateway:4000/v1");
  });

  test("follows the resolved model rather than the first row with a base URL", () => {
    const selected = selectGatewayConnection(productionRows(), "main-pro");
    expect(selected?.name).toBe("openai-compatible-personal-5");
    expect(selected?.name).not.toBe("openai-compatible-personal");
  });

  test("prefers the canonical llm-gateway row when no row declares the model", () => {
    const rows = [
      connection("openai-compatible-personal", "http://dead.example/v1", [
        "something-else",
      ]),
      connection("llm-gateway", "http://llm-gateway:4000/v1", []),
      connection("openai-compatible-personal-5", "http://other.example/v1", [
        "another-model",
      ]),
    ];

    expect(selectGatewayConnection(rows, "main")?.name).toBe("llm-gateway");
  });

  test("falls back to the first openai-compatible row with a base URL", () => {
    const rows = [
      connection("openai-compatible-personal", "http://dead.example/v1", [
        "something-else",
      ]),
      connection(
        "openai-compatible-personal-2",
        "http://second.example/v1",
        [],
      ),
    ];

    expect(selectGatewayConnection(rows, "main")?.name).toBe(
      "openai-compatible-personal",
    );
  });

  test("ignores rows without a base URL", () => {
    const rows = [
      connection("no-url", null, ["main"]),
      connection("with-url", "http://llm-gateway:4000/v1", ["main"]),
    ];

    expect(selectGatewayConnection(rows, "main")?.name).toBe("with-url");
  });

  test("does not match the model against a row without a base URL", () => {
    const rows = [
      connection("no-url", null, ["main"]),
      connection("other", "http://other.example/v1", ["other"]),
    ];

    expect(selectGatewayConnection(rows, "main")?.name).toBe("other");
  });

  test("returns null when no connection qualifies", () => {
    expect(selectGatewayConnection([], "main")).toBeNull();
    expect(
      selectGatewayConnection([connection("no-url", null, ["main"])], "main"),
    ).toBeNull();
  });
});
