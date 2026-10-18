import { beforeEach, expect, test } from "bun:test";

import { describePg } from "../../../__tests__/pg-test-db.js";
import { requireMainDb } from "../../../persistence/db-facade.js";
import {
  createConnection,
  getConnection,
  updateConnection,
} from "../connections.js";

describePg("ollama connection CRUD", () => {
  beforeEach(async () => {
    const db = requireMainDb();
    await db.orm.delete(db.schema.providerConnections);
  });

  test("create without baseUrl leaves it null and does not require models", async () => {
    const result = await createConnection(requireMainDb(), {
      name: "ollama-local",
      provider: "ollama",
      auth: { type: "none" },
    });
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.connection.baseUrl).toBeNull();
      expect(result.connection.models).toBeNull();
    }
  });

  test("create persists an optional baseUrl", async () => {
    const result = await createConnection(requireMainDb(), {
      name: "ollama-remote",
      provider: "ollama",
      auth: { type: "none" },
      baseUrl: "http://192.168.1.50:11434/v1",
    });
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.connection.baseUrl).toBe("http://192.168.1.50:11434/v1");
      expect(result.connection.models).toBeNull();
    }

    const fetched = await getConnection(requireMainDb(), "ollama-remote");
    expect(fetched).not.toBeNull();
    expect(fetched!.baseUrl).toBe("http://192.168.1.50:11434/v1");
  });

  test("update can change and then clear baseUrl", async () => {
    await createConnection(requireMainDb(), {
      name: "ollama-local",
      provider: "ollama",
      auth: { type: "none" },
    });

    const updated = await updateConnection(requireMainDb(), "ollama-local", {
      auth: { type: "none" },
      baseUrl: "http://127.0.0.1:11434/v1",
    });
    expect(updated.ok).toBe(true);
    if (updated.ok) {
      expect(updated.connection.baseUrl).toBe("http://127.0.0.1:11434/v1");
    }

    const cleared = await updateConnection(requireMainDb(), "ollama-local", {
      auth: { type: "none" },
      baseUrl: null,
    });
    expect(cleared.ok).toBe(true);
    if (cleared.ok) {
      expect(cleared.connection.baseUrl).toBeNull();
    }
  });
});
