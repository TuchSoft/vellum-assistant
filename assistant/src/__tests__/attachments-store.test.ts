import { existsSync, mkdirSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { beforeEach, expect, setDefaultTimeout, test } from "bun:test";

import {
  offloadOversizedText,
  OVERSIZED_CONTENT_FILENAME_PREFIX,
} from "../daemon/port-oversized-content.js";
import {
  attachInlineAttachmentToMessage,
  AttachmentUploadError,
  createInlineAttachment,
  deleteAttachment,
  deleteOrphanAttachments,
  getAttachmentById,
  getAttachmentContent,
  getAttachmentsByIds,
  getAttachmentsForMessage,
  getFilePathForAttachment,
  isValidBase64,
  linkAttachmentToMessage,
  MAX_UPLOAD_BYTES,
  resolveAttachmentsForPersist,
  uploadAttachment,
  validateAttachmentUpload,
} from "../persistence/attachments-store.js";
import {
  addMessage,
  createConversation,
  deleteMessageById,
} from "../persistence/conversation-crud.js";
import { getConversationDirPath } from "../persistence/conversation-disk-view.js";
import { requireMainDb } from "../persistence/db-facade.js";
import { rawGetAsync, rawRunAsync } from "../persistence/raw-query.js";
import { mediaSourceBytes } from "../providers/media-resolve.js";
import { getConversationsDir } from "../util/platform.js";
import { setConfig } from "./helpers/set-config.js";
import { describePg } from "./pg-test-db.js";

// Disable memory so addMessage skips background indexing of test messages.
setConfig("memory", { enabled: false });

async function resetTables(): Promise<void> {
  const db = requireMainDb();
  await db.run("DELETE FROM message_attachments");
  await db.run("DELETE FROM attachments");
  await db.run("DELETE FROM messages");
  await db.run("DELETE FROM conversations");
}

function getConversationTimestamp(createdAt: number): string {
  return new Date(createdAt).toISOString().replace(/:/g, "-");
}

function getLegacyConversationDirPath(
  conversationId: string,
  createdAt: number,
): string {
  return join(
    getConversationsDir(),
    `${conversationId}_${getConversationTimestamp(createdAt)}`,
  );
}

// ---------------------------------------------------------------------------
// uploadAttachment — stages until linked
// ---------------------------------------------------------------------------

describePg("uploadAttachment", () => {
  beforeEach(resetTables);

  test("stores attachment and returns metadata", async () => {
    const stored = await uploadAttachment("chart.png", "image/png", "iVBORw0K");

    expect(stored.id).toBeDefined();
    expect(stored.originalFilename).toBe("chart.png");
    expect(stored.mimeType).toBe("image/png");
    expect(stored.kind).toBe("image");
    expect(stored.sizeBytes).toBeGreaterThan(0);
    expect(stored.createdAt).toBeGreaterThan(0);
  });

  test("keeps uploads staged until linked", async () => {
    const stored = await uploadAttachment(
      "small.txt",
      "text/plain",
      "aGVsbG8=",
    );
    const filePath = await getFilePathForAttachment(stored.id);

    expect(filePath).toBeNull();
    expect((await getAttachmentContent(stored.id))?.toString()).toBe("hello");
  });

  test("stores base64 in the DB row until linked", async () => {
    const stored = await uploadAttachment("test.txt", "text/plain", "dGVzdA==");

    // Staged uploads keep the payload inline until they are attached to a message.
    const rawRow = await rawGetAsync<{ data_base64: string }>(
      "test:fetchAttachmentData",
      "SELECT data_base64 FROM attachments WHERE id = ?",
      stored.id,
    );
    expect(rawRow!.data_base64).toBe("dGVzdA==");

    const row = await getAttachmentById(stored.id, { hydrateFileData: true });
    expect(row).not.toBeNull();
    expect(row!.dataBase64).toBe("dGVzdA==");
  });

  test("classifies image MIME as image kind", async () => {
    const stored = await uploadAttachment("pic.jpg", "image/jpeg", "AAAA");
    expect(stored.kind).toBe("image");
  });

  test("classifies non-image MIME as document kind", async () => {
    const stored = await uploadAttachment(
      "doc.pdf",
      "application/pdf",
      "JVBER",
    );
    expect(stored.kind).toBe("document");
  });

  test("generates unique IDs for each upload", async () => {
    const a = await uploadAttachment("a.txt", "text/plain", "AA==");
    const b = await uploadAttachment("b.txt", "text/plain", "QQ==");
    expect(a.id).not.toBe(b.id);
  });

  test("computes sizeBytes from base64 correctly", async () => {
    // "hello" = "aGVsbG8=" (8 chars, 1 pad -> 5 bytes)
    const stored = await uploadAttachment(
      "hello.txt",
      "text/plain",
      "aGVsbG8=",
    );
    expect(stored.sizeBytes).toBe(5);
  });

  test("does not deduplicate identical uploads before linking", async () => {
    const first = await uploadAttachment(
      "photo.png",
      "image/png",
      "iVBORw0KGgoAAAANSUh",
    );
    const second = await uploadAttachment(
      "photo.png",
      "image/png",
      "iVBORw0KGgoAAAANSUh",
    );
    expect(second.id).not.toBe(first.id);
  });

  test("does not deduplicate identical content when filenames differ", async () => {
    const first = await uploadAttachment(
      "original.png",
      "image/png",
      "DUPECONTENT123",
    );
    const second = await uploadAttachment(
      "renamed.png",
      "image/png",
      "DUPECONTENT123",
    );
    expect(second.id).not.toBe(first.id);
  });

  test("does not deduplicate different content", async () => {
    const first = await uploadAttachment("a.txt", "text/plain", "CONTENTA");
    const second = await uploadAttachment("b.txt", "text/plain", "CONTENTB");
    expect(second.id).not.toBe(first.id);
  });

  test("rejects payloads exceeding MAX_UPLOAD_BYTES", async () => {
    // Build a base64 string that decodes to just over the limit.
    // 4 base64 chars -> 3 bytes, so we need ceil((MAX_UPLOAD_BYTES+1)/3)*4 chars.
    const oversizedLength = Math.ceil((MAX_UPLOAD_BYTES + 1) / 3) * 4;
    const oversizedData = "A".repeat(oversizedLength);

    await expect(
      uploadAttachment("huge.bin", "application/octet-stream", oversizedData),
    ).rejects.toThrow(AttachmentUploadError);
  });

  test("rejects invalid base64 data", async () => {
    await expect(
      uploadAttachment("bad.txt", "text/plain", "!!!not-base64!!!"),
    ).rejects.toThrow(AttachmentUploadError);
  });

  test("accepts base64 with non-standard padding/length", async () => {
    // Lenient on length -- only character set is validated
    await expect(
      uploadAttachment("ok.txt", "text/plain", "AAA"),
    ).resolves.toBeDefined();
  });

  // Inserting the 100 MB payload into SQLite can take several seconds on
  // slow CI runners, so this test needs more than the default 5s timeout.
  test("accepts payload exactly at MAX_UPLOAD_BYTES", async () => {
    // MAX_UPLOAD_BYTES (100 MB) is divisible by 3, so (MAX/3)*4 base64 chars
    // decodes to exactly MAX bytes with no padding.
    const exactLength = (MAX_UPLOAD_BYTES / 3) * 4;
    const exactData = "A".repeat(exactLength);

    await expect(
      uploadAttachment("exact.bin", "application/octet-stream", exactData),
    ).resolves.toBeDefined();
  }, 30_000);
});

// ---------------------------------------------------------------------------
// getAttachmentContent — staged inline or materialized on disk
// ---------------------------------------------------------------------------

describePg("getAttachmentContent", () => {
  beforeEach(resetTables);

  test("returns staged content before the attachment is linked", async () => {
    const stored = await uploadAttachment(
      "hello.txt",
      "text/plain",
      "aGVsbG8=",
    );
    const content = await getAttachmentContent(stored.id);

    expect(content).not.toBeNull();
    expect(content!.toString()).toBe("hello");
  });

  test("returns null for nonexistent attachment", async () => {
    const content = await getAttachmentContent("no-such-id");
    expect(content).toBeNull();
  });

  test("returns null when a materialized on-disk file is missing (ENOENT)", async () => {
    const conv = await createConversation();
    const msg = await addMessage(conv.id, "assistant", "File");
    const stored = await uploadAttachment("test.txt", "text/plain", "dGVzdA==");
    await linkAttachmentToMessage(msg.id, stored.id, 0);
    const filePath = await getFilePathForAttachment(stored.id);

    // Remove the file to simulate ENOENT
    rmSync(filePath!);

    const content = await getAttachmentContent(stored.id);
    expect(content).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// isValidBase64
// ---------------------------------------------------------------------------

describePg("isValidBase64", () => {
  test("accepts valid base64 strings", async () => {
    expect(isValidBase64("aGVsbG8=")).toBe(true); // "hello"
    expect(isValidBase64("dGVzdA==")).toBe(true); // "test"
    expect(isValidBase64("AAAA")).toBe(true); // no padding
    expect(isValidBase64("")).toBe(true); // empty
  });

  test("accepts strings with non-standard length (lenient)", async () => {
    expect(isValidBase64("AAA")).toBe(true); // 3 chars, OK
    expect(isValidBase64("AAAAA")).toBe(true); // 5 chars, OK
  });

  test("rejects strings with invalid characters", async () => {
    expect(isValidBase64("!!!!")).toBe(false);
    expect(isValidBase64("abc@")).toBe(false);
    expect(isValidBase64("hello world")).toBe(false); // space
    expect(isValidBase64("data_here")).toBe(false); // underscore
  });
});

// ---------------------------------------------------------------------------
// deleteAttachment
// ---------------------------------------------------------------------------

describePg("deleteAttachment", () => {
  beforeEach(resetTables);

  test("deletes existing attachment and returns deleted", async () => {
    const stored = await uploadAttachment("file.txt", "text/plain", "dGVzdA==");
    const result = await deleteAttachment(stored.id);
    expect(result).toBe("deleted");

    const fetched = await getAttachmentById(stored.id);
    expect(fetched).toBeNull();
  });

  test("cleans up on-disk file when deleting", async () => {
    const conv = await createConversation();
    const msg = await addMessage(conv.id, "assistant", "cleanup");
    const stored = await uploadAttachment(
      "cleanup.txt",
      "text/plain",
      "dGVzdA==",
    );
    await linkAttachmentToMessage(msg.id, stored.id, 0);
    const filePath = await getFilePathForAttachment(stored.id);
    expect(existsSync(filePath!)).toBe(true);

    await rawRunAsync(
      "test:unlinkAttachment",
      "DELETE FROM message_attachments WHERE attachment_id = ?",
      stored.id,
    );

    await deleteAttachment(stored.id);
    expect(existsSync(filePath!)).toBe(false);
  });

  test("returns not_found for nonexistent attachment", async () => {
    const result = await deleteAttachment("nonexistent-id");
    expect(result).toBe("not_found");
  });

  test("returns still_referenced when messages reference the attachment", async () => {
    const conv = await createConversation();
    const msg1 = await addMessage(conv.id, "user", "First upload");
    const msg2 = await addMessage(conv.id, "user", "Duplicate upload");

    const first = await uploadAttachment(
      "photo.png",
      "image/png",
      "SHAREDCONTENT1",
    );
    await linkAttachmentToMessage(msg1.id, first.id, 0);
    await linkAttachmentToMessage(msg2.id, first.id, 0);

    // Delete should return still_referenced and NOT remove the attachment row
    const result = await deleteAttachment(first.id);
    expect(result).toBe("still_referenced");

    // Attachment row still exists because messages reference it
    const fetched = await getAttachmentById(first.id);
    expect(fetched).not.toBeNull();

    // Both messages still see the attachment
    const linked1 = await getAttachmentsForMessage(msg1.id);
    expect(linked1).toHaveLength(1);
    const linked2 = await getAttachmentsForMessage(msg2.id);
    expect(linked2).toHaveLength(1);
  });

  test("deletes attachment when no messages reference it", async () => {
    const stored = await uploadAttachment(
      "lonely.txt",
      "text/plain",
      "UNREFERENCED",
    );
    // No linkAttachmentToMessage call -- zero references
    const result = await deleteAttachment(stored.id);
    expect(result).toBe("deleted");

    const fetched = await getAttachmentById(stored.id);
    expect(fetched).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// getAttachmentsByIds
// ---------------------------------------------------------------------------

describePg("getAttachmentsByIds", () => {
  beforeEach(resetTables);

  test("returns matching attachments with hydrated dataBase64", async () => {
    const a = await uploadAttachment("a.txt", "text/plain", "AAAA");
    const b = await uploadAttachment("b.txt", "text/plain", "BBBB");

    const results = await getAttachmentsByIds([a.id, b.id], {
      hydrateFileData: true,
    });
    expect(results).toHaveLength(2);
    expect(results[0].dataBase64).toBe("AAAA");
    expect(results[1].dataBase64).toBe("BBBB");
  });

  test("returns empty array for empty IDs list", async () => {
    const results = await getAttachmentsByIds([]);
    expect(results).toHaveLength(0);
  });

  test("skips IDs that do not exist", async () => {
    const a = await uploadAttachment("a.txt", "text/plain", "AAAA");
    const results = await getAttachmentsByIds([a.id, "nonexistent"]);
    expect(results).toHaveLength(1);
  });
});

// ---------------------------------------------------------------------------
// getAttachmentById
// ---------------------------------------------------------------------------

describePg("getAttachmentById", () => {
  beforeEach(resetTables);

  test("returns attachment with hydrated dataBase64 when found", async () => {
    const stored = await uploadAttachment(
      "report.pdf",
      "application/pdf",
      "JVBER",
    );
    const result = await getAttachmentById(stored.id, {
      hydrateFileData: true,
    });

    expect(result).not.toBeNull();
    expect(result!.id).toBe(stored.id);
    expect(result!.originalFilename).toBe("report.pdf");
    expect(result!.dataBase64).toBe("JVBER");
  });

  test("returns null for nonexistent ID", async () => {
    const result = await getAttachmentById("no-such-id");
    expect(result).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// attachInlineAttachmentToMessage — filename collisions
// ---------------------------------------------------------------------------

describePg("createInlineAttachment (workspace_ref persistence)", () => {
  beforeEach(resetTables);

  test("creates an unlinked row whose bytes resolve back via a workspace_ref", async () => {
    const conv = await createConversation();
    const msg = await addMessage(conv.id, "user", "hi");

    // "aGVsbG8=" = "hello"
    const stored = await createInlineAttachment(
      conv.id,
      conv.createdAt,
      "note.txt",
      "text/plain",
      "aGVsbG8=",
    );

    // The row exists but is NOT yet linked to the message (the persist path
    // writes the link after addMessage, once the message id exists).
    expect(await getAttachmentsForMessage(msg.id)).toHaveLength(0);
    expect(readFileSync(stored.filePath).toString()).toBe("hello");

    // A workspace_ref pointing at the row resolves to the original bytes.
    const resolved = await mediaSourceBytes({
      type: "workspace_ref",
      media_type: "text/plain",
      attachmentId: stored.id,
      sizeBytes: stored.sizeBytes,
    });
    expect(resolved?.toString()).toBe("hello");

    // Linking writes the GC anchor so the row is retrievable by message.
    await linkAttachmentToMessage(msg.id, stored.id, 0);
    expect((await getAttachmentsForMessage(msg.id)).map((a) => a.id)).toEqual([
      stored.id,
    ]);
  });

  test("offloadOversizedText writes the original bytes next to the conversation", async () => {
    const conv = await createConversation();
    const original = "x".repeat(32);
    const result = await offloadOversizedText(
      original,
      {
        conversationId: conv.id,
        conversationCreatedAt: conv.createdAt,
      },
      16,
    );

    expect(result.attachmentId).toBeDefined();
    const filePath = await getFilePathForAttachment(result.attachmentId!);
    expect(filePath).toBeTruthy();
    expect(result.filename).toBeDefined();
    expect(filePath!.endsWith(result.filename!)).toBe(true);
    expect(
      result.filename!.startsWith(`${OVERSIZED_CONTENT_FILENAME_PREFIX}-`),
    ).toBe(true);
    expect(readFileSync(filePath!).toString("utf8")).toBe(original);
  });
});

describePg("attachInlineAttachmentToMessage filename collisions", () => {
  beforeEach(resetTables);

  test("returns the resolved -N path when a same-named file already exists", async () => {
    const conv = await createConversation();
    const msg1 = await addMessage(conv.id, "user", "first upload");
    const msg2 = await addMessage(conv.id, "user", "re-upload after editing");

    // "aGVsbG8=" = "hello", "d29ybGQ=" = "world"
    const first = await attachInlineAttachmentToMessage(
      msg1.id,
      0,
      "report.csv",
      "text/csv",
      "aGVsbG8=",
    );
    const second = await attachInlineAttachmentToMessage(
      msg2.id,
      0,
      "report.csv",
      "text/csv",
      "d29ybGQ=",
    );

    expect(first.filePath.endsWith("report.csv")).toBe(true);
    expect(second.filePath.endsWith("report-2.csv")).toBe(true);
    expect(readFileSync(first.filePath).toString()).toBe("hello");
    expect(readFileSync(second.filePath).toString()).toBe("world");
  });
});

// ---------------------------------------------------------------------------
// linkAttachmentToMessage + getAttachmentsForMessage
// ---------------------------------------------------------------------------

describePg("linkAttachmentToMessage + getAttachmentsForMessage", () => {
  beforeEach(resetTables);

  test("links attachment and retrieves it by message", async () => {
    const conv = await createConversation();
    const msg = await addMessage(conv.id, "assistant", "Here is a chart");
    const stored = await uploadAttachment("chart.png", "image/png", "iVBORw0K");

    await linkAttachmentToMessage(msg.id, stored.id, 0);

    const linked = await getAttachmentsForMessage(msg.id);
    expect(linked).toHaveLength(1);
    expect(linked[0].id).toBe(stored.id);
    expect(linked[0].originalFilename).toBe("chart.png");
    expect(linked[0].dataBase64).toBe("iVBORw0K");
    expect(await getFilePathForAttachment(stored.id)).toContain(
      "/conversations/",
    );
  });

  test("uses timestamp-first conversation directory and does not recreate a legacy sibling", async () => {
    const conv = await createConversation();
    const msg = await addMessage(conv.id, "assistant", "Disk view repaired");
    const canonicalDir = getConversationDirPath(conv.id, conv.createdAt);
    const legacyDir = getLegacyConversationDirPath(conv.id, conv.createdAt);
    rmSync(legacyDir, { recursive: true, force: true });

    const stored = await uploadAttachment(
      "repaired.png",
      "image/png",
      "iVBORw0K",
    );
    await linkAttachmentToMessage(msg.id, stored.id, 0);

    const filePath = await getFilePathForAttachment(stored.id);
    expect(filePath).not.toBeNull();
    expect(filePath!).toContain(join(canonicalDir, "attachments"));
    expect(existsSync(filePath!)).toBe(true);
    expect(existsSync(legacyDir)).toBe(false);
  });

  test("reuses an existing legacy conversation directory when timestamp-first is absent", async () => {
    const conv = await createConversation();
    const msg = await addMessage(conv.id, "assistant", "Legacy path");
    const canonicalDir = getConversationDirPath(conv.id, conv.createdAt);
    const legacyDir = getLegacyConversationDirPath(conv.id, conv.createdAt);

    rmSync(canonicalDir, { recursive: true, force: true });
    mkdirSync(legacyDir, { recursive: true });

    const stored = await uploadAttachment(
      "legacy.png",
      "image/png",
      "iVBORw0K",
    );
    await linkAttachmentToMessage(msg.id, stored.id, 0);

    const filePath = await getFilePathForAttachment(stored.id);
    expect(filePath).not.toBeNull();
    expect(filePath!).toContain(join(legacyDir, "attachments"));
    expect(existsSync(filePath!)).toBe(true);
    expect(existsSync(canonicalDir)).toBe(false);
  });

  test("returns attachments in position order", async () => {
    const conv = await createConversation();
    const msg = await addMessage(conv.id, "assistant", "Multiple files");
    const a = await uploadAttachment("first.txt", "text/plain", "AAAA");
    const b = await uploadAttachment("second.txt", "text/plain", "BBBB");

    // Link in reverse order
    await linkAttachmentToMessage(msg.id, b.id, 1);
    await linkAttachmentToMessage(msg.id, a.id, 0);

    const linked = await getAttachmentsForMessage(msg.id);
    expect(linked).toHaveLength(2);
    expect(linked[0].originalFilename).toBe("first.txt");
    expect(linked[1].originalFilename).toBe("second.txt");
  });

  test("reuses a repeated message attachment link with its original position", async () => {
    const conv = await createConversation();
    const msg = await addMessage(conv.id, "assistant", "One file");
    const stored = await uploadAttachment("frame.png", "image/png", "AAAA");

    expect(await linkAttachmentToMessage(msg.id, stored.id, 4)).toBe(stored.id);
    expect(await linkAttachmentToMessage(msg.id, stored.id, 0)).toBe(stored.id);

    const links = await rawGetAsync<{ count: number; position: number }>(
      "test:repeatedAttachmentLink",
      `SELECT COUNT(*) AS count, MIN(position) AS position
       FROM message_attachments
       WHERE message_id = ? AND attachment_id = ?`,
      msg.id,
      stored.id,
    );
    expect(links).toEqual({ count: 1, position: 4 });
  });

  test("returns empty for message with no attachments", async () => {
    const conv = await createConversation();
    const msg = await addMessage(conv.id, "assistant", "No attachments");

    const linked = await getAttachmentsForMessage(msg.id);
    expect(linked).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// deleteOrphanAttachments
// ---------------------------------------------------------------------------

describePg("deleteOrphanAttachments", () => {
  beforeEach(resetTables);

  test("removes candidate attachments with no message links", async () => {
    const stored = await uploadAttachment(
      "orphan.txt",
      "text/plain",
      "ZGF0YQ==",
    );

    const removed = await deleteOrphanAttachments([stored.id]);
    expect(removed).toBe(1);
  });

  test("cleans up on-disk files when removing orphaned materialized attachments", async () => {
    const conv = await createConversation();
    const msg = await addMessage(conv.id, "assistant", "Orphan me");
    const stored = await uploadAttachment(
      "orphan.txt",
      "text/plain",
      "ZGF0YQ==",
    );
    await linkAttachmentToMessage(msg.id, stored.id, 0);
    const filePath = await getFilePathForAttachment(stored.id);
    expect(existsSync(filePath!)).toBe(true);

    await rawRunAsync(
      "test:unlinkOrphanAttachment",
      "DELETE FROM message_attachments WHERE attachment_id = ?",
      stored.id,
    );

    await deleteOrphanAttachments([stored.id]);
    expect(existsSync(filePath!)).toBe(false);
  });

  test("preserves attachments that are still linked", async () => {
    const conv = await createConversation();
    const msg = await addMessage(conv.id, "assistant", "With attachment");
    const stored = await uploadAttachment(
      "linked.txt",
      "text/plain",
      "ZGF0YQ==",
    );
    await linkAttachmentToMessage(msg.id, stored.id, 0);

    const removed = await deleteOrphanAttachments([stored.id]);
    expect(removed).toBe(0);

    const fetched = await getAttachmentById(stored.id);
    expect(fetched).not.toBeNull();
  });

  test("removes only orphans when mixed candidates provided", async () => {
    const conv = await createConversation();
    const msg = await addMessage(conv.id, "assistant", "Mixed");
    const linked = await uploadAttachment("linked.txt", "text/plain", "AAAA");
    const orphan = await uploadAttachment("orphan.txt", "text/plain", "BBBB");
    await linkAttachmentToMessage(msg.id, linked.id, 0);

    const removed = await deleteOrphanAttachments([linked.id, orphan.id]);
    expect(removed).toBe(1);

    const remaining = await getAttachmentById(linked.id);
    expect(remaining).not.toBeNull();
  });

  test("returns 0 when no candidates provided", async () => {
    const removed = await deleteOrphanAttachments([]);
    expect(removed).toBe(0);
  });

  test("does not delete attachments outside the candidate set", async () => {
    const unrelated = await uploadAttachment(
      "unrelated.txt",
      "text/plain",
      "AAAA",
    );
    const candidate = await uploadAttachment(
      "candidate.txt",
      "text/plain",
      "BBBB",
    );

    const removed = await deleteOrphanAttachments([candidate.id]);
    expect(removed).toBe(1);

    // The unrelated attachment should still exist
    const fetched = await getAttachmentById(unrelated.id);
    expect(fetched).not.toBeNull();
  });
});

// ---------------------------------------------------------------------------
// resolveAttachmentsForPersist
// ---------------------------------------------------------------------------

describePg("resolveAttachmentsForPersist", () => {
  beforeEach(resetTables);

  // One implementation behind every send path that turns ids into a persisted
  // user message (HTTP send, processMessage, the voice bridge), so its shape is
  // pinned here rather than at each caller.
  test("hydrates ids into the shape a persisted message stores", async () => {
    const stored = await uploadAttachment("photo.png", "image/png", "ZnJhbWU=");

    expect(await resolveAttachmentsForPersist([stored.id])).toEqual([
      {
        id: stored.id,
        filename: "photo.png",
        mimeType: "image/png",
        data: "ZnJhbWU=",
      },
    ]);
  });

  test("carries the source path only for attachments that have one", async () => {
    const withPath = await uploadAttachment(
      "from-disk.txt",
      "text/plain",
      "AA==",
    );
    const plain = await uploadAttachment("typed.txt", "text/plain", "BB==");
    await rawRunAsync(
      "test:setSourcePath",
      "UPDATE attachments SET source_path = ? WHERE id = ?",
      "/tmp/from-disk.txt",
      withPath.id,
    );

    const resolved = await resolveAttachmentsForPersist([
      withPath.id,
      plain.id,
    ]);

    expect(resolved[0]).toMatchObject({ filePath: "/tmp/from-disk.txt" });
    expect(resolved[1]).not.toHaveProperty("filePath");
  });

  test("drops ids with no attachment row", async () => {
    const stored = await uploadAttachment("kept.txt", "text/plain", "AA==");

    const resolved = await resolveAttachmentsForPersist([
      stored.id,
      "att-missing",
    ]);

    expect(resolved.map((a) => a.id)).toEqual([stored.id]);
  });

  test("returns nothing for an empty id list", async () => {
    expect(await resolveAttachmentsForPersist([])).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// deleteMessageById orphan cleanup
// ---------------------------------------------------------------------------

describePg("deleteMessageById attachment cleanup", () => {
  beforeEach(resetTables);

  test("collects an attachment the deleted message alone referenced", async () => {
    const conv = await createConversation();
    const msg = await addMessage(conv.id, "user", "With attachment");
    const stored = await uploadAttachment("shot.txt", "text/plain", "ZGF0YQ==");
    await linkAttachmentToMessage(msg.id, stored.id, 0);
    const filePath = await getFilePathForAttachment(stored.id);

    await deleteMessageById(msg.id);

    expect(await getAttachmentById(stored.id)).toBeNull();
    expect(existsSync(filePath!)).toBe(false);
  });

  test("retained ids survive the delete, row and bytes", async () => {
    // A caller rolling a message back rather than deleting it: the attachment
    // returns to the uploaded-but-unlinked state every attachment sits in
    // between upload and send, so a later message can still reference it.
    const conv = await createConversation();
    const msg = await addMessage(conv.id, "user", "Rolled back");
    const stored = await uploadAttachment("shot.txt", "text/plain", "ZGF0YQ==");
    await linkAttachmentToMessage(msg.id, stored.id, 0);
    const filePath = await getFilePathForAttachment(stored.id);

    await deleteMessageById(msg.id, { retainAttachmentIds: [stored.id] });

    expect(await getAttachmentById(stored.id)).not.toBeNull();
    expect(existsSync(filePath!)).toBe(true);
    // The row is gone even though its attachment stayed.
    expect(await getAttachmentsForMessage(msg.id)).toHaveLength(0);
  });

  test("retaining one id does not spare the others on the row", async () => {
    const conv = await createConversation();
    const msg = await addMessage(conv.id, "user", "Two attachments");
    const kept = await uploadAttachment("kept.txt", "text/plain", "AAAA");
    const dropped = await uploadAttachment("dropped.txt", "text/plain", "BBBB");
    await linkAttachmentToMessage(msg.id, kept.id, 0);
    await linkAttachmentToMessage(msg.id, dropped.id, 1);

    await deleteMessageById(msg.id, { retainAttachmentIds: [kept.id] });

    expect(await getAttachmentById(kept.id)).not.toBeNull();
    expect(await getAttachmentById(dropped.id)).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// validateAttachmentUpload
// ---------------------------------------------------------------------------

describePg("validateAttachmentUpload", () => {
  test("accepts common image MIME types", async () => {
    expect(validateAttachmentUpload("photo.png", "image/png").ok).toBe(true);
    expect(validateAttachmentUpload("pic.jpg", "image/jpeg").ok).toBe(true);
    expect(validateAttachmentUpload("anim.gif", "image/gif").ok).toBe(true);
    expect(validateAttachmentUpload("sticker.webp", "image/webp").ok).toBe(
      true,
    );
  });

  test("accepts document MIME types", async () => {
    expect(validateAttachmentUpload("doc.pdf", "application/pdf").ok).toBe(
      true,
    );
    expect(validateAttachmentUpload("notes.txt", "text/plain").ok).toBe(true);
    expect(validateAttachmentUpload("data.csv", "text/csv").ok).toBe(true);
    expect(validateAttachmentUpload("config.json", "application/json").ok).toBe(
      true,
    );
  });

  test("accepts audio and video MIME types", async () => {
    expect(validateAttachmentUpload("voice.ogg", "audio/ogg").ok).toBe(true);
    expect(validateAttachmentUpload("song.mp3", "audio/mpeg").ok).toBe(true);
    expect(validateAttachmentUpload("clip.mp4", "video/mp4").ok).toBe(true);
  });

  test("accepts application/octet-stream fallback", async () => {
    expect(
      validateAttachmentUpload("data.bin", "application/octet-stream").ok,
    ).toBe(true);
  });

  test("rejects dangerous file extensions", async () => {
    const exeResult = validateAttachmentUpload(
      "malware.exe",
      "application/octet-stream",
    );
    expect(exeResult.ok).toBe(false);
    if (!exeResult.ok) {
      expect(exeResult.error).toContain(".exe");
    }

    const isoResult = validateAttachmentUpload(
      "disk.iso",
      "application/octet-stream",
    );
    expect(isoResult.ok).toBe(false);
    if (!isoResult.ok) {
      expect(isoResult.error).toContain(".iso");
    }
  });

  test("accepts shell scripts as text attachments", async () => {
    expect(validateAttachmentUpload("script.sh", "text/plain").ok).toBe(true);
    expect(validateAttachmentUpload("script.SH", "text/plain").ok).toBe(true);
    expect(validateAttachmentUpload("setup.sh", "application/x-sh").ok).toBe(
      true,
    );
    expect(
      validateAttachmentUpload("run.sh", "application/x-shellscript").ok,
    ).toBe(true);
    expect(validateAttachmentUpload("run.sh", "text/x-sh").ok).toBe(true);
    expect(validateAttachmentUpload("run.sh", "text/x-shellscript").ok).toBe(
      true,
    );
    expect(
      validateAttachmentUpload("run.sh", "application/octet-stream").ok,
    ).toBe(true);
  });

  test("rejects dangerous extensions regardless of claimed MIME type", async () => {
    // .exe disguised as image/png
    const result = validateAttachmentUpload("payload.exe", "image/png");
    expect(result.ok).toBe(false);
  });

  test("extension check is case-insensitive", async () => {
    expect(
      validateAttachmentUpload("PROGRAM.EXE", "application/octet-stream").ok,
    ).toBe(false);
    expect(
      validateAttachmentUpload("INSTALL.DMG", "application/octet-stream").ok,
    ).toBe(false);
  });

  test("rejects unsupported MIME types", async () => {
    const result = validateAttachmentUpload(
      "file.unknown",
      "application/x-msdownload",
    );
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error).toContain("Unsupported MIME type");
    }
  });

  test("handles filenames without extensions", async () => {
    // No extension -- only MIME check applies
    expect(validateAttachmentUpload("Makefile", "text/plain").ok).toBe(true);
    expect(validateAttachmentUpload("Makefile", "application/x-evil").ok).toBe(
      false,
    );
  });

  test("rejects all dangerous extension variants", async () => {
    for (const ext of [
      "bat",
      "cmd",
      "com",
      "msi",
      "dmg",
      "app",
      "scr",
      "pif",
      "vbs",
      "ps1",
      "jar",
    ]) {
      const result = validateAttachmentUpload(
        `file.${ext}`,
        "application/octet-stream",
      );
      expect(result.ok).toBe(false);
    }
  });

  test("trustedSource bypasses MIME allowlist", async () => {
    // video/x-matroska is not on the allowlist
    expect(validateAttachmentUpload("clip.mkv", "video/x-matroska").ok).toBe(
      false,
    );
    expect(
      validateAttachmentUpload("clip.mkv", "video/x-matroska", {
        trustedSource: true,
      }).ok,
    ).toBe(true);
  });

  test("trustedSource bypasses dangerous-extensions blocklist", async () => {
    expect(
      validateAttachmentUpload("installer.dmg", "application/octet-stream", {
        trustedSource: true,
      }).ok,
    ).toBe(true);
    expect(
      validateAttachmentUpload("payload.exe", "application/octet-stream", {
        trustedSource: true,
      }).ok,
    ).toBe(true);
  });

  test("trustedSource: false keeps strict validation", async () => {
    expect(
      validateAttachmentUpload("clip.mkv", "video/x-matroska", {
        trustedSource: false,
      }).ok,
    ).toBe(false);
    expect(
      validateAttachmentUpload("payload.exe", "application/octet-stream", {
        trustedSource: false,
      }).ok,
    ).toBe(false);
  });
});

setDefaultTimeout(30_000);
