import { beforeEach, expect, test } from "bun:test";

import {
  getDocumentById,
  getDocumentsForConversation,
} from "../documents/document-store.js";
import { requireMainDb } from "../persistence/db-facade.js";
import { executeDocumentCreate } from "../tools/document/document-tool.js";
import type { ToolContext, ToolExecutionResult } from "../tools/types.js";
import { describePg } from "./pg-test-db.js";

function makeContext(overrides: Partial<ToolContext> = {}): ToolContext {
  return {
    workingDir: "/tmp/project",
    conversationId: "conv-current",
    trustClass: "trusted_contact",
    executionChannel: "slack",
    sendToClient: () => {},
    ...overrides,
  };
}

function parseResult<T>(result: ToolExecutionResult): T {
  return JSON.parse(result.content) as T;
}

async function bootstrapDocumentTables(): Promise<void> {
  const db = requireMainDb();
  await db.run("DELETE FROM document_conversations");
  await db.run("DELETE FROM document_revisions");
  await db.run("DELETE FROM documents");
  await db.run("DELETE FROM conversations");
}

async function seedDocument(params: {
  surfaceId: string;
  conversationId: string;
  title: string;
  content: string;
  createdAt: number;
}): Promise<void> {
  const db = requireMainDb();
  await db.run(
    "INSERT INTO conversations (id, title, created_at, updated_at) VALUES (?, ?, ?, ?)",
    [
      params.conversationId,
      `Conversation ${params.conversationId}`,
      params.createdAt,
      params.createdAt,
    ],
  );
  await db.run(
    "INSERT INTO documents (surface_id, conversation_id, title, content, word_count, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)",
    [
      params.surfaceId,
      params.conversationId,
      params.title,
      params.content,
      params.content.split(/\s+/).filter(Boolean).length,
      params.createdAt,
      params.createdAt,
    ],
  );
  await db.run(
    "INSERT INTO document_conversations (surface_id, conversation_id, created_at) VALUES (?, ?, ?)",
    [params.surfaceId, params.conversationId, params.createdAt],
  );
}

describePg("executeDocumentCreate — dedupe empty same-title document", () => {
  beforeEach(async () => {
    await bootstrapDocumentTables();
  });

  test("reuses an empty same-title doc when incoming content is non-empty", async () => {
    const seededId = "doc-empty-seeded";
    await seedDocument({
      surfaceId: seededId,
      conversationId: "conv-current",
      title: "My Post",
      content: "",
      createdAt: Date.now(),
    });

    const result = await executeDocumentCreate(
      { title: "My Post", initial_content: "Hello" },
      makeContext(),
    );
    expect(result.isError).toBe(false);
    const body = parseResult<{
      surface_id: string;
      reused?: boolean;
      message?: string;
    }>(result);
    expect(body.surface_id).toBe(seededId);
    expect(body.reused).toBe(true);
    expect(body.message).toBe("Document editor reopened (deduped empty draft)");

    expect((await getDocumentById(seededId))?.content).toBe("Hello");
    expect((await getDocumentsForConversation("conv-current")).length).toBe(1);
  });

  test("creates a new doc when incoming initial_content is empty (no dedupe)", async () => {
    const seededId = "doc-empty-seeded";
    await seedDocument({
      surfaceId: seededId,
      conversationId: "conv-current",
      title: "My Post",
      content: "",
      createdAt: Date.now(),
    });

    const result = await executeDocumentCreate(
      { title: "My Post", initial_content: "" },
      makeContext(),
    );
    expect(result.isError).toBe(false);
    const body = parseResult<{ surface_id: string; reused?: boolean }>(result);
    expect(body.reused).toBeUndefined();
    expect(body.surface_id).not.toBe(seededId);
    expect((await getDocumentsForConversation("conv-current")).length).toBe(2);
  });

  test("does not dedupe when the seeded doc already has content", async () => {
    const seededId = "doc-has-content";
    await seedDocument({
      surfaceId: seededId,
      conversationId: "conv-current",
      title: "My Post",
      content: "already drafted",
      createdAt: Date.now(),
    });

    const result = await executeDocumentCreate(
      { title: "My Post", initial_content: "Hello" },
      makeContext(),
    );
    expect(result.isError).toBe(false);
    const body = parseResult<{ surface_id: string; reused?: boolean }>(result);
    expect(body.reused).toBeUndefined();
    expect(body.surface_id).not.toBe(seededId);
    expect((await getDocumentById(seededId))?.content).toBe("already drafted");
    expect((await getDocumentsForConversation("conv-current")).length).toBe(2);
  });

  test("does not dedupe when the seeded empty doc is outside the 5-minute window", async () => {
    const seededId = "doc-stale-empty";
    await seedDocument({
      surfaceId: seededId,
      conversationId: "conv-current",
      title: "My Post",
      content: "",
      // 10 minutes ago — outside the 5-minute dedupe window.
      createdAt: Date.now() - 10 * 60 * 1000,
    });

    const result = await executeDocumentCreate(
      { title: "My Post", initial_content: "Hello" },
      makeContext(),
    );
    expect(result.isError).toBe(false);
    const body = parseResult<{ surface_id: string; reused?: boolean }>(result);
    expect(body.reused).toBeUndefined();
    expect(body.surface_id).not.toBe(seededId);
    expect((await getDocumentById(seededId))?.content).toBe("");
    expect((await getDocumentsForConversation("conv-current")).length).toBe(2);
  });
});
