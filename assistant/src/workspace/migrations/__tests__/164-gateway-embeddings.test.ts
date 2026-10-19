import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, test } from "bun:test";

import { gatewayEmbeddingsMigration as MIG } from "../164-gateway-embeddings.js";

let workspaceDir: string;
let configPath: string;

function write(obj: unknown): void {
  writeFileSync(configPath, JSON.stringify(obj, null, 2) + "\n");
}

function read(): Record<string, unknown> {
  return JSON.parse(readFileSync(configPath, "utf-8")) as Record<
    string,
    unknown
  >;
}

function embeddings(): Record<string, unknown> {
  const memory = read().memory as Record<string, unknown>;
  return memory.embeddings as Record<string, unknown>;
}

beforeEach(() => {
  workspaceDir = mkdtempSync(join(tmpdir(), "gateway-embeddings-"));
  configPath = join(workspaceDir, "config.json");
});
afterEach(() => {
  rmSync(workspaceDir, { recursive: true, force: true });
});

describe("164-gateway-embeddings", () => {
  test("has the expected id", () => {
    expect(MIG.id).toBe("164-gateway-embeddings");
  });

  test("moves embeddings onto the gateway and keeps legacy fields", () => {
    write({
      memory: {
        embeddings: {
          provider: "ollama",
          ollamaModel: "mistral/mistral-embed",
          required: true,
        },
      },
    });

    MIG.run(workspaceDir);

    expect(embeddings()).toEqual({
      provider: "gateway",
      gatewayModel: "embed",
      ollamaModel: "mistral/mistral-embed",
      required: true,
    });
  });

  test("creates memory.embeddings when missing", () => {
    write({ memory: {} });

    MIG.run(workspaceDir);

    expect(embeddings()).toEqual({
      provider: "gateway",
      gatewayModel: "embed",
    });
  });

  test("is idempotent", () => {
    write({
      memory: { embeddings: { provider: "gateway", gatewayModel: "embed" } },
    });
    const before = readFileSync(configPath, "utf-8");

    MIG.run(workspaceDir);

    expect(readFileSync(configPath, "utf-8")).toBe(before);
  });

  test("no-ops when config.json is absent", () => {
    expect(() => MIG.run(workspaceDir)).not.toThrow();
  });

  test("down restores the schema default provider", () => {
    write({
      memory: { embeddings: { provider: "gateway", gatewayModel: "embed" } },
    });

    MIG.down(workspaceDir);

    expect(embeddings()).toEqual({ provider: "auto" });
  });
});
