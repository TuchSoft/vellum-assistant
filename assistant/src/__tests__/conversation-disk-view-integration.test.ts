/**
 * Integration tests for the ConversationDiskView lifecycle hooks.
 *
 * Verifies that creating, messaging, updating titles, deleting, and clearing
 * conversations correctly projects to the disk-view filesystem layout.
 */

import {
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  rmSync,
} from "node:fs";
import { join } from "node:path";
import { beforeEach, expect, setDefaultTimeout, test } from "bun:test";

const workspaceDir = process.env.VELLUM_WORKSPACE_DIR!;
const conversationsDir = join(workspaceDir, "conversations");
mkdirSync(conversationsDir, { recursive: true });

import {
  linkAttachmentToMessage,
  uploadAttachment,
} from "../persistence/attachments-store.js";
import {
  addMessage,
  clearAll,
  createConversation,
  deleteConversation,
  updateConversationTitle,
} from "../persistence/conversation-crud.js";
import {
  getConversationDirPath,
  syncMessageToDisk,
} from "../persistence/conversation-disk-view.js";
import { requireMainDb } from "../persistence/db-facade.js";
import { describePg } from "./pg-test-db.js";

async function resetTables(): Promise<void> {
  const db = requireMainDb();
  await db.run("DELETE FROM message_attachments");
  await db.run("DELETE FROM attachments");
  await db.run("DELETE FROM messages");
  await db.run("DELETE FROM conversations");
}

function resetConversationsDir() {
  rmSync(conversationsDir, { recursive: true, force: true });
  mkdirSync(conversationsDir, { recursive: true });
}

// ---------------------------------------------------------------------------
// Lifecycle integration: createConversation
// ---------------------------------------------------------------------------

describePg("createConversation → disk view", () => {
  beforeEach(async () => {
    await resetTables();
    resetConversationsDir();
  });

  test("creates directory and meta.json on createConversation", async () => {
    const conv = await createConversation("My Conversation");

    const dirPath = getConversationDirPath(conv.id, conv.createdAt);
    expect(existsSync(dirPath)).toBe(true);
    expect(readdirSync(conversationsDir)).toEqual([
      `${new Date(conv.createdAt).toISOString().replace(/:/g, "-")}_${conv.id}`,
    ]);

    const metaPath = join(dirPath, "meta.json");
    expect(existsSync(metaPath)).toBe(true);

    const meta = JSON.parse(readFileSync(metaPath, "utf-8"));
    expect(meta.id).toBe(conv.id);
    expect(meta.title).toBe("My Conversation");
    expect(meta.type).toBe("standard");
    expect(meta.createdAt).toBe(new Date(conv.createdAt).toISOString());
  });

  test("handles null title in createConversation", async () => {
    const conv = await createConversation();

    const dirPath = getConversationDirPath(conv.id, conv.createdAt);
    const meta = JSON.parse(readFileSync(join(dirPath, "meta.json"), "utf-8"));
    expect(meta.title).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// Lifecycle integration: addMessage + syncMessageToDisk
// ---------------------------------------------------------------------------

describePg("addMessage + syncMessageToDisk → disk view", () => {
  beforeEach(async () => {
    await resetTables();
    resetConversationsDir();
  });

  test("appends JSONL line for a text message", async () => {
    const conv = await createConversation("Msg Test");

    const msg = await addMessage(conv.id, "user", "Hello world", {
      skipIndexing: true,
    });

    syncMessageToDisk(conv.id, msg.id, conv.createdAt);

    const dirPath = getConversationDirPath(conv.id, conv.createdAt);
    const jsonlPath = join(dirPath, "messages.jsonl");
    expect(existsSync(jsonlPath)).toBe(true);

    const lines = readFileSync(jsonlPath, "utf-8").trim().split("\n");
    expect(lines).toHaveLength(1);

    const record = JSON.parse(lines[0]);
    expect(record.role).toBe("user");
    expect(record.content).toBe("Hello world");
    expect(record.ts).toBeDefined();
  });

  test("message with attachment copies file and includes in JSONL", async () => {
    const conv = await createConversation("Attach Test");

    const msg = await addMessage(conv.id, "user", "See attached", {
      skipIndexing: true,
    });

    const att = await uploadAttachment(
      "screenshot.png",
      "image/png",
      "iVBORw0K",
    );
    await linkAttachmentToMessage(msg.id, att.id, 0);

    syncMessageToDisk(conv.id, msg.id, conv.createdAt);

    const dirPath = getConversationDirPath(conv.id, conv.createdAt);

    // Attachment file exists in attachments/ subdirectory
    const attachDir = join(dirPath, "attachments");
    expect(existsSync(join(attachDir, "screenshot.png"))).toBe(true);

    // JSONL references the attachment
    const lines = readFileSync(join(dirPath, "messages.jsonl"), "utf-8")
      .trim()
      .split("\n");
    const record = JSON.parse(lines[0]);
    expect(record.attachments).toEqual(["screenshot.png"]);
  });
});

// ---------------------------------------------------------------------------
// Lifecycle integration: updateConversationTitle
// ---------------------------------------------------------------------------

describePg("updateConversationTitle → disk view", () => {
  beforeEach(async () => {
    await resetTables();
    resetConversationsDir();
  });

  test("rewrites meta.json with new title", async () => {
    const conv = await createConversation("Original Title");
    const dirPath = getConversationDirPath(conv.id, conv.createdAt);

    // Verify original
    let meta = JSON.parse(readFileSync(join(dirPath, "meta.json"), "utf-8"));
    expect(meta.title).toBe("Original Title");

    // Update
    await updateConversationTitle(conv.id, "New Title");

    // Verify updated
    meta = JSON.parse(readFileSync(join(dirPath, "meta.json"), "utf-8"));
    expect(meta.title).toBe("New Title");
  });
});

// ---------------------------------------------------------------------------
// Lifecycle integration: deleteConversation
// ---------------------------------------------------------------------------

describePg("deleteConversation → disk view", () => {
  beforeEach(async () => {
    await resetTables();
    resetConversationsDir();
  });

  test("removes conversation directory on delete", async () => {
    const conv = await createConversation("To Delete");
    const dirPath = getConversationDirPath(conv.id, conv.createdAt);
    expect(existsSync(dirPath)).toBe(true);

    await deleteConversation(conv.id);

    expect(existsSync(dirPath)).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Lifecycle integration: clearAll
// ---------------------------------------------------------------------------

describePg("clearAll → disk view", () => {
  beforeEach(async () => {
    await resetTables();
    resetConversationsDir();
  });

  test("empties the conversations directory", async () => {
    // Create two conversations
    await createConversation("Conv A");
    await createConversation("Conv B");

    // Verify directories exist
    const entries = readdirSync(conversationsDir);
    expect(entries.length).toBe(2);

    // Clear all
    await clearAll();

    // Conversations directory should exist but be empty
    expect(existsSync(conversationsDir)).toBe(true);
    const afterEntries = readdirSync(conversationsDir);
    expect(afterEntries.length).toBe(0);
  });
});

setDefaultTimeout(30_000);
