/**
 * Which store `memory.v3.sectionsStore` writes and reads.
 *
 * The cutover flag must be inert at its default: `qdrant` keeps the shipped
 * behavior (Qdrant only, no Postgres call). `dual` writes both and reads
 * Postgres. `pgvector` touches Postgres only. The same matrix holds for the
 * delete, list and project-scope paths.
 */
import { beforeEach, describe, expect, mock, test } from "bun:test";

import type { AssistantConfig } from "../../../../../config/types.js";
import type { Section } from "../types.js";

const qdrantCalls: string[] = [];
const pgCalls: string[] = [];

const qdrantState = {
  queryPoints: [] as Array<{
    payload: { article: string; ordinal: number };
    score: number;
  }>,
  scrollPages: [] as Array<{
    points: Array<{ payload: { article: string } }>;
    next_page_offset: string | number | null;
  }>,
};

class MockQdrantClient {
  constructor(_opts: unknown) {}
  async collectionExists(_name: string) {
    qdrantCalls.push("collectionExists");
    return { exists: true };
  }
  async getCollection(_name: string) {
    qdrantCalls.push("getCollection");
    return { config: { params: { vectors: { size: 4, distance: "Cosine" } } } };
  }
  async createCollection(_name: string) {
    qdrantCalls.push("createCollection");
    return {};
  }
  async createPayloadIndex(_name: string) {
    qdrantCalls.push("createPayloadIndex");
    return {};
  }
  async upsert(_name: string) {
    qdrantCalls.push("upsert");
    return {};
  }
  async delete(_name: string) {
    qdrantCalls.push("delete");
    return {};
  }
  async setPayload(_name: string) {
    qdrantCalls.push("setPayload");
    return {};
  }
  async count(_name: string) {
    qdrantCalls.push("count");
    return { count: 2 };
  }
  async scroll(_name: string) {
    qdrantCalls.push("scroll");
    return (
      qdrantState.scrollPages.shift() ?? { points: [], next_page_offset: null }
    );
  }
  async query(_name: string) {
    qdrantCalls.push("query");
    return { points: qdrantState.queryPoints };
  }
}

mock.module("@qdrant/js-client-rest", () => ({
  QdrantClient: MockQdrantClient,
}));

mock.module("../../embeddings.js", () => ({
  resolveQdrantUrl: () => "http://127.0.0.1:6333",
  embedWithBackend: async (_config: unknown, inputs: string[]) => ({
    provider: "test",
    model: "test-model",
    vectors: inputs.map(() => [1, 0, 0, 0]),
  }),
}));

// Spread the real module and override only what the store resolves, so any
// other importer in the graph keeps the exports it expects (a partial factory
// breaks the whole file with a missing-export SyntaxError).
const realEmbeddingBackend =
  await import("../../../../../persistence/embeddings/embedding-backend.js");
mock.module(
  "../../../../../persistence/embeddings/embedding-backend.js",
  () => ({
    ...realEmbeddingBackend,
    getMemoryBackendStatus: async () => ({
      enabled: true,
      degraded: false,
      provider: "test",
      model: "test-model",
      reason: null,
    }),
    durableEmbeddingCacheExtras: () => "",
    isEmbeddingDimensionAvailable: async () => true,
  }),
);

mock.module("../section-pg-store.js", () => ({
  upsertSectionsPg: async (_config: unknown, rows: unknown[]) => {
    pgCalls.push(`upsert:${rows.length}`);
  },
  deleteSectionsForArticlePg: async () => {
    pgCalls.push("delete");
  },
  listSectionArticlesPg: async () => {
    pgCalls.push("list");
    return ["from-pg"];
  },
  setSectionProjectScopePg: async () => {
    pgCalls.push("setScope");
  },
  countSectionsForArticlePg: async () => {
    pgCalls.push("count");
    return 2;
  },
  searchSectionsPg: async () => {
    pgCalls.push("search");
    return [{ article: "from-pg", ordinal: 0, score: 0.9 }];
  },
  _resetSectionPgStoreForTests: () => {},
}));

mock.module("../../../../../persistence/checkpoints.js", () => ({
  getMemoryCheckpoint: async () => null,
  setMemoryCheckpoint: async () => {},
  deleteMemoryCheckpoint: async () => {},
}));

const {
  upsertSections,
  deleteSectionsForArticle,
  listSectionArticles,
  setSectionProjectScope,
  _resetSectionDenseStoreForTests,
} = await import("../section-dense-store.js");
const { denseLaneScored } = await import("../dense.js");

type Store = AssistantConfig["memory"]["v3"]["sectionsStore"];

function configWithStore(store: Store): AssistantConfig {
  return {
    memory: {
      qdrant: { vectorSize: 4, onDisk: true },
      v3: { sectionsStore: store },
    },
  } as unknown as AssistantConfig;
}

function section(article: string, ordinal: number, text: string): Section {
  return { article, ordinal, text, title: "" };
}

beforeEach(() => {
  qdrantCalls.length = 0;
  pgCalls.length = 0;
  qdrantState.queryPoints = [
    { payload: { article: "from-qdrant", ordinal: 1 }, score: 0.8 },
  ];
  qdrantState.scrollPages = [
    {
      points: [{ payload: { article: "from-qdrant" } }],
      next_page_offset: null,
    },
  ];
  _resetSectionDenseStoreForTests();
});

describe("upsertSections · store gating", () => {
  test("qdrant writes Qdrant only", async () => {
    await upsertSections(configWithStore("qdrant"), [
      section("people/alice", 0, "text"),
    ]);
    expect(qdrantCalls).toContain("upsert");
    expect(pgCalls).toEqual([]);
  });

  test("dual writes both stores", async () => {
    await upsertSections(configWithStore("dual"), [
      section("people/alice", 0, "text"),
    ]);
    expect(qdrantCalls).toContain("upsert");
    expect(pgCalls).toEqual(["upsert:1"]);
  });

  test("pgvector writes Postgres only and never probes the collection", async () => {
    await upsertSections(configWithStore("pgvector"), [
      section("people/alice", 0, "text"),
    ]);
    expect(qdrantCalls).toEqual([]);
    expect(pgCalls).toEqual(["upsert:1"]);
  });
});

describe("delete/list/setScope · store gating", () => {
  test("qdrant touches Qdrant only", async () => {
    await deleteSectionsForArticle(configWithStore("qdrant"), "people/alice");
    const articles = await listSectionArticles(configWithStore("qdrant"));
    await setSectionProjectScope(configWithStore("qdrant"), "people/alice", {
      projects: ["p1"],
      exclusive: true,
    });
    expect(qdrantCalls).toContain("delete");
    expect(qdrantCalls).toContain("scroll");
    expect(qdrantCalls).toContain("setPayload");
    expect(articles).toEqual(["from-qdrant"]);
    expect(pgCalls).toEqual([]);
  });

  test("dual touches both stores and unions the article list", async () => {
    await deleteSectionsForArticle(configWithStore("dual"), "people/alice");
    const articles = await listSectionArticles(configWithStore("dual"));
    await setSectionProjectScope(configWithStore("dual"), "people/alice", {
      projects: ["p1"],
      exclusive: true,
    });
    expect(qdrantCalls).toContain("delete");
    expect(qdrantCalls).toContain("setPayload");
    expect(articles).toEqual(["from-qdrant", "from-pg"]);
    expect(pgCalls).toEqual(["delete", "list", "setScope"]);
  });

  test("pgvector touches Postgres only", async () => {
    await deleteSectionsForArticle(configWithStore("pgvector"), "people/alice");
    const articles = await listSectionArticles(configWithStore("pgvector"));
    await setSectionProjectScope(configWithStore("pgvector"), "people/alice", {
      projects: ["p1"],
      exclusive: true,
    });
    expect(qdrantCalls).toEqual([]);
    expect(articles).toEqual(["from-pg"]);
    expect(pgCalls).toEqual(["delete", "list", "setScope"]);
  });
});

describe("denseLaneScored · store gating", () => {
  test("qdrant reads Qdrant and never queries Postgres", async () => {
    const hits = await denseLaneScored(configWithStore("qdrant"), "query", 2);
    expect(qdrantCalls).toContain("query");
    expect(pgCalls).toEqual([]);
    expect(hits).toEqual([{ article: "from-qdrant", section: 1, score: 0.8 }]);
  });

  test("dual reads Postgres", async () => {
    const hits = await denseLaneScored(configWithStore("dual"), "query", 2);
    expect(pgCalls).toEqual(["search"]);
    expect(qdrantCalls).not.toContain("query");
    expect(hits).toEqual([{ article: "from-pg", section: 0, score: 0.9 }]);
  });
  test("pgvector reads Postgres", async () => {
    const hits = await denseLaneScored(configWithStore("pgvector"), "query", 2);
    expect(pgCalls).toEqual(["search"]);
    expect(qdrantCalls).toEqual([]);
    expect(hits).toEqual([{ article: "from-pg", section: 0, score: 0.9 }]);
  });
});
