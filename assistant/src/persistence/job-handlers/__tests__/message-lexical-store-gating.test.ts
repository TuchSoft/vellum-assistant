/**
 * Which store `search.lexicalStore` writes.
 *
 * The cutover flag must be inert at its default: `qdrant` keeps the shipped
 * behavior (one Qdrant call, no Postgres write). `dual` writes both, `postgres`
 * writes only the table. The same matrix holds for the delete and purge jobs.
 */
import { beforeEach, describe, expect, mock, test } from "bun:test";

import type { SparseEmbedding } from "../../embeddings/embedding-types.js";

const qdrantCalls: string[] = [];
const pgCalls: string[] = [];

const fakeIndex = {
  upsertMessage: async (
    _id: string,
    _sparse: SparseEmbedding,
    _payload: { conversationId: string; createdAt: number },
  ) => {
    qdrantCalls.push("upsertMessage");
  },
  deleteByMessageId: async (_id: string) => {
    qdrantCalls.push("deleteByMessageId");
  },
  deleteByConversation: async (_id: string) => {
    qdrantCalls.push("deleteByConversation");
  },
};

mock.module("../../embeddings/messages-lexical-index.js", () => ({
  MESSAGES_LEXICAL_COLLECTION: "messages_lexical",
  getMessagesLexicalIndex: () => fakeIndex,
  initMessagesLexicalIndex: () => fakeIndex,
}));

mock.module("../../embeddings/qdrant-circuit-breaker.js", () => ({
  withQdrantBreaker: <T>(op: () => Promise<T>) => op(),
}));

mock.module("../../message-lexical-store.js", () => ({
  upsertMessageLexical: async () => {
    pgCalls.push("upsertMessageLexical");
  },
  upsertMessagesLexicalBatch: async () => {
    pgCalls.push("upsertMessagesLexicalBatch");
  },
  deleteMessageLexicalRow: async () => {
    pgCalls.push("deleteMessageLexicalRow");
  },
  purgeConversationLexicalRows: async () => {
    pgCalls.push("purgeConversationLexicalRows");
  },
  clearMessagesLexicalRows: async () => {
    pgCalls.push("clearMessagesLexicalRows");
  },
}));

import { DEFAULT_CONFIG } from "../../../config/defaults.js";
import type { AssistantConfig } from "../../../config/types.js";
import type { MemoryJob } from "../../jobs-store.js";
import {
  deleteMessageLexicalJob,
  indexMessageToLexical,
  purgeConversationLexicalJob,
} from "../message-lexical.js";

type Store = AssistantConfig["search"]["lexicalStore"];

function configWithStore(store: Store): AssistantConfig {
  return {
    ...DEFAULT_CONFIG,
    search: { ...DEFAULT_CONFIG.search, lexicalStore: store },
  };
}

function job(payload: Record<string, unknown>): MemoryJob {
  return { payload } as unknown as MemoryJob;
}

beforeEach(() => {
  qdrantCalls.length = 0;
  pgCalls.length = 0;
});

describe("indexMessageToLexical · store gating", () => {
  const message = {
    id: "m-1",
    conversationId: "c-1",
    content: "testo indicizzabile",
    createdAt: 1000,
  };

  test("qdrant writes Qdrant only", async () => {
    await indexMessageToLexical(message, configWithStore("qdrant"));
    expect(qdrantCalls).toEqual(["upsertMessage"]);
    expect(pgCalls).toEqual([]);
  });

  test("dual writes both stores", async () => {
    await indexMessageToLexical(message, configWithStore("dual"));
    expect(qdrantCalls).toEqual(["upsertMessage"]);
    expect(pgCalls).toEqual(["upsertMessageLexical"]);
  });

  test("postgres writes Postgres only", async () => {
    await indexMessageToLexical(message, configWithStore("postgres"));
    expect(qdrantCalls).toEqual([]);
    expect(pgCalls).toEqual(["upsertMessageLexical"]);
  });
});

describe("delete jobs · store gating", () => {
  test("qdrant deletes from Qdrant only", async () => {
    await deleteMessageLexicalJob(
      job({ messageId: "m-1" }),
      configWithStore("qdrant"),
    );
    await purgeConversationLexicalJob(
      job({ conversationId: "c-1" }),
      configWithStore("qdrant"),
    );
    expect(qdrantCalls).toEqual(["deleteByMessageId", "deleteByConversation"]);
    expect(pgCalls).toEqual([]);
  });

  test("dual deletes from both stores", async () => {
    await deleteMessageLexicalJob(
      job({ messageId: "m-1" }),
      configWithStore("dual"),
    );
    await purgeConversationLexicalJob(
      job({ conversationId: "c-1" }),
      configWithStore("dual"),
    );
    expect(qdrantCalls).toEqual(["deleteByMessageId", "deleteByConversation"]);
    expect(pgCalls).toEqual([
      "deleteMessageLexicalRow",
      "purgeConversationLexicalRows",
    ]);
  });

  test("postgres deletes from Postgres only", async () => {
    await deleteMessageLexicalJob(
      job({ messageId: "m-1" }),
      configWithStore("postgres"),
    );
    await purgeConversationLexicalJob(
      job({ conversationId: "c-1" }),
      configWithStore("postgres"),
    );
    expect(qdrantCalls).toEqual([]);
    expect(pgCalls).toEqual([
      "deleteMessageLexicalRow",
      "purgeConversationLexicalRows",
    ]);
  });
});
