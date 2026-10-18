import { beforeEach, expect, test } from "bun:test";

import { getDocumentById } from "../documents/document-store.js";
import { requireMainDb } from "../persistence/db-facade.js";
import {
  executeDocumentCreate,
  executeDocumentDelete,
  executeDocumentFind,
  executeDocumentList,
  executeDocumentRead,
  executeDocumentReplaceText,
  executeDocumentUpdate,
} from "../tools/document/document-tool.js";
import type { ToolContext, ToolExecutionResult } from "../tools/types.js";
import { describePg } from "./pg-test-db.js";

function makeContext(overrides: Partial<ToolContext> = {}): ToolContext {
  return {
    workingDir: "/tmp/project",
    conversationId: "conv-current",
    trustClass: "trusted_contact",
    executionChannel: "slack",
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
  updatedAt: number;
}): Promise<void> {
  const db = requireMainDb();
  await db.run(
    `INSERT INTO conversations (id, created_at, updated_at) VALUES (?, ?, ?) ON CONFLICT DO NOTHING`,
    [params.conversationId, params.updatedAt, params.updatedAt],
  );
  await db.run(
    `INSERT INTO documents (surface_id, conversation_id, title, content, word_count, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)`,
    [
      params.surfaceId,
      params.conversationId,
      params.title,
      params.content,
      params.content.split(/\s+/).filter(Boolean).length,
      params.updatedAt,
      params.updatedAt,
    ],
  );
  await db.run(
    `INSERT INTO document_conversations (surface_id, conversation_id, created_at) VALUES (?, ?, ?) ON CONFLICT DO NOTHING`,
    [params.surfaceId, params.conversationId, params.updatedAt],
  );
}

async function seedFixtureDocuments(): Promise<void> {
  await seedDocument({
    surfaceId: "doc-current",
    conversationId: "conv-current",
    title: "Current Business Plan",
    content: "current plan",
    updatedAt: 1000,
  });
  await seedDocument({
    surfaceId: "doc-other",
    conversationId: "conv-other",
    title: "Other Business Plan",
    content: "other plan",
    updatedAt: 2000,
  });
  await seedDocument({
    surfaceId: "doc-percent",
    conversationId: "conv-other",
    title: "100% Plan",
    content: "literal percent",
    updatedAt: 3000,
  });
}

describePg("document tool security", () => {
  beforeEach(async () => {
    await bootstrapDocumentTables();
    await seedFixtureDocuments();
  });

  test("scopes title search to the current conversation for non-guardian remote actors", async () => {
    const result = await executeDocumentList(
      { query: "Business Plan" },
      makeContext({ trustClass: "trusted_contact", executionChannel: "slack" }),
    );

    const body = parseResult<{ documents: Array<{ surface_id: string }> }>(
      result,
    );
    expect(body.documents.map((doc) => doc.surface_id)).toEqual([
      "doc-current",
    ]);
  });

  test("does not treat SQL LIKE wildcards as title-search wildcards", async () => {
    const result = await executeDocumentList(
      { query: "%" },
      makeContext({ trustClass: "guardian", executionChannel: "telegram" }),
    );

    const body = parseResult<{ documents: Array<{ surface_id: string }> }>(
      result,
    );
    expect(body.documents.map((doc) => doc.surface_id)).toEqual([
      "doc-percent",
    ]);
  });

  test("allows guardian and local actors to use documents from previous conversations", async () => {
    const guardianContext = makeContext({
      trustClass: "guardian",
      executionChannel: "telegram",
      sendToClient: () => {},
    });
    const guardianList = await executeDocumentList(
      { query: "Other Business" },
      guardianContext,
    );
    const guardianBody = parseResult<{
      documents: Array<{ surface_id: string }>;
    }>(guardianList);
    expect(guardianBody.documents.map((doc) => doc.surface_id)).toEqual([
      "doc-other",
    ]);

    const localRead = await executeDocumentRead(
      { surface_id: "doc-other" },
      makeContext({ trustClass: "unknown", executionChannel: "vellum" }),
    );
    const localBody = parseResult<{
      success: boolean;
      surface_id: string;
      content: string;
    }>(localRead);
    expect(localBody).toMatchObject({
      success: true,
      surface_id: "doc-other",
      content: "other plan",
    });

    const guardianUpdate = await executeDocumentUpdate(
      { surface_id: "doc-other", content: "guardian edit", mode: "replace" },
      guardianContext,
    );
    expect(guardianUpdate.isError).toBe(false);
    expect((await getDocumentById("doc-other"))?.content).toBe("guardian edit");

    const guardianDelete = await executeDocumentDelete(
      { surface_id: "doc-other" },
      guardianContext,
    );
    expect(guardianDelete.isError).toBe(false);
    expect(await getDocumentById("doc-other")).toBeNull();
  });

  test("blocks cross-conversation read, update, and delete for non-guardian remote actors", async () => {
    const remoteContext = makeContext({
      trustClass: "trusted_contact",
      executionChannel: "slack",
      sendToClient: () => {},
    });

    const read = await executeDocumentRead(
      { surface_id: "doc-other" },
      remoteContext,
    );
    expect(read.isError).toBe(true);
    expect(parseResult<{ error: string }>(read).error).toBe(
      "Document not found",
    );

    const update = await executeDocumentUpdate(
      {
        surface_id: "doc-other",
        content: "updated by another conversation",
        mode: "replace",
      },
      remoteContext,
    );
    expect(update.isError).toBe(true);
    expect((await getDocumentById("doc-other"))?.content).toBe("other plan");

    const deleted = await executeDocumentDelete(
      { surface_id: "doc-other" },
      remoteContext,
    );
    expect(deleted.isError).toBe(true);
    expect(await getDocumentById("doc-other")).not.toBeNull();
  });

  test("keeps current-conversation documents editable and deletable", async () => {
    const remoteContext = makeContext({
      trustClass: "trusted_contact",
      executionChannel: "slack",
      sendToClient: () => {},
    });

    const read = await executeDocumentRead(
      { surface_id: "doc-current" },
      remoteContext,
    );
    expect(read.isError).toBe(false);

    const update = await executeDocumentUpdate(
      { surface_id: "doc-current", content: "revised plan", mode: "replace" },
      remoteContext,
    );
    expect(update.isError).toBe(false);
    expect((await getDocumentById("doc-current"))?.content).toBe(
      "revised plan",
    );

    const deleted = await executeDocumentDelete(
      { surface_id: "doc-current" },
      remoteContext,
    );
    expect(deleted.isError).toBe(false);
    expect(await getDocumentById("doc-current")).toBeNull();
  });
});

describePg("executeDocumentUpdate — input validation", () => {
  beforeEach(async () => {
    await bootstrapDocumentTables();
    await seedFixtureDocuments();
  });

  test("resolves to the conversation's document when surface_id is omitted", async () => {
    const result = await executeDocumentUpdate(
      { content: "appended chunk" },
      makeContext({ sendToClient: () => {} }),
    );
    expect(result.isError).toBe(false);
    const body = parseResult<{ surface_id: string; success: boolean }>(result);
    expect(body.success).toBe(true);
    expect(body.surface_id).toBe("doc-current");
  });

  test("returns Invalid input when content is missing", async () => {
    const result = await executeDocumentUpdate(
      { surface_id: "doc-x" },
      makeContext(),
    );
    expect(result.isError).toBe(true);
    const body = parseResult<{ error: string }>(result);
    expect(body.error).toBe(
      "Invalid input: content is required and must be a string",
    );
  });

  test("allows empty string content (falls through to access check)", async () => {
    const result = await executeDocumentUpdate(
      { surface_id: "doc-x", content: "" },
      makeContext(),
    );
    expect(result.isError).toBe(true);
    const body = parseResult<{ error: string }>(result);
    // Did NOT fail input validation; fell through to access/not-found path.
    expect(body.error).toBe("Document not found");
  });

  test("returns Invalid input when mode is not replace or append", async () => {
    const result = await executeDocumentUpdate(
      { surface_id: "doc-x", content: "hi", mode: "bogus" },
      makeContext(),
    );
    expect(result.isError).toBe(true);
    const body = parseResult<{ error: string }>(result);
    expect(body.error).toBe(
      'Invalid input: mode must be "replace" or "append"',
    );
  });

  test("treats mode: null the same as undefined (factory validator accepts both)", async () => {
    // validateInputAgainstSchema treats null as "absent" for enum checks, so
    // the executor must agree — { mode: null } should fall through to the
    // access check, not return a confusing 'mode must be ...' error.
    const result = await executeDocumentUpdate(
      { surface_id: "doc-x", content: "hi", mode: null },
      makeContext(),
    );
    expect(result.isError).toBe(true);
    const body = parseResult<{ error: string }>(result);
    expect(body.error).not.toContain("Invalid input: mode");
    expect(body.error).toBe("Document not found");
  });

  test("executeDocumentRead returns Invalid input when surface_id is missing", async () => {
    const result = await executeDocumentRead({}, makeContext());
    expect(result.isError).toBe(true);
    const body = parseResult<{ error: string }>(result);
    expect(body.error).toContain("Invalid input: surface_id is required");
  });

  test("executeDocumentDelete returns Invalid input when surface_id is missing", async () => {
    const result = await executeDocumentDelete({}, makeContext());
    expect(result.isError).toBe(true);
    const body = parseResult<{ error: string }>(result);
    expect(body.error).toContain("Invalid input: surface_id is required");
  });
});

// ── model-input schema validation (LUM-2854) ─────────────────────────

describePg("document tools — model-input schema validation", () => {
  beforeEach(async () => {
    await bootstrapDocumentTables();
    await seedFixtureDocuments();
  });

  test("document_find rejects a non-string query instead of crashing downstream", async () => {
    const result = await executeDocumentFind(
      { surface_id: "doc-current", query: 42 },
      makeContext(),
    );
    expect(result.isError).toBe(true);
    expect(result.content).toContain('Invalid input for tool "document_find"');
    expect(result.content).toContain("query");
  });

  test("document_find rejects a missing query cleanly", async () => {
    const result = await executeDocumentFind(
      { surface_id: "doc-current" },
      makeContext(),
    );
    expect(result.isError).toBe(true);
    expect(result.content).toContain('Invalid input for tool "document_find"');
  });

  test("document_find treats null option flags as omitted", async () => {
    const result = await executeDocumentFind(
      {
        surface_id: "doc-current",
        query: "current",
        regex: null,
        case_sensitive: null,
      },
      makeContext(),
    );
    expect(result.isError).toBe(false);
    const body = parseResult<{ total_matches: number }>(result);
    expect(body.total_matches).toBe(1);
  });

  test("document_create rejects a non-string title instead of persisting it", async () => {
    const result = await executeDocumentCreate(
      { title: 42, initial_content: "hello" },
      makeContext({ conversationId: "conv-current" }),
    );
    expect(result.isError).toBe(true);
    expect(result.content).toContain(
      'Invalid input for tool "document_create"',
    );
    expect(result.content).toContain("title");
  });

  test("document_update rejects a non-string content before the bespoke checks", async () => {
    const result = await executeDocumentUpdate(
      { surface_id: "doc-current", content: 42 },
      makeContext(),
    );
    expect(result.isError).toBe(true);
    expect(result.content).toContain(
      'Invalid input for tool "document_update"',
    );
  });

  test("document_list still silently ignores a malformed query", async () => {
    const result = await executeDocumentList({ query: 42 }, makeContext());
    expect(result.isError).toBe(false);
    const body = parseResult<{ documents: Array<{ surface_id: string }> }>(
      result,
    );
    expect(body.documents.map((d) => d.surface_id)).toEqual(["doc-current"]);
  });

  test("document_replace_text rejects a non-number max_replacements", async () => {
    const result = await executeDocumentReplaceText(
      {
        surface_id: "doc-current",
        find: "current",
        replace: "new",
        max_replacements: "3",
      },
      makeContext(),
    );
    expect(result.isError).toBe(true);
    expect(result.content).toContain(
      'Invalid input for tool "document_replace_text"',
    );
    expect(result.content).toContain("max_replacements");
  });
});
