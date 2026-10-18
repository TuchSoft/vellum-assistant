import { beforeEach, expect, test } from "bun:test";

import { getDocumentById } from "../documents/document-store.js";
import { requireMainDb } from "../persistence/db-facade.js";
import {
  executeDocumentFind,
  executeDocumentReplaceText,
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

// ---------------------------------------------------------------------------
// document_find tests
// ---------------------------------------------------------------------------

interface FindResultBody {
  success: boolean;
  surface_id?: string;
  query?: string;
  total_matches?: number;
  matches?: Array<{
    line_number: number;
    line_content: string;
    match_start: number;
    match_end: number;
    match_text: string;
  }>;
  error?: string;
}

const MULTILINE_CONTENT = [
  "Hello World",
  "This is line two with some numbers 42 and 100",
  "hello again on line three",
  "HELLO UPPERCASE LINE FOUR",
  "Final line with special chars: foo-bar_baz",
].join("\n");

describePg("document_find", () => {
  beforeEach(async () => {
    await bootstrapDocumentTables();
    await seedDocument({
      surfaceId: "doc-find-test",
      conversationId: "conv-current",
      title: "Find Test Doc",
      content: MULTILINE_CONTENT,
      updatedAt: 1000,
    });
    await seedDocument({
      surfaceId: "doc-other-conv",
      conversationId: "conv-other",
      title: "Other Conv Doc",
      content: "secret content here",
      updatedAt: 2000,
    });
  });

  test("literal search finds exact matches with correct line numbers", async () => {
    const result = await executeDocumentFind(
      { surface_id: "doc-find-test", query: "Hello" },
      makeContext(),
    );
    const body = parseResult<FindResultBody>(result);

    expect(body.success).toBe(true);
    expect(body.total_matches).toBe(3);
    expect(body.matches![0].line_number).toBe(1);
    expect(body.matches![0].match_text).toBe("Hello");
    expect(body.matches![1].line_number).toBe(3);
    expect(body.matches![1].match_text).toBe("hello");
    expect(body.matches![2].line_number).toBe(4);
    expect(body.matches![2].match_text).toBe("HELLO");
  });

  test("case-insensitive search (default) matches regardless of case", async () => {
    const result = await executeDocumentFind(
      { surface_id: "doc-find-test", query: "hello" },
      makeContext(),
    );
    const body = parseResult<FindResultBody>(result);

    expect(body.success).toBe(true);
    expect(body.total_matches).toBe(3);
    const lineNumbers = body.matches!.map((m) => m.line_number);
    expect(lineNumbers).toEqual([1, 3, 4]);
  });

  test("case-sensitive search only matches exact case", async () => {
    const result = await executeDocumentFind(
      { surface_id: "doc-find-test", query: "Hello", case_sensitive: true },
      makeContext(),
    );
    const body = parseResult<FindResultBody>(result);

    expect(body.success).toBe(true);
    expect(body.total_matches).toBe(1);
    expect(body.matches![0].line_number).toBe(1);
    expect(body.matches![0].match_text).toBe("Hello");
  });

  test("regex search works", async () => {
    const result = await executeDocumentFind(
      { surface_id: "doc-find-test", query: "\\d+", regex: true },
      makeContext(),
    );
    const body = parseResult<FindResultBody>(result);

    expect(body.success).toBe(true);
    expect(body.total_matches).toBe(2);
    expect(body.matches![0].match_text).toBe("42");
    expect(body.matches![0].line_number).toBe(2);
    expect(body.matches![1].match_text).toBe("100");
    expect(body.matches![1].line_number).toBe(2);
  });

  test("invalid regex returns error gracefully", async () => {
    const result = await executeDocumentFind(
      { surface_id: "doc-find-test", query: "[invalid", regex: true },
      makeContext(),
    );
    const body = parseResult<FindResultBody>(result);

    expect(result.isError).toBe(true);
    expect(body.success).toBe(false);
    expect(body.error).toMatch(/Invalid regex/);
  });

  test("no matches returns success with empty array", async () => {
    const result = await executeDocumentFind(
      { surface_id: "doc-find-test", query: "nonexistent-text-xyz" },
      makeContext(),
    );
    const body = parseResult<FindResultBody>(result);

    expect(body.success).toBe(true);
    expect(body.total_matches).toBe(0);
    expect(body.matches).toEqual([]);
  });

  test("access control blocks non-guardian from searching documents outside their conversation", async () => {
    const result = await executeDocumentFind(
      { surface_id: "doc-other-conv", query: "secret" },
      makeContext({
        trustClass: "trusted_contact",
        executionChannel: "slack",
        conversationId: "conv-current",
      }),
    );

    expect(result.isError).toBe(true);
    const body = parseResult<FindResultBody>(result);
    expect(body.error).toBe("Document not found");
  });

  test("results are capped at 50 matches", async () => {
    const lines = Array.from({ length: 100 }, (_, i) => `match line ${i}`);
    await seedDocument({
      surfaceId: "doc-many-matches",
      conversationId: "conv-current",
      title: "Many Matches",
      content: lines.join("\n"),
      updatedAt: 3000,
    });

    const result = await executeDocumentFind(
      { surface_id: "doc-many-matches", query: "match" },
      makeContext(),
    );
    const body = parseResult<FindResultBody>(result);

    expect(body.success).toBe(true);
    expect(body.total_matches).toBe(100);
    expect(body.matches!.length).toBe(50);
  });
});

// ---------------------------------------------------------------------------
// document_replace_text tests
// ---------------------------------------------------------------------------

describePg("document_replace_text", () => {
  beforeEach(async () => {
    await bootstrapDocumentTables();
    await seedDocument({
      surfaceId: "doc-replace",
      conversationId: "conv-current",
      title: "Replace Test",
      content: "foo bar foo baz foo",
      updatedAt: 1000,
    });
    await seedDocument({
      surfaceId: "doc-other",
      conversationId: "conv-other",
      title: "Other Doc",
      content: "other content",
      updatedAt: 2000,
    });
  });

  test("literal replace replaces all occurrences", async () => {
    const result = await executeDocumentReplaceText(
      { surface_id: "doc-replace", find: "foo", replace: "qux" },
      makeContext({ sendToClient: () => {} }),
    );
    const body = parseResult<{
      success: boolean;
      replacements_made: number;
      content_changed: boolean;
    }>(result);
    expect(body.success).toBe(true);
    expect(body.replacements_made).toBe(3);
    expect(body.content_changed).toBe(true);
    expect((await getDocumentById("doc-replace"))?.content).toBe(
      "qux bar qux baz qux",
    );
  });

  test("case-insensitive literal replace (default)", async () => {
    await seedDocument({
      surfaceId: "doc-case",
      conversationId: "conv-current",
      title: "Case Test",
      content: "Foo FOO foo",
      updatedAt: 3000,
    });
    const result = await executeDocumentReplaceText(
      { surface_id: "doc-case", find: "foo", replace: "x" },
      makeContext({ sendToClient: () => {} }),
    );
    const body = parseResult<{
      success: boolean;
      replacements_made: number;
    }>(result);
    expect(body.success).toBe(true);
    expect(body.replacements_made).toBe(3);
    expect((await getDocumentById("doc-case"))?.content).toBe("x x x");
  });

  test("case-sensitive literal replace", async () => {
    await seedDocument({
      surfaceId: "doc-case-sensitive",
      conversationId: "conv-current",
      title: "Case Sensitive Test",
      content: "Foo FOO foo",
      updatedAt: 3000,
    });
    const result = await executeDocumentReplaceText(
      {
        surface_id: "doc-case-sensitive",
        find: "foo",
        replace: "x",
        case_sensitive: true,
      },
      makeContext({ sendToClient: () => {} }),
    );
    const body = parseResult<{
      success: boolean;
      replacements_made: number;
    }>(result);
    expect(body.success).toBe(true);
    expect(body.replacements_made).toBe(1);
    expect((await getDocumentById("doc-case-sensitive"))?.content).toBe(
      "Foo FOO x",
    );
  });

  test("regex replace with backreferences", async () => {
    await seedDocument({
      surfaceId: "doc-regex",
      conversationId: "conv-current",
      title: "Regex Test",
      content: "user1@example user2@test",
      updatedAt: 3000,
    });
    const result = await executeDocumentReplaceText(
      {
        surface_id: "doc-regex",
        find: "(\\w+)@(\\w+)",
        replace: "$2/$1",
        regex: true,
        case_sensitive: true,
      },
      makeContext({ sendToClient: () => {} }),
    );
    const body = parseResult<{
      success: boolean;
      replacements_made: number;
    }>(result);
    expect(body.success).toBe(true);
    expect(body.replacements_made).toBe(2);
    expect((await getDocumentById("doc-regex"))?.content).toBe(
      "example/user1 test/user2",
    );
  });

  test("invalid regex returns clean error", async () => {
    const result = await executeDocumentReplaceText(
      {
        surface_id: "doc-replace",
        find: "[invalid",
        replace: "x",
        regex: true,
      },
      makeContext({ sendToClient: () => {} }),
    );
    const body = parseResult<{ success: boolean; error: string }>(result);
    expect(body.success).toBe(false);
    expect(body.error).toMatch(/Invalid regex/);
    expect(result.isError).toBe(true);
  });

  test("max_replacements limits substitutions", async () => {
    const result = await executeDocumentReplaceText(
      {
        surface_id: "doc-replace",
        find: "foo",
        replace: "qux",
        max_replacements: 1,
      },
      makeContext({ sendToClient: () => {} }),
    );
    const body = parseResult<{
      success: boolean;
      replacements_made: number;
      content_changed: boolean;
    }>(result);
    expect(body.success).toBe(true);
    expect(body.replacements_made).toBe(1);
    expect(body.content_changed).toBe(true);
    expect((await getDocumentById("doc-replace"))?.content).toBe(
      "qux bar foo baz foo",
    );
  });

  test("max_replacements with regex backreferences replaces correctly", async () => {
    await seedDocument({
      surfaceId: "doc-regex-limit",
      conversationId: "conv-current",
      title: "Regex Limit Test",
      content: "a@b c@d e@f",
      updatedAt: 3000,
    });
    const result = await executeDocumentReplaceText(
      {
        surface_id: "doc-regex-limit",
        find: "(\\w+)@(\\w+)",
        replace: "$2/$1",
        regex: true,
        case_sensitive: true,
        max_replacements: 2,
      },
      makeContext({ sendToClient: () => {} }),
    );
    const body = parseResult<{
      success: boolean;
      replacements_made: number;
      content_changed: boolean;
    }>(result);
    expect(body.success).toBe(true);
    expect(body.replacements_made).toBe(2);
    expect(body.content_changed).toBe(true);
    expect((await getDocumentById("doc-regex-limit"))?.content).toBe(
      "b/a d/c e@f",
    );
  });

  test("no matches returns success with zero replacements", async () => {
    const result = await executeDocumentReplaceText(
      { surface_id: "doc-replace", find: "nonexistent", replace: "x" },
      makeContext({ sendToClient: () => {} }),
    );
    const body = parseResult<{
      success: boolean;
      replacements_made: number;
      content_changed: boolean;
    }>(result);
    expect(body.success).toBe(true);
    expect(body.replacements_made).toBe(0);
    expect(body.content_changed).toBe(false);
    expect((await getDocumentById("doc-replace"))?.content).toBe(
      "foo bar foo baz foo",
    );
  });

  test("word_count is recalculated after replacement", async () => {
    const before = await getDocumentById("doc-replace");
    expect(before?.wordCount).toBe(5);

    await executeDocumentReplaceText(
      { surface_id: "doc-replace", find: "foo", replace: "one two" },
      makeContext({ sendToClient: () => {} }),
    );
    const after = await getDocumentById("doc-replace");
    expect(after?.wordCount).toBe(8);
  });

  test("access control blocks non-guardian from other conversations", async () => {
    const remoteContext = makeContext({
      trustClass: "trusted_contact",
      executionChannel: "slack",
      sendToClient: () => {},
    });
    const result = await executeDocumentReplaceText(
      { surface_id: "doc-other", find: "other", replace: "x" },
      remoteContext,
    );
    expect(result.isError).toBe(true);
    const body = parseResult<{ error: string }>(result);
    expect(body.error).toBe("Document not found");
    expect((await getDocumentById("doc-other"))?.content).toBe("other content");
  });

  test("client is notified via sendToClient with updated content", async () => {
    const messages: unknown[] = [];
    const sendToClient = (msg: unknown) => {
      messages.push(msg);
    };
    await executeDocumentReplaceText(
      { surface_id: "doc-replace", find: "foo", replace: "qux" },
      makeContext({ sendToClient }),
    );
    expect(messages).toHaveLength(1);
    const msg = messages[0] as {
      type: string;
      surfaceId: string;
      markdown: string;
      mode: string;
    };
    expect(msg.type).toBe("document_editor_update");
    expect(msg.surfaceId).toBe("doc-replace");
    expect(msg.mode).toBe("replace");
    expect(msg.markdown).toBe("qux bar qux baz qux");
  });
});
