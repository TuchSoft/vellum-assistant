import { beforeEach, expect, test } from "bun:test";

import { describePg } from "../__tests__/pg-test-db.js";
import { requireMainDb } from "../persistence/db-facade.js";
import {
  createComment,
  deleteComment,
  getComment,
  getCommentCountForDocument,
  listComments,
  reopenComment,
  resolveComment,
} from "./document-comments-store.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const SURFACE_ID = "doc-test-surface";
const CONVERSATION_ID = "conv-test-123";

/** Insert a minimal document so FK constraints are satisfied. */
async function seedDocument(surfaceId: string = SURFACE_ID): Promise<void> {
  const now = Date.now();
  const db = requireMainDb();
  await db.run(
    `INSERT INTO conversations (id, created_at, updated_at) VALUES (?, ?, ?)
     ON CONFLICT (id) DO NOTHING`,
    [CONVERSATION_ID, now, now],
  );
  await db.run(
    `INSERT INTO documents (surface_id, conversation_id, title, content, word_count, created_at, updated_at)
     VALUES (?, ?, 'Test Doc', 'body', 2, ?, ?)
     ON CONFLICT (surface_id) DO NOTHING`,
    [surfaceId, CONVERSATION_ID, now, now],
  );
}

beforeEach(async () => {
  const db = requireMainDb();
  await db.run("DELETE FROM document_comments");
  await db.run("DELETE FROM documents");
  await db.run("DELETE FROM conversations");
  await seedDocument();
});

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describePg("createComment", () => {
  test("creates a comment and returns the record", async () => {
    const comment = await createComment({
      surfaceId: SURFACE_ID,
      conversationId: CONVERSATION_ID,
      author: "user1",
      content: "Looks good!",
    });

    expect(comment.id).toMatch(/^comment-/);
    expect(comment.surfaceId).toBe(SURFACE_ID);
    expect(comment.conversationId).toBe(CONVERSATION_ID);
    expect(comment.author).toBe("user1");
    expect(comment.content).toBe("Looks good!");
    expect(comment.status).toBe("open");
    expect(comment.parentCommentId).toBeNull();
    expect(comment.anchorStart).toBeNull();
    expect(comment.resolvedBy).toBeNull();
    expect(comment.resolvedAt).toBeNull();
  });

  test("creates a comment with anchor data", async () => {
    const comment = await createComment({
      surfaceId: SURFACE_ID,
      conversationId: CONVERSATION_ID,
      author: "user1",
      content: "Fix this typo",
      anchorStart: 10,
      anchorEnd: 15,
      anchorText: "wrold",
    });

    expect(comment.anchorStart).toBe(10);
    expect(comment.anchorEnd).toBe(15);
    expect(comment.anchorText).toBe("wrold");
  });
});

describePg("getComment", () => {
  test("returns a comment by id", async () => {
    const created = await createComment({
      surfaceId: SURFACE_ID,
      conversationId: CONVERSATION_ID,
      author: "user1",
      content: "Hello",
    });

    const fetched = await getComment(created.id);
    expect(fetched).not.toBeNull();
    expect(fetched!.id).toBe(created.id);
    expect(fetched!.content).toBe("Hello");
  });

  test("returns null for non-existent id", async () => {
    expect(await getComment("comment-nonexistent")).toBeNull();
  });
});

describePg("listComments", () => {
  test("lists all comments for a surface ordered by created_at ASC", async () => {
    await createComment({
      surfaceId: SURFACE_ID,
      conversationId: CONVERSATION_ID,
      author: "user1",
      content: "First",
    });
    await createComment({
      surfaceId: SURFACE_ID,
      conversationId: CONVERSATION_ID,
      author: "user1",
      content: "Second",
    });

    const comments = await listComments(SURFACE_ID);
    expect(comments).toHaveLength(2);
    expect(comments[0].content).toBe("First");
    expect(comments[1].content).toBe("Second");
  });

  test("filters by status=open", async () => {
    const c = await createComment({
      surfaceId: SURFACE_ID,
      conversationId: CONVERSATION_ID,
      author: "user1",
      content: "Open one",
    });
    await createComment({
      surfaceId: SURFACE_ID,
      conversationId: CONVERSATION_ID,
      author: "user1",
      content: "Resolved one",
    });
    await resolveComment(c.id, "user1");

    const open = await listComments(SURFACE_ID, { status: "open" });
    expect(open).toHaveLength(1);
    expect(open[0].content).toBe("Resolved one");

    const resolved = await listComments(SURFACE_ID, { status: "resolved" });
    expect(resolved).toHaveLength(1);
    expect(resolved[0].content).toBe("Open one");
  });

  test("filters topLevelOnly (excludes replies)", async () => {
    const parent = await createComment({
      surfaceId: SURFACE_ID,
      conversationId: CONVERSATION_ID,
      author: "user1",
      content: "Top-level",
    });
    await createComment({
      surfaceId: SURFACE_ID,
      conversationId: CONVERSATION_ID,
      author: "user1",
      content: "Reply",
      parentCommentId: parent.id,
    });

    const topLevel = await listComments(SURFACE_ID, { topLevelOnly: true });
    expect(topLevel).toHaveLength(1);
    expect(topLevel[0].content).toBe("Top-level");

    const all = await listComments(SURFACE_ID);
    expect(all).toHaveLength(2);
  });

  test("returns empty array for unknown surface", async () => {
    expect(await listComments("nonexistent-surface")).toHaveLength(0);
  });
});

describePg("resolveComment", () => {
  test("sets resolved fields", async () => {
    const c = await createComment({
      surfaceId: SURFACE_ID,
      conversationId: CONVERSATION_ID,
      author: "user1",
      content: "Fix this",
    });

    const result = await resolveComment(c.id, "user1");
    expect(result).toBe(true);

    const fetched = await getComment(c.id);
    expect(fetched!.status).toBe("resolved");
    expect(fetched!.resolvedBy).toBe("user1");
    expect(fetched!.resolvedAt).toBeGreaterThan(0);
    expect(fetched!.updatedAt).toBeGreaterThanOrEqual(c.updatedAt);
  });

  test("returns false for non-existent comment", async () => {
    expect(await resolveComment("comment-nonexistent", "user1")).toBe(false);
  });
});

describePg("reopenComment", () => {
  test("clears resolved fields", async () => {
    const c = await createComment({
      surfaceId: SURFACE_ID,
      conversationId: CONVERSATION_ID,
      author: "user1",
      content: "Fix this",
    });
    await resolveComment(c.id, "user1");

    const result = await reopenComment(c.id);
    expect(result).toBe(true);

    const fetched = await getComment(c.id);
    expect(fetched!.status).toBe("open");
    expect(fetched!.resolvedBy).toBeNull();
    expect(fetched!.resolvedAt).toBeNull();
  });

  test("returns false for non-existent comment", async () => {
    expect(await reopenComment("comment-nonexistent")).toBe(false);
  });
});

describePg("deleteComment", () => {
  test("deletes a comment", async () => {
    const c = await createComment({
      surfaceId: SURFACE_ID,
      conversationId: CONVERSATION_ID,
      author: "user1",
      content: "Delete me",
    });

    expect(await deleteComment(c.id)).toBe(true);
    expect(await getComment(c.id)).toBeNull();
  });

  test("returns false for non-existent comment", async () => {
    expect(await deleteComment("comment-nonexistent")).toBe(false);
  });

  test("cascades to child replies", async () => {
    const parent = await createComment({
      surfaceId: SURFACE_ID,
      conversationId: CONVERSATION_ID,
      author: "user1",
      content: "Parent",
    });
    const reply = await createComment({
      surfaceId: SURFACE_ID,
      conversationId: CONVERSATION_ID,
      author: "user1",
      content: "Reply",
      parentCommentId: parent.id,
    });

    expect(await deleteComment(parent.id)).toBe(true);
    expect(await getComment(parent.id)).toBeNull();
    expect(await getComment(reply.id)).toBeNull();
  });
});

describePg("getCommentCountForDocument", () => {
  test("counts only open comments", async () => {
    const c = await createComment({
      surfaceId: SURFACE_ID,
      conversationId: CONVERSATION_ID,
      author: "user1",
      content: "Open",
    });
    await createComment({
      surfaceId: SURFACE_ID,
      conversationId: CONVERSATION_ID,
      author: "user1",
      content: "Also open",
    });

    expect(await getCommentCountForDocument(SURFACE_ID)).toBe(2);

    await resolveComment(c.id, "user1");
    expect(await getCommentCountForDocument(SURFACE_ID)).toBe(1);
  });

  test("returns 0 for surface with no comments", async () => {
    expect(await getCommentCountForDocument(SURFACE_ID)).toBe(0);
  });
});

describePg("thread support", () => {
  test("reply has parent_comment_id set", async () => {
    const parent = await createComment({
      surfaceId: SURFACE_ID,
      conversationId: CONVERSATION_ID,
      author: "user1",
      content: "Parent",
    });
    const reply = await createComment({
      surfaceId: SURFACE_ID,
      conversationId: CONVERSATION_ID,
      author: "user1",
      content: "Reply",
      parentCommentId: parent.id,
    });

    const fetched = await getComment(reply.id);
    expect(fetched!.parentCommentId).toBe(parent.id);
  });
});

describePg("cascade on document delete", () => {
  test("deleting a document removes its comments", async () => {
    await createComment({
      surfaceId: SURFACE_ID,
      conversationId: CONVERSATION_ID,
      author: "user1",
      content: "Will be cascaded",
    });

    expect(await listComments(SURFACE_ID)).toHaveLength(1);

    // Delete the document — FK cascade should remove comments.
    await requireMainDb().run(`DELETE FROM documents WHERE surface_id = ?`, [
      SURFACE_ID,
    ]);

    expect(await listComments(SURFACE_ID)).toHaveLength(0);
  });
});
