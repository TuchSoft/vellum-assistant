import { beforeEach, expect, test } from "bun:test";

import { describePg } from "../../__tests__/pg-test-db.js";
import {
  createComment,
  getComment,
  listComments,
} from "../../documents/document-comments-store.js";
import { requireMainDb } from "../../persistence/db-facade.js";
import { initializeDb } from "../../persistence/db-init.js";
import type { ToolContext, ToolExecutionResult } from "../types.js";
import {
  executeCommentList,
  executeCommentReply,
  executeCommentResolve,
} from "./document-comment-tool.js";

await initializeDb();

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const SURFACE_ID = "doc-comment-tool-test";
const CONVERSATION_ID = "conv-comment-tool";

function makeContext(overrides: Partial<ToolContext> = {}): ToolContext {
  return {
    workingDir: "/tmp/project",
    conversationId: CONVERSATION_ID,
    trustClass: "trusted_contact",
    executionChannel: "slack",
    ...overrides,
  };
}

function parseResult<T>(result: ToolExecutionResult): T {
  return JSON.parse(result.content) as T;
}

async function seedDocument(
  surfaceId: string = SURFACE_ID,
  conversationId: string = CONVERSATION_ID,
): Promise<void> {
  const db = requireMainDb();
  const now = Date.now();
  await db.run(
    /*sql*/ `INSERT INTO conversations (id, created_at, updated_at) VALUES (?, ?, ?) ON CONFLICT (id) DO NOTHING`,
    [conversationId, now, now],
  );
  await db.run(
    /*sql*/ `INSERT INTO documents (surface_id, conversation_id, title, content, word_count, created_at, updated_at)
     VALUES (?, ?, 'Test Doc', 'body', 2, ?, ?) ON CONFLICT (surface_id) DO NOTHING`,
    [surfaceId, conversationId, now, now],
  );
  await db.run(
    /*sql*/ `INSERT INTO document_conversations (surface_id, conversation_id, created_at) VALUES (?, ?, ?) ON CONFLICT DO NOTHING`,
    [surfaceId, conversationId, now],
  );
}

beforeEach(async () => {
  const db = requireMainDb();
  await db.run(`DELETE FROM document_comments`);
  await db.run(`DELETE FROM document_conversations`);
  await db.run(`DELETE FROM documents`);
  await db.run(`DELETE FROM conversations`);
  await seedDocument();
});

// ---------------------------------------------------------------------------
// comment_list
// ---------------------------------------------------------------------------

describePg("executeCommentList", () => {
  test("returns only open comments", async () => {
    const c1 = await createComment({
      surfaceId: SURFACE_ID,
      conversationId: CONVERSATION_ID,
      author: "user1",
      content: "Open comment",
    });
    const c2 = await createComment({
      surfaceId: SURFACE_ID,
      conversationId: CONVERSATION_ID,
      author: "user1",
      content: "Resolved comment",
    });
    // Resolve one directly via the store
    await requireMainDb().run(
      /*sql*/ `UPDATE document_comments SET status = 'resolved', resolved_by = 'user1', resolved_at = ? WHERE id = ?`,
      [Date.now(), c2.id],
    );

    const result = await executeCommentList(
      { surface_id: SURFACE_ID },
      makeContext(),
    );

    expect(result.isError).toBe(false);
    const body = parseResult<{
      success: boolean;
      comments: Array<{ id: string; content: string }>;
    }>(result);
    expect(body.success).toBe(true);
    expect(body.comments).toHaveLength(1);
    expect(body.comments[0].id).toBe(c1.id);
    expect(body.comments[0].content).toBe("Open comment");
  });

  test("includes anchor and thread metadata", async () => {
    const parent = await createComment({
      surfaceId: SURFACE_ID,
      conversationId: CONVERSATION_ID,
      author: "user1",
      content: "Fix this",
      anchorStart: 5,
      anchorEnd: 10,
      anchorText: "hello",
    });
    await createComment({
      surfaceId: SURFACE_ID,
      conversationId: CONVERSATION_ID,
      author: "assistant",
      content: "Will do",
      parentCommentId: parent.id,
    });

    const result = await executeCommentList(
      { surface_id: SURFACE_ID },
      makeContext(),
    );
    const body = parseResult<{
      comments: Array<{
        anchor_start: number | null;
        anchor_end: number | null;
        anchor_text: string | null;
        parent_comment_id: string | null;
      }>;
    }>(result);

    expect(body.comments).toHaveLength(2);
    expect(body.comments[0].anchor_start).toBe(5);
    expect(body.comments[0].anchor_end).toBe(10);
    expect(body.comments[0].anchor_text).toBe("hello");
    expect(body.comments[0].parent_comment_id).toBeNull();
    expect(body.comments[1].parent_comment_id).toBe(parent.id);
  });

  test("blocks access for non-privileged actors on other conversations", async () => {
    await seedDocument("doc-other", "conv-other");
    await createComment({
      surfaceId: "doc-other",
      conversationId: "conv-other",
      author: "user1",
      content: "Secret feedback",
    });

    const result = await executeCommentList(
      { surface_id: "doc-other" },
      makeContext({ conversationId: CONVERSATION_ID }),
    );

    expect(result.isError).toBe(true);
    expect(parseResult<{ error: string }>(result).error).toBe(
      "Document not found",
    );
  });

  test("allows guardian access to comments on any document", async () => {
    await seedDocument("doc-other", "conv-other");
    await createComment({
      surfaceId: "doc-other",
      conversationId: "conv-other",
      author: "user1",
      content: "Cross-conv comment",
    });

    const result = await executeCommentList(
      { surface_id: "doc-other" },
      makeContext({ trustClass: "guardian" }),
    );

    expect(result.isError).toBe(false);
    const body = parseResult<{ comments: Array<{ content: string }> }>(result);
    expect(body.comments).toHaveLength(1);
    expect(body.comments[0].content).toBe("Cross-conv comment");
  });
});

// ---------------------------------------------------------------------------
// comment_resolve
// ---------------------------------------------------------------------------

describePg("executeCommentResolve", () => {
  test("resolves a comment with resolved_by: 'assistant' and emits SSE event", async () => {
    const c = await createComment({
      surfaceId: SURFACE_ID,
      conversationId: CONVERSATION_ID,
      author: "user1",
      content: "Fix this",
    });

    const sent: Array<{ type: string; [key: string]: unknown }> = [];
    const result = await executeCommentResolve(
      { surface_id: SURFACE_ID, comment_id: c.id },
      makeContext({ sendToClient: (msg) => sent.push(msg) }),
    );

    expect(result.isError).toBe(false);
    const body = parseResult<{ success: boolean; comment_id: string }>(result);
    expect(body.success).toBe(true);
    expect(body.comment_id).toBe(c.id);

    // Verify the DB was updated
    const fetched = await getComment(c.id);
    expect(fetched!.status).toBe("resolved");
    expect(fetched!.resolvedBy).toBe("assistant");

    // Verify SSE event
    expect(sent).toHaveLength(1);
    expect(sent[0].type).toBe("document_comment_resolved");
    expect(sent[0].commentId).toBe(c.id);
    expect(sent[0].resolvedBy).toBe("assistant");
  });

  test("returns error for non-existent comment", async () => {
    const result = await executeCommentResolve(
      { surface_id: SURFACE_ID, comment_id: "comment-nonexistent" },
      makeContext(),
    );

    expect(result.isError).toBe(true);
    expect(parseResult<{ error: string }>(result).error).toBe(
      "Comment not found",
    );
  });

  test("blocks cross-conversation resolve for non-privileged actors", async () => {
    await seedDocument("doc-other", "conv-other");
    const c = await createComment({
      surfaceId: "doc-other",
      conversationId: "conv-other",
      author: "user1",
      content: "Cannot resolve this",
    });

    const result = await executeCommentResolve(
      { surface_id: "doc-other", comment_id: c.id },
      makeContext({ conversationId: CONVERSATION_ID }),
    );

    expect(result.isError).toBe(true);
    expect(parseResult<{ error: string }>(result).error).toBe(
      "Document not found",
    );
    // Comment should remain open
    expect((await getComment(c.id))!.status).toBe("open");
  });
});

// ---------------------------------------------------------------------------
// comment_reply
// ---------------------------------------------------------------------------

describePg("executeCommentReply", () => {
  test("creates a reply with parent_comment_id and author: 'assistant'", async () => {
    const parent = await createComment({
      surfaceId: SURFACE_ID,
      conversationId: CONVERSATION_ID,
      author: "user1",
      content: "Please explain",
    });

    const sent: Array<{ type: string; [key: string]: unknown }> = [];
    const result = await executeCommentReply(
      {
        surface_id: SURFACE_ID,
        comment_id: parent.id,
        content: "Here is my explanation",
      },
      makeContext({ sendToClient: (msg) => sent.push(msg) }),
    );

    expect(result.isError).toBe(false);
    const body = parseResult<{
      success: boolean;
      comment: {
        id: string;
        author: string;
        content: string;
        parent_comment_id: string;
      };
    }>(result);
    expect(body.success).toBe(true);
    expect(body.comment.author).toBe("assistant");
    expect(body.comment.content).toBe("Here is my explanation");
    expect(body.comment.parent_comment_id).toBe(parent.id);

    // Verify persisted in DB
    const fetched = await getComment(body.comment.id);
    expect(fetched).not.toBeNull();
    expect(fetched!.author).toBe("assistant");
    expect(fetched!.parentCommentId).toBe(parent.id);

    // Verify SSE event
    expect(sent).toHaveLength(1);
    expect(sent[0].type).toBe("document_comment_created");
    const eventComment = (sent[0] as unknown as { comment: { id: string } })
      .comment;
    expect(eventComment.id).toBe(body.comment.id);
  });

  test("blocks cross-conversation reply for non-privileged actors", async () => {
    await seedDocument("doc-other", "conv-other");
    const parent = await createComment({
      surfaceId: "doc-other",
      conversationId: "conv-other",
      author: "user1",
      content: "Feedback on other doc",
    });

    const result = await executeCommentReply(
      {
        surface_id: "doc-other",
        comment_id: parent.id,
        content: "Sneaky reply",
      },
      makeContext({ conversationId: CONVERSATION_ID }),
    );

    expect(result.isError).toBe(true);
    expect(parseResult<{ error: string }>(result).error).toBe(
      "Document not found",
    );
    // No reply should exist
    const comments = await listComments("doc-other");
    expect(comments).toHaveLength(1);
  });

  test("works without sendToClient (no SSE emission)", async () => {
    const parent = await createComment({
      surfaceId: SURFACE_ID,
      conversationId: CONVERSATION_ID,
      author: "user1",
      content: "Question",
    });

    const result = await executeCommentReply(
      {
        surface_id: SURFACE_ID,
        comment_id: parent.id,
        content: "Answer",
      },
      makeContext(),
    );

    expect(result.isError).toBe(false);
    const body = parseResult<{
      success: boolean;
      comment: { content: string };
    }>(result);
    expect(body.success).toBe(true);
    expect(body.comment.content).toBe("Answer");
  });
});

// ── model-input schema validation (LUM-2854) ────────────────────────

describePg("comment tools — model-input schema validation", () => {
  test("comment_list rejects a missing surface_id instead of 'Document not found'", async () => {
    const result = await executeCommentList({}, makeContext());
    expect(result.isError).toBe(true);
    expect(result.content).toContain('Invalid input for tool "comment_list"');
    expect(result.content).toContain("surface_id");
  });

  test("comment_resolve rejects a non-string comment_id", async () => {
    const result = await executeCommentResolve(
      { surface_id: SURFACE_ID, comment_id: 42 },
      makeContext(),
    );
    expect(result.isError).toBe(true);
    expect(result.content).toContain(
      'Invalid input for tool "comment_resolve"',
    );
    expect(result.content).toContain("comment_id");
  });

  test("comment_reply rejects a non-string content instead of persisting it", async () => {
    const parent = await createComment({
      surfaceId: SURFACE_ID,
      conversationId: CONVERSATION_ID,
      author: "user",
      content: "Question",
    });

    const result = await executeCommentReply(
      { surface_id: SURFACE_ID, comment_id: parent.id, content: 42 },
      makeContext(),
    );
    expect(result.isError).toBe(true);
    expect(result.content).toContain('Invalid input for tool "comment_reply"');
    expect(result.content).toContain("content");
    expect((await listComments(SURFACE_ID, {})).length).toBe(1);
  });

  test("comment tools pass unknown keys through (loose schema)", async () => {
    const result = await executeCommentList(
      { surface_id: SURFACE_ID, activity: "checking comments" },
      makeContext(),
    );
    expect(result.isError).toBe(false);
  });
});
