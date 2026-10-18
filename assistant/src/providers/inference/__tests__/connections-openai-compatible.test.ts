import { beforeEach, expect, test } from "bun:test";

import { describePg } from "../../../__tests__/pg-test-db.js";
import { requireMainDb } from "../../../persistence/db-facade.js";
import {
  createConnection,
  getConnection,
  listConnections,
  updateConnection,
} from "../connections.js";

describePg("openai-compatible connection CRUD", () => {
  beforeEach(async () => {
    const db = requireMainDb();
    await db.orm.delete(db.schema.providerConnections);
  });

  test("create requires base_url", async () => {
    const result = await createConnection(requireMainDb(), {
      name: "my-vllm",
      provider: "openai-compatible",
      auth: { type: "api_key", credential: "cred-vllm" },
      models: [{ id: "my-model" }],
    });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe("base_url_required");
    }
  });

  test("create requires at least one model", async () => {
    const result = await createConnection(requireMainDb(), {
      name: "my-vllm",
      provider: "openai-compatible",
      auth: { type: "api_key", credential: "cred-vllm" },
      baseUrl: "http://localhost:8080/v1",
    });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe("models_required");
    }
  });

  test("create rejects empty models array", async () => {
    const result = await createConnection(requireMainDb(), {
      name: "my-vllm",
      provider: "openai-compatible",
      auth: { type: "api_key", credential: "cred-vllm" },
      baseUrl: "http://localhost:8080/v1",
      models: [],
    });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe("models_required");
    }
  });

  test("create persists baseUrl and models; round-trips via getConnection", async () => {
    const models = [
      { id: "llama-3-70b" },
      { id: "mistral-7b", displayName: "Mistral 7B" },
    ];
    const result = await createConnection(requireMainDb(), {
      name: "my-vllm",
      provider: "openai-compatible",
      auth: { type: "api_key", credential: "cred-vllm" },
      baseUrl: "http://localhost:8080/v1",
      models,
    });
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.connection.baseUrl).toBe("http://localhost:8080/v1");
      expect(result.connection.models).toEqual(models);
    }

    const fetched = await getConnection(requireMainDb(), "my-vllm");
    expect(fetched).not.toBeNull();
    expect(fetched!.baseUrl).toBe("http://localhost:8080/v1");
    expect(fetched!.models).toEqual(models);
  });

  test("non-openai-compatible providers leave baseUrl/models null", async () => {
    const result = await createConnection(requireMainDb(), {
      name: "my-anthropic",
      provider: "anthropic",
      auth: { type: "api_key", credential: "cred-anthropic" },
    });
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.connection.baseUrl).toBeNull();
      expect(result.connection.models).toBeNull();
    }
  });

  test("updateConnection can change models without re-supplying baseUrl", async () => {
    await createConnection(requireMainDb(), {
      name: "my-vllm",
      provider: "openai-compatible",
      auth: { type: "api_key", credential: "cred-vllm" },
      baseUrl: "http://localhost:8080/v1",
      models: [{ id: "llama-3-70b" }],
    });

    const result = await updateConnection(requireMainDb(), "my-vllm", {
      auth: { type: "api_key", credential: "cred-vllm" },
      models: [{ id: "llama-3-70b" }, { id: "mistral-7b" }],
    });
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.connection.baseUrl).toBe("http://localhost:8080/v1");
      expect(result.connection.models).toEqual([
        { id: "llama-3-70b" },
        { id: "mistral-7b" },
      ]);
    }
  });

  test("updateConnection rejects clearing models on openai-compatible", async () => {
    await createConnection(requireMainDb(), {
      name: "my-vllm",
      provider: "openai-compatible",
      auth: { type: "api_key", credential: "cred-vllm" },
      baseUrl: "http://localhost:8080/v1",
      models: [{ id: "llama-3-70b" }],
    });

    const result = await updateConnection(requireMainDb(), "my-vllm", {
      auth: { type: "api_key", credential: "cred-vllm" },
      models: [],
    });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe("models_required");
    }
  });

  test("listConnections includes baseUrl and models", async () => {
    await createConnection(requireMainDb(), {
      name: "my-vllm",
      provider: "openai-compatible",
      auth: { type: "api_key", credential: "cred-vllm" },
      baseUrl: "http://localhost:8080/v1",
      models: [{ id: "llama-3-70b" }],
    });

    const connections = await listConnections(requireMainDb(), {
      provider: "openai-compatible",
    });
    expect(connections.length).toBe(1);
    expect(connections[0]!.baseUrl).toBe("http://localhost:8080/v1");
    expect(connections[0]!.models).toEqual([{ id: "llama-3-70b" }]);
  });
});
