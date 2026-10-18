import { beforeEach, expect, test } from "bun:test";

import { getDocumentById } from "../documents/document-store.js";
import { requireMainDb } from "../persistence/db-facade.js";
import { executeDocumentUpdate } from "../tools/document/document-tool.js";
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
  await db.run("DELETE FROM document_revisions");
  await db.run("DELETE FROM document_conversations");
  await db.run("DELETE FROM documents");
  await db.run("DELETE FROM conversations");
}

async function seedDocument(params: {
  surfaceId: string;
  conversationId: string;
  title: string;
  content: string;
  createdAt: number;
  updatedAt?: number;
}): Promise<void> {
  const db = requireMainDb();
  await db.run(
    `INSERT INTO conversations (id, created_at, updated_at) VALUES (?, ?, ?) ON CONFLICT DO NOTHING`,
    [params.conversationId, params.createdAt, params.createdAt],
  );
  await db.run(
    `INSERT INTO documents (surface_id, conversation_id, title, content, word_count, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)`,
    [
      params.surfaceId,
      params.conversationId,
      params.title,
      params.content,
      params.content.split(/\s+/).filter(Boolean).length,
      params.createdAt,
      params.updatedAt ?? params.createdAt,
    ],
  );
  await db.run(
    `INSERT INTO document_conversations (surface_id, conversation_id, created_at) VALUES (?, ?, ?) ON CONFLICT DO NOTHING`,
    [params.surfaceId, params.conversationId, params.createdAt],
  );
}

describePg("executeDocumentUpdate — default surface_id resolution", () => {
  beforeEach(async () => {
    await bootstrapDocumentTables();
  });

  test("appends to the conversation's only document when surface_id is omitted", async () => {
    const surfaceId = "doc-only";
    await seedDocument({
      surfaceId,
      conversationId: "conv-current",
      title: "Dating in 2026",
      content: "# Dating in 2026\n\nIntro.",
      createdAt: Date.now(),
    });

    const result = await executeDocumentUpdate(
      { content: "## Section two", mode: "append" },
      makeContext(),
    );

    expect(result.isError).toBe(false);
    const body = parseResult<{ surface_id: string; success: boolean }>(result);
    expect(body.success).toBe(true);
    expect(body.surface_id).toBe(surfaceId);
    expect((await getDocumentById(surfaceId))?.content).toBe(
      "# Dating in 2026\n\nIntro.\n\n## Section two",
    );
  });

  test("targets the most recently updated document when several exist", async () => {
    const now = Date.now();
    await seedDocument({
      surfaceId: "doc-old",
      conversationId: "conv-current",
      title: "Old",
      content: "old",
      createdAt: now - 10_000,
      updatedAt: now - 10_000,
    });
    await seedDocument({
      surfaceId: "doc-fresh",
      conversationId: "conv-current",
      title: "Fresh",
      content: "fresh",
      createdAt: now,
      updatedAt: now,
    });

    const result = await executeDocumentUpdate(
      { content: "more" },
      makeContext(),
    );

    expect(result.isError).toBe(false);
    const body = parseResult<{ surface_id: string }>(result);
    expect(body.surface_id).toBe("doc-fresh");
    expect((await getDocumentById("doc-fresh"))?.content).toBe("fresh\n\nmore");
    expect((await getDocumentById("doc-old"))?.content).toBe("old");
  });

  test("an explicit surface_id still wins over the default", async () => {
    const now = Date.now();
    await seedDocument({
      surfaceId: "doc-target",
      conversationId: "conv-current",
      title: "Target",
      content: "target",
      createdAt: now - 10_000,
      updatedAt: now - 10_000,
    });
    await seedDocument({
      surfaceId: "doc-fresh",
      conversationId: "conv-current",
      title: "Fresh",
      content: "fresh",
      createdAt: now,
      updatedAt: now,
    });

    const result = await executeDocumentUpdate(
      { surface_id: "doc-target", content: "hit" },
      makeContext(),
    );

    expect(result.isError).toBe(false);
    expect(parseResult<{ surface_id: string }>(result).surface_id).toBe(
      "doc-target",
    );
    expect((await getDocumentById("doc-target"))?.content).toBe(
      "target\n\nhit",
    );
    expect((await getDocumentById("doc-fresh"))?.content).toBe("fresh");
  });

  test("errors helpfully when the conversation has no document", async () => {
    const result = await executeDocumentUpdate(
      { content: "orphan chunk" },
      makeContext(),
    );

    expect(result.isError).toBe(true);
    expect(result.content).toContain("no document is open");
    expect(result.content).toContain("document_create");
  });

  test("reports success when no client is connected to render the edit", async () => {
    // A headless turn (a schedule, or an SMS or Telegram channel) has no
    // client, but the row is written all the same. Reporting an error would
    // skip the post-execution hooks, so the documents-changed broadcast that
    // tells clients about the edit would never fire, and the model would be
    // told to retry a write that already succeeded.
    await seedDocument({
      surfaceId: "doc-headless",
      conversationId: "conv-current",
      title: "X",
      content: "start",
      createdAt: Date.now(),
    });

    const result = await executeDocumentUpdate(
      { content: "appended", mode: "append" },
      makeContext({ sendToClient: undefined }),
    );

    expect(result.isError).toBe(false);
    const body = parseResult<{ success: boolean; surface_id: string }>(result);
    expect(body.success).toBe(true);
    // Web anchors its changed-document chip on this id, so a headless write
    // that omitted it would surface nothing.
    expect(body.surface_id).toBe("doc-headless");
    expect((await getDocumentById("doc-headless"))?.content).toBe(
      "start\n\nappended",
    );
  });

  test("still requires content", async () => {
    await seedDocument({
      surfaceId: "doc-only",
      conversationId: "conv-current",
      title: "X",
      content: "x",
      createdAt: Date.now(),
    });

    const result = await executeDocumentUpdate(
      { mode: "append" },
      makeContext(),
    );
    expect(result.isError).toBe(true);
    expect(result.content).toContain("content is required");
  });
});
