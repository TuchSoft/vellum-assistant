import { beforeEach, describe, expect, mock, test } from "bun:test";

import { v4 as uuid } from "uuid";

mock.module("../prompts/user-reference.js", () => ({
  DEFAULT_USER_REFERENCE: "my human",
  resolveUserReference: () => "Alice",
}));

import { getMemorySqlite, getSqlite } from "../persistence/db-connection.js";
import { initializeDb } from "../persistence/db-init.js";
import {
  orderStrongestFirst,
  ROUTES,
} from "../runtime/routes/conversation-starter-routes.js";
import { RouteError } from "../runtime/routes/errors.js";

await initializeDb();

/**
 * Dispatch a request to the ROUTES array by matching endpoint + method.
 * Parses the URL to extract queryParams and pathParams.
 */
function dispatch(path: string, method = "GET"): unknown | Promise<unknown> {
  const url = new URL(`http://localhost/v1/${path}`);
  const urlPath = url.pathname.replace("/v1/", "");

  const route = ROUTES.find((r) => {
    if (r.method !== method) {
      return false;
    }
    // Simple matching: "conversation-starters" or "conversation-starters/:id"
    const pattern = r.endpoint.replace(/:(\w+)/g, "([^/]+)");
    return new RegExp(`^${pattern}$`).test(urlPath);
  });
  if (!route) {
    throw new Error(`No route found for ${method} ${urlPath}`);
  }

  // Extract path params from the endpoint pattern
  const pathParams: Record<string, string> = {};
  const paramNames = [...route.endpoint.matchAll(/:(\w+)/g)].map((m) => m[1]);
  if (paramNames.length > 0) {
    const pattern = route.endpoint.replace(/:(\w+)/g, "([^/]+)");
    const match = urlPath.match(new RegExp(`^${pattern}$`));
    if (match) {
      paramNames.forEach((name, i) => {
        pathParams[name] = decodeURIComponent(match[i + 1]);
      });
    }
  }

  // Extract query params
  const queryParams: Record<string, string> = {};
  for (const [key, value] of url.searchParams.entries()) {
    queryParams[key] = value;
  }

  return route.handler({ pathParams, queryParams, body: {} });
}

function clearTables() {
  getSqlite().run("DELETE FROM conversation_starters");
  getMemorySqlite()!.run("DELETE FROM memory_graph_nodes");
  getMemorySqlite()!.run("DELETE FROM memory_jobs");
  getSqlite().run("DELETE FROM memory_checkpoints");
}

function insertStarter(overrides: {
  id?: string;
  label: string;
  prompt: string;
  category: string;
  batch?: number;
  scopeId?: string;
  createdAt?: number;
}) {
  const now = Date.now();
  const id = overrides.id ?? uuid();
  getSqlite().run(
    `INSERT INTO conversation_starters (id, label, prompt, category, generation_batch, scope_id, card_type, created_at)
     VALUES (?, ?, ?, ?, ?, ?, 'chip', ?)`,
    [
      id,
      overrides.label,
      overrides.prompt,
      overrides.category,
      overrides.batch ?? 1,
      overrides.scopeId ?? "default",
      overrides.createdAt ?? now,
    ],
  );
  return id;
}

function insertMemoryItem(scopeId = "default") {
  const now = Date.now();
  getMemorySqlite()!.run(
    `INSERT INTO memory_graph_nodes (
      id, content, type, created, last_accessed, last_consolidated,
      emotional_charge, fidelity, confidence, significance,
      stability, reinforcement_count, last_reinforced,
      source_conversations, source_type, scope_id
    ) VALUES (?, ?, ?, ?, ?, ?, ?, 'vivid', 0.8, 0.5, 14, 0, ?, '[]', 'inferred', ?)`,
    [
      uuid(),
      "test\ntest statement",
      "semantic",
      now,
      now,
      now,
      '{"valence":0,"intensity":0.1,"decayCurve":"linear","decayRate":0.05,"originalIntensity":0.1}',
      now,
      scopeId,
    ],
  );
}

function countStarterJobs() {
  return (
    getMemorySqlite()!
      .prepare(
        `SELECT COUNT(*) AS c FROM memory_jobs WHERE type = 'generate_conversation_starters'`,
      )
      .get() as { c: number }
  ).c;
}

beforeEach(() => {
  clearTables();
});

describe("GET /v1/conversation-starters", () => {
  // Conversation starter chips are disabled by custom patch 06: the list
  // endpoint never serves persisted chips and never enqueues a generation
  // job, so no LLM call happens for this feature.

  test("returns empty status even when starter rows exist", async () => {
    insertStarter({ label: "A", prompt: "p", category: "development" });
    insertStarter({ label: "B", prompt: "p", category: "communication" });
    insertMemoryItem();

    const result = (await dispatch("conversation-starters")) as {
      starters: unknown[];
      total: number;
      status: string;
    };
    expect(result).toEqual({ starters: [], total: 0, status: "empty" });
  });

  test("never enqueues a generation job", async () => {
    insertMemoryItem();

    await dispatch("conversation-starters");

    expect(countStarterJobs()).toBe(0);
  });

  test("deletes a starter row on request", async () => {
    const deletedId = insertStarter({
      label: "Draft a PR summary",
      prompt: "Draft a summary for my latest PR",
      category: "development",
    });

    const deleteResult = (await dispatch(
      `conversation-starters/${deletedId}`,
      "DELETE",
    )) as { deleted: boolean; id: string };
    expect(deleteResult).toEqual({ deleted: true, id: deletedId });
    expect(countStarterJobs()).toBe(0);

    const remaining = getSqlite()
      .prepare("SELECT COUNT(*) AS c FROM conversation_starters WHERE id = ?")
      .get(deletedId) as { c: number };
    expect(remaining.c).toBe(0);
  });

  test("throws NotFoundError when deleting an unknown starter", async () => {
    try {
      await dispatch(`conversation-starters/${uuid()}`, "DELETE");
      expect.unreachable("should have thrown");
    } catch (err) {
      expect(err).toBeInstanceOf(RouteError);
      expect((err as RouteError).statusCode).toBe(404);
      expect((err as RouteError).code).toBe("NOT_FOUND");
    }
    expect(countStarterJobs()).toBe(0);
  });
});

describe("orderStrongestFirst", () => {
  function makeItem(label: string, category: string, batch = 1) {
    return {
      id: uuid(),
      label,
      prompt: `prompt for ${label}`,
      category,
      batch,
    };
  }

  test("returns empty array for empty input", () => {
    expect(orderStrongestFirst([])).toEqual([]);
  });

  test("returns single item unchanged", () => {
    const item = makeItem("A", "development");
    expect(orderStrongestFirst([item])).toEqual([item]);
  });

  test("produces deterministic output for the same input", () => {
    const items = [
      makeItem("A", "development"),
      makeItem("B", "communication"),
      makeItem("C", "productivity"),
      makeItem("D", "development"),
      makeItem("E", "media"),
    ];

    const run1 = orderStrongestFirst([...items]);
    const run2 = orderStrongestFirst([...items]);

    expect(run1.map((item) => item.label)).toEqual(
      run2.map((item) => item.label),
    );
  });

  test("preserves order when every item shares a category", () => {
    const items = [
      makeItem("A", "development"),
      makeItem("B", "development"),
      makeItem("C", "development"),
    ];

    expect(orderStrongestFirst(items).map((item) => item.label)).toEqual([
      "A",
      "B",
      "C",
    ]);
  });

  test("maximizes early category diversity when alternatives exist", () => {
    const items = [
      makeItem("Dev 1", "development"),
      makeItem("Dev 2", "development"),
      makeItem("Dev 3", "development"),
      makeItem("Comm 1", "communication"),
      makeItem("Prod 1", "productivity"),
    ];

    const ordered = orderStrongestFirst(items);
    const topThreeCategories = ordered.slice(0, 3).map((item) => item.category);
    expect(new Set(topThreeCategories).size).toBe(3);
  });
});
