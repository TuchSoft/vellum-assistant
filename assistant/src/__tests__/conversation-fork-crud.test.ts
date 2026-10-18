import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { beforeEach, expect, setDefaultTimeout, test } from "bun:test";

import { eq } from "drizzle-orm";

import {
  getAttachmentContent,
  getAttachmentsForMessage,
  linkAttachmentToMessage,
  uploadAttachment,
} from "../persistence/attachments-store.js";
import { appendCompactionEvent } from "../persistence/compaction-ledger-store.js";
import {
  getAttentionStateByConversationIds,
  markConversationUnread,
} from "../persistence/conversation-attention-store.js";
import {
  addMessage,
  createConversation,
  deleteConversation,
  forkConversation,
  getMessages,
  listConversationAttachments,
  updateMessageMetadata,
} from "../persistence/conversation-crud.js";
import { getConversationDirPath } from "../persistence/conversation-disk-view.js";
import {
  COMPUTER_USE_SCREENSHOT_ATTACHMENT_IDS_KEY,
  computerUseScreenshotAttachmentIdsFromMetadata,
} from "../persistence/conversation-types.js";
import { requireMainDb } from "../persistence/db-facade.js";
import { getRequestLogsByMessageId } from "../persistence/llm-request-log-store.js";
import { stringifyMessageContent } from "../persistence/message-content.js";
import {
  channelInboundEvents,
  conversationAssistantAttentionState,
  conversationCompactionEvents,
  conversations,
  externalConversationBindings,
  toolInvocations,
} from "../persistence/pg-schema/index.js";
import { rawGetAsync, rawRunAsync } from "../persistence/raw-query.js";
import {
  loadGraphMemoryState,
  saveGraphMemoryState,
} from "../plugins/defaults/memory/graph/graph-memory-state-store.js";
import {
  bumpRetrospectiveLastRunAt,
  getRetrospectiveState,
  upsertRetrospectiveState,
} from "../plugins/defaults/memory/memory-retrospective-state.js";
import { hydrate as hydrateActivationState } from "../plugins/defaults/memory/v2/activation-store.js";
import {
  getInjected as getV3Injected,
  markPruned as markV3Pruned,
  MEMORY_V3_INJECTED_BLOCK_FORMAT,
  MEMORY_V3_INJECTED_BLOCK_FORMAT_METADATA_KEY,
  MEMORY_V3_INJECTED_BLOCK_METADATA_KEY,
  recordInjected as recordV3Injected,
} from "../plugins/defaults/memory/v3/ever-injected-store.js";
import { ensureMemoryV3InjectedSectionsSchema } from "../plugins/defaults/memory/v3/plugin-schema.js";
import { handleListMessages } from "../runtime/routes/conversation-routes.js";
import { describePg } from "./pg-test-db.js";

async function resetTables(): Promise<void> {
  const db = requireMainDb();
  await db.orm.delete(channelInboundEvents);
  await db.orm.delete(externalConversationBindings);
  await db.orm.delete(conversationAssistantAttentionState);
  await db.run("DELETE FROM activation_state");
  await db.orm.delete(conversationCompactionEvents);
  await db.run("DELETE FROM conversation_graph_memory_state");
  await db.run("DELETE FROM memory_retrospective_state");
  await db.run("DELETE FROM llm_request_logs");
  await db.orm.delete(toolInvocations);
  await db.run("DELETE FROM memory_jobs");
  // The plugin creates this table itself (init hook, or a store's first use);
  // the reset runs before either, so stand it up here.
  await ensureMemoryV3InjectedSectionsSchema(db);
  await db.run("DELETE FROM memory_v3_injected_sections");
  await db.run("DELETE FROM message_attachments");
  await db.run("DELETE FROM attachments");
  await db.run("DELETE FROM messages");
  await db.run("DELETE FROM conversations");
}

async function insertActivationState(row: {
  conversationId: string;
  messageId: string;
  state: Record<string, number>;
  everInjected: Array<{ slug: string; turn: number }>;
  currentTurn: number;
}): Promise<void> {
  await requireMainDb().run(
    "INSERT INTO activation_state (conversation_id, message_id, state_json, ever_injected_json, current_turn, updated_at) VALUES (?, ?, ?, ?, ?, ?)",
    [
      row.conversationId,
      row.messageId,
      JSON.stringify(row.state),
      JSON.stringify(row.everInjected),
      row.currentTurn,
      1_700_000_000_000,
    ],
  );
}

function parseMetadata(metadata: string | null): unknown {
  return metadata == null ? null : JSON.parse(metadata);
}

describePg("forkConversation", () => {
  beforeEach(async () => {
    await resetTables();
  });

  test("forks a full transcript with copied history and lineage", async () => {
    const source = await createConversation("Planning thread");
    await addMessage(source.id, "user", "Can you draft a launch plan?", {
      metadata: { branch: 1, source: "user" },
      skipIndexing: true,
    });
    await addMessage(
      source.id,
      "assistant",
      "Absolutely. Here is a first pass.",
      { metadata: { automated: true }, skipIndexing: true },
    );
    const finalSourceMessage = await addMessage(
      source.id,
      "user",
      "Fork from here",
      { metadata: { nested: { keep: true } }, skipIndexing: true },
    );

    const sourceMessages = await getMessages(source.id);
    const fork = await forkConversation({ conversationId: source.id });
    const forkMessages = await getMessages(fork.id);

    expect(fork.id).not.toBe(source.id);
    expect(fork.title).toBe("Planning thread (Fork)");
    expect(fork.forkParentConversationId).toBe(source.id);
    expect(fork.forkParentMessageId).toBe(finalSourceMessage.id);
    expect(forkMessages).toHaveLength(sourceMessages.length);
    expect(forkMessages.map((message) => message.role)).toEqual(
      sourceMessages.map((message) => message.role),
    );
    expect(forkMessages.map((message) => message.content)).toEqual(
      sourceMessages.map((message) => message.content),
    );
    expect(forkMessages.map((message) => message.createdAt)).toEqual(
      sourceMessages.map((message) => message.createdAt),
    );
    expect(
      forkMessages.map((message) => parseMetadata(message.metadata)),
    ).toEqual(
      sourceMessages.map((message) => {
        const metadata = parseMetadata(message.metadata);
        return metadata && typeof metadata === "object"
          ? {
              ...(metadata as Record<string, unknown>),
              forkSourceMessageId: message.id,
            }
          : { forkSourceMessageId: message.id };
      }),
    );
    expect(
      forkMessages.every(
        (message, index) => message.id !== sourceMessages[index]?.id,
      ),
    ).toBe(true);
  });

  test("preserves source order when source messages share a timestamp", async () => {
    const source = await createConversation("Equal timestamp thread");
    const db = requireMainDb();
    const createdAt = Date.now();

    await db.run(
      `INSERT INTO messages (id, conversation_id, role, content, created_at) VALUES ('z-source-message', '${source.id}', 'user', 'first', ${createdAt})`,
    );
    await db.run(
      `INSERT INTO messages (id, conversation_id, role, content, created_at) VALUES ('a-source-message', '${source.id}', 'assistant', 'second', ${createdAt})`,
    );

    const sourceMessages = await getMessages(source.id);
    const fork = await forkConversation({ conversationId: source.id });
    const forkMessages = await getMessages(fork.id);

    expect(
      sourceMessages.map((message) => stringifyMessageContent(message.content)),
    ).toEqual(["first", "second"]);
    expect(forkMessages.map((message) => message.content)).toEqual(
      sourceMessages.map((message) => message.content),
    );
    expect(forkMessages.map((message) => message.role)).toEqual(
      sourceMessages.map((message) => message.role),
    );
  });

  test("forks only through the requested branch point", async () => {
    const source = await createConversation("Branchable thread");
    await addMessage(source.id, "user", "Message 1", {
      skipIndexing: true,
    });
    const branchPoint = await addMessage(source.id, "assistant", "Message 2", {
      skipIndexing: true,
    });
    await addMessage(source.id, "user", "Message 3", {
      skipIndexing: true,
    });
    await addMessage(source.id, "assistant", "Message 4", {
      skipIndexing: true,
    });

    const fork = await forkConversation({
      conversationId: source.id,
      throughMessageId: branchPoint.id,
    });

    expect(fork.forkParentConversationId).toBe(source.id);
    expect(fork.forkParentMessageId).toBe(branchPoint.id);
    expect(
      (await getMessages(fork.id)).map((message) =>
        stringifyMessageContent(message.content),
      ),
    ).toEqual(["Message 1", "Message 2"]);
  });

  test("pinned fork through a (createdAt, id) cutoff matches the cursor slice for same-timestamp rows", async () => {
    // Regression for the memory-retrospective cutoff/fork divergence: the job
    // picks its cutoff from `getMessagesAfter`, which orders by `(createdAt,
    // id)`. `forkConversation` must slice on the same order so same-millisecond
    // siblings aren't skipped forever or reprocessed. Insert rows whose
    // insertion order is the reverse of their `(createdAt, id)` order to expose
    // the divergence: a `createdAt`-only slice would pick the wrong prefix.
    const source = await createConversation("Same-timestamp cutoff thread");
    const db = requireMainDb();
    const createdAt = Date.now();
    // Insert d, c, b, a so SQLite's createdAt-only tie order (≈ rowid /
    // insertion order) is the opposite of the (createdAt, id) cursor order
    // (a, b, c, d). All are plain user rows so no display-turn extension fires.
    for (const id of ["msg-d", "msg-c", "msg-b", "msg-a"]) {
      await db.run(
        `INSERT INTO messages (id, conversation_id, role, content, created_at) VALUES ('${id}', '${source.id}', 'user', '${id}', ${createdAt})`,
      );
    }

    // Cutoff = "msg-c": the cursor treats {msg-a, msg-b, msg-c} as processed
    // and {msg-d} as still-after-the-cutoff. The fork must contain exactly the
    // first three in `(createdAt, id)` order.
    const fork = await forkConversation({
      conversationId: source.id,
      throughMessageId: "msg-c",
    });

    expect(
      (await getMessages(fork.id)).map((message) =>
        stringifyMessageContent(message.content),
      ),
    ).toEqual(["msg-a", "msg-b", "msg-c"]);
  });

  test("advances fork boundary through consecutive assistant rows after the requested message", async () => {
    // When the read-path merges consecutive assistant DB rows into a single
    // display row, the client only addresses the anchor id. Forking through
    // the anchor must still include the merged tail rows that follow.
    const source = await createConversation("Multi-row turn thread");
    await addMessage(source.id, "user", "Message 1", {
      skipIndexing: true,
    });
    const anchor = await addMessage(
      source.id,
      "assistant",
      "Assistant text segment",
      { skipIndexing: true },
    );
    const toolRow = await addMessage(source.id, "assistant", "Tool turn row", {
      skipIndexing: true,
    });
    const tailRow = await addMessage(
      source.id,
      "assistant",
      "Final assistant segment",
      { skipIndexing: true },
    );
    await addMessage(source.id, "user", "Next user turn", {
      skipIndexing: true,
    });

    const fork = await forkConversation({
      conversationId: source.id,
      throughMessageId: anchor.id,
    });

    // Boundary advances past the entire consecutive-assistant cluster, so the
    // full turn is preserved in the fork — not just the anchor row.
    expect(
      (await getMessages(fork.id)).map((message) =>
        stringifyMessageContent(message.content),
      ),
    ).toEqual([
      "Message 1",
      "Assistant text segment",
      "Tool turn row",
      "Final assistant segment",
    ]);
    expect(fork.forkParentMessageId).toBe(tailRow.id);
    expect(toolRow.id).not.toBe(anchor.id);
  });

  test("advances fork boundary across tool-result-only user rows between assistant rows", async () => {
    // Read-path collapse folds tool-result-only user rows into the
    // surrounding assistant turn (`mergeToolResultsIntoAssistantMessages`
    // suppresses them). The client only sees a single display turn anchored
    // at the first assistant row, so forking through the anchor must include
    // both halves of the assistant turn plus the suppressed user row in
    // between — otherwise the fork loses tool_use ↔ tool_result pairing
    // and produces an invalid LLM history.
    const source = await createConversation("Tool-result gap thread");
    await addMessage(source.id, "user", "Find the latest sales numbers", {
      skipIndexing: true,
    });
    const anchor = await addMessage(
      source.id,
      "assistant",
      JSON.stringify([
        { type: "text", text: "Looking up the data." },
        { type: "tool_use", id: "tool_1", name: "lookup", input: {} },
      ]),
      { skipIndexing: true },
    );
    const toolResultUserRow = await addMessage(
      source.id,
      "user",
      JSON.stringify([
        { type: "tool_result", tool_use_id: "tool_1", content: "data" },
      ]),
      { skipIndexing: true },
    );
    const tailAssistantRow = await addMessage(
      source.id,
      "assistant",
      "Here are the numbers.",
      { skipIndexing: true },
    );
    await addMessage(source.id, "user", "Thanks", {
      skipIndexing: true,
    });

    const fork = await forkConversation({
      conversationId: source.id,
      throughMessageId: anchor.id,
    });

    // All three DB rows of the assistant display turn — including the
    // suppressed tool-result user row in the middle — land in the fork.
    const forkedContent = (await getMessages(fork.id)).map((m) =>
      JSON.stringify(m.content),
    );
    expect(forkedContent).toHaveLength(4);
    expect(forkedContent[0]).toContain("Find the latest sales numbers");
    expect(forkedContent[1]).toContain("tool_use");
    expect(forkedContent[2]).toContain("tool_result");
    expect(forkedContent[3]).toContain("Here are the numbers.");
    expect(fork.forkParentMessageId).toBe(tailAssistantRow.id);
    expect(toolResultUserRow.id).not.toBe(anchor.id);
  });

  test("inherits the most recent compaction at-or-before the forked-from message", async () => {
    const source = await createConversation("Compacted thread");
    const m1 = await addMessage(source.id, "user", "Message 1", {
      skipIndexing: true,
    });
    const m2 = await addMessage(source.id, "assistant", "Message 2", {
      skipIndexing: true,
    });
    const branchPoint = await addMessage(source.id, "user", "Message 3", {
      skipIndexing: true,
    });
    const m4 = await addMessage(source.id, "assistant", "Message 4", {
      skipIndexing: true,
    });

    // Pin timestamps so the compaction event sits strictly between M2 and M3:
    // it covers M1+M2 and ran before M3 was sent.
    const db = requireMainDb();
    const base = Date.now();
    await db.run(
      `UPDATE messages SET created_at = ${base} WHERE id = '${m1.id}'`,
    );
    await db.run(
      `UPDATE messages SET created_at = ${base + 1} WHERE id = '${m2.id}'`,
    );
    await db.run(
      `UPDATE messages SET created_at = ${base + 3} WHERE id = '${branchPoint.id}'`,
    );
    await db.run(
      `UPDATE messages SET created_at = ${base + 4} WHERE id = '${m4.id}'`,
    );
    const compactedAt = base + 2;
    await db.orm
      .update(conversations)
      .set({
        contextSummary: "Compacted summary",
        contextCompactedMessageCount: 2,
        contextCompactedAt: compactedAt,
      })
      .where(eq(conversations.id, source.id));
    await appendCompactionEvent(source.id, {
      compactedAt,
      summary: "Compacted summary",
      compactedMessageCount: 2,
    });

    // M3 was sent after the compaction, so forking through it reproduces the
    // compacted working context.
    const fork = await forkConversation({
      conversationId: source.id,
      throughMessageId: branchPoint.id,
    });

    expect(fork.contextSummary).toBe("Compacted summary");
    expect(fork.contextCompactedMessageCount).toBe(2);
    expect(fork.contextCompactedAt).toBe(compactedAt);
    expect(fork.forkParentConversationId).toBe(source.id);
    expect(fork.forkParentMessageId).toBe(branchPoint.id);
  });

  test("does not inherit a compaction that ran after the forked-from message", async () => {
    const source = await createConversation("Compacted thread");
    const m1 = await addMessage(source.id, "user", "Message 1", {
      skipIndexing: true,
    });
    const m2 = await addMessage(source.id, "assistant", "Message 2", {
      skipIndexing: true,
    });
    const m3 = await addMessage(source.id, "user", "Message 3", {
      skipIndexing: true,
    });
    const m4 = await addMessage(source.id, "assistant", "Message 4", {
      skipIndexing: true,
    });

    // `/compact` ran after M4 — the compaction postdates every message.
    const db = requireMainDb();
    const base = Date.now();
    await db.run(
      `UPDATE messages SET created_at = ${base} WHERE id = '${m1.id}'`,
    );
    await db.run(
      `UPDATE messages SET created_at = ${base + 1} WHERE id = '${m2.id}'`,
    );
    await db.run(
      `UPDATE messages SET created_at = ${base + 2} WHERE id = '${m3.id}'`,
    );
    await db.run(
      `UPDATE messages SET created_at = ${base + 3} WHERE id = '${m4.id}'`,
    );
    const compactedAt = base + 10;
    await db.orm
      .update(conversations)
      .set({
        contextSummary: "Compacted summary",
        contextCompactedMessageCount: 2,
        contextCompactedAt: compactedAt,
      })
      .where(eq(conversations.id, source.id));
    await appendCompactionEvent(source.id, {
      compactedAt,
      summary: "Compacted summary",
      compactedMessageCount: 2,
    });

    // Forking through the final message yields the full uncompacted history:
    // the compaction did not exist when M4 was the latest turn.
    const fork = await forkConversation({
      conversationId: source.id,
      throughMessageId: m4.id,
    });

    expect(fork.contextSummary).toBeNull();
    expect(fork.contextCompactedMessageCount).toBe(0);
    expect(fork.contextCompactedAt).toBeNull();
    expect(
      (await getMessages(fork.id)).map((message) =>
        stringifyMessageContent(message.content),
      ),
    ).toEqual(["Message 1", "Message 2", "Message 3", "Message 4"]);
  });

  test("forks from the compacted-away prefix without inheriting source compaction state", async () => {
    const source = await createConversation("Compacted thread");
    const compactedBranchPoint = await addMessage(
      source.id,
      "user",
      "Message 1",
      { skipIndexing: true },
    );
    const m2 = await addMessage(source.id, "assistant", "Message 2", {
      skipIndexing: true,
    });
    const m3 = await addMessage(source.id, "user", "Message 3", {
      skipIndexing: true,
    });

    // Pin timestamps so the compaction event sits strictly after every
    // message — same-millisecond inserts would otherwise make the event
    // "at-or-before" the branch point and inherit.
    const db = requireMainDb();
    const base = Date.now() - 10_000;
    await db.run(
      `UPDATE messages SET created_at = ${base} WHERE id = '${compactedBranchPoint.id}'`,
    );
    await db.run(
      `UPDATE messages SET created_at = ${base + 1} WHERE id = '${m2.id}'`,
    );
    await db.run(
      `UPDATE messages SET created_at = ${base + 2} WHERE id = '${m3.id}'`,
    );
    const compactedAt = base + 3;
    await db.orm
      .update(conversations)
      .set({
        contextSummary: "Compacted summary",
        contextCompactedMessageCount: 2,
        contextCompactedAt: compactedAt,
      })
      .where(eq(conversations.id, source.id));
    await appendCompactionEvent(source.id, {
      compactedAt,
      summary: "Compacted summary",
      compactedMessageCount: 2,
    });

    const fork = await forkConversation({
      conversationId: source.id,
      throughMessageId: compactedBranchPoint.id,
    });

    expect(fork.contextSummary).toBeNull();
    expect(fork.contextCompactedMessageCount).toBe(0);
    expect(fork.contextCompactedAt).toBeNull();
    expect(fork.forkParentConversationId).toBe(source.id);
    expect(fork.forkParentMessageId).toBe(compactedBranchPoint.id);
    expect(
      (await getMessages(fork.id)).map((message) =>
        stringifyMessageContent(message.content),
      ),
    ).toEqual(["Message 1"]);
  });

  test("inherits historyStrippedAt when forking past the clean event", async () => {
    const source = await createConversation("Clean thread");
    await addMessage(source.id, "user", "Message 1", {
      skipIndexing: true,
    });
    const preClean = await addMessage(source.id, "assistant", "Message 2", {
      skipIndexing: true,
    });

    const historyStrippedAt = preClean.createdAt + 1;
    await requireMainDb()
      .orm.update(conversations)
      .set({ historyStrippedAt })
      .where(eq(conversations.id, source.id));

    const postClean = await addMessage(source.id, "user", "Message 3", {
      skipIndexing: true,
    });
    expect(postClean.createdAt).toBeGreaterThanOrEqual(historyStrippedAt);

    const fork = await forkConversation({
      conversationId: source.id,
      throughMessageId: postClean.id,
    });

    expect(fork.historyStrippedAt).toBe(historyStrippedAt);
  });

  test("does not inherit historyStrippedAt when forking before the clean event", async () => {
    const source = await createConversation("Clean thread");
    await addMessage(source.id, "user", "Message 1", {
      skipIndexing: true,
    });
    const preClean = await addMessage(source.id, "assistant", "Message 2", {
      skipIndexing: true,
    });

    const historyStrippedAt = preClean.createdAt + 1;
    await requireMainDb()
      .orm.update(conversations)
      .set({ historyStrippedAt })
      .where(eq(conversations.id, source.id));

    await addMessage(source.id, "user", "Message 3", {
      skipIndexing: true,
    });

    const fork = await forkConversation({
      conversationId: source.id,
      throughMessageId: preClean.id,
    });

    expect(fork.historyStrippedAt).toBeNull();
  });

  test("inherits historyStrippedAt on a full-history fork", async () => {
    const source = await createConversation("Clean thread");
    await addMessage(source.id, "user", "Message 1", {
      skipIndexing: true,
    });
    const last = await addMessage(source.id, "assistant", "Message 2", {
      skipIndexing: true,
    });

    const historyStrippedAt = last.createdAt - 1;
    await requireMainDb()
      .orm.update(conversations)
      .set({ historyStrippedAt })
      .where(eq(conversations.id, source.id));

    const fork = await forkConversation({ conversationId: source.id });

    expect(fork.historyStrippedAt).toBe(historyStrippedAt);
  });

  test("leaves historyStrippedAt null when the source has no clean event", async () => {
    const source = await createConversation("Unclean thread");
    await addMessage(source.id, "user", "Message 1", {
      skipIndexing: true,
    });
    await addMessage(source.id, "assistant", "Message 2", {
      skipIndexing: true,
    });

    const fork = await forkConversation({ conversationId: source.id });

    expect(fork.historyStrippedAt).toBeNull();
  });

  test("fork from a pre-compaction message preserves historical injection metadata", async () => {
    const source = await createConversation("Compacted thread");
    const m1 = await addMessage(source.id, "user", "Historical question", {
      metadata: {
        pkbContextBlock: "<knowledge_base>\nstale\n</knowledge_base>",
        nowScratchpadBlock:
          "<NOW.md Always keep this up to date>\nstale\n</NOW.md>",
      },
      skipIndexing: true,
    });
    const reply1 = await addMessage(source.id, "assistant", "Reply 1", {
      skipIndexing: true,
    });
    const tail = await addMessage(source.id, "user", "Tail turn", {
      skipIndexing: true,
    });
    // Pin strictly-increasing timestamps so the pinned fork boundary is
    // unambiguous. `addMessage` stamps `Date.now()`, and these three rows can
    // land in the same millisecond; under the `(createdAt, id)` tie-break the
    // pinned fork uses, that would let `m1`'s slice reorder relative to its
    // siblings. Distinct timestamps keep this test focused on its intent —
    // pre-compaction metadata + compaction-state inheritance.
    const db = requireMainDb();
    const base = Date.now();
    await db.run(
      `UPDATE messages SET created_at = ${base} WHERE id = '${m1.id}'`,
    );
    await db.run(
      `UPDATE messages SET created_at = ${base + 1} WHERE id = '${reply1.id}'`,
    );
    await db.run(
      `UPDATE messages SET created_at = ${base + 2} WHERE id = '${tail.id}'`,
    );
    const compactedAt = base + 3;
    await requireMainDb()
      .orm.update(conversations)
      .set({
        contextSummary: "summary",
        contextCompactedMessageCount: 2,
        contextCompactedAt: compactedAt,
        historyStrippedAt: compactedAt,
      })
      .where(eq(conversations.id, source.id));

    const fork = await forkConversation({
      conversationId: source.id,
      throughMessageId: m1.id,
    });

    expect(fork.historyStrippedAt).toBeNull();
    expect(fork.contextSummary).toBeNull();
    expect(fork.contextCompactedMessageCount).toBe(0);

    const forkedMessages = await getMessages(fork.id);
    expect(forkedMessages).toHaveLength(1);
    const meta = parseMetadata(forkedMessages[0].metadata) as Record<
      string,
      unknown
    >;
    expect(meta.pkbContextBlock).toBe(
      "<knowledge_base>\nstale\n</knowledge_base>",
    );
    expect(meta.nowScratchpadBlock).toBe(
      "<NOW.md Always keep this up to date>\nstale\n</NOW.md>",
    );
  });

  test("rejects forks when the source conversation has no persisted messages", async () => {
    const source = await createConversation("Empty thread");

    await expect(
      forkConversation({ conversationId: source.id }),
    ).rejects.toThrow(
      `Conversation ${source.id} has no persisted messages to fork`,
    );
  });

  test("relinks copied attachments into the fork and syncs disk view", async () => {
    const source = await createConversation("Attachment thread");
    await addMessage(source.id, "user", "Please review this image", {
      skipIndexing: true,
    });
    const sourceAssistant = await addMessage(
      source.id,
      "assistant",
      "Attached the updated mock.",
      { skipIndexing: true },
    );
    const uploaded = await uploadAttachment(
      "wireframe.png",
      "image/png",
      "iVBORw0K",
    );
    await linkAttachmentToMessage(sourceAssistant.id, uploaded.id, 0);

    const sourceAttachments = await getAttachmentsForMessage(
      sourceAssistant.id,
    );
    const fork = await forkConversation({ conversationId: source.id });
    const forkAssistant = (await getMessages(fork.id)).find(
      (message) => message.role === "assistant",
    );
    const forkJsonl = readFileSync(
      join(getConversationDirPath(fork.id, fork.createdAt), "messages.jsonl"),
      "utf-8",
    )
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line) as Record<string, unknown>);

    expect(forkAssistant).toBeDefined();
    const forkAttachments = await getAttachmentsForMessage(forkAssistant!.id);
    expect(sourceAttachments).toHaveLength(1);
    expect(forkAttachments).toHaveLength(1);
    expect(forkAttachments[0]?.id).not.toBe(sourceAttachments[0]?.id);
    expect(
      existsSync(
        join(
          getConversationDirPath(fork.id, fork.createdAt),
          "attachments",
          "wireframe.png",
        ),
      ),
    ).toBe(true);
    expect(forkJsonl[1]?.attachments).toEqual(["wireframe.png"]);
    expect((await getAttachmentsForMessage(sourceAssistant.id))[0]?.id).toBe(
      sourceAttachments[0]?.id,
    );
  });

  test("remaps automatic screenshot refs and widens fork provenance", async () => {
    const screenshotBase64 =
      "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8/5+hHgAHggJ/PchI7wAAAABJRU5ErkJggg==";
    const source = await createConversation("Computer use thread");
    await addMessage(source.id, "user", "Open the example", {
      skipIndexing: true,
    });
    await addMessage(
      source.id,
      "assistant",
      JSON.stringify([
        {
          type: "tool_use",
          id: "computer-use-call",
          name: "computer_use_click",
          input: { x: 10, y: 20 },
        },
      ]),
      { skipIndexing: true },
    );
    const screenshot = await uploadAttachment(
      "computer-use-click.png",
      "image/png",
      screenshotBase64,
    );
    const toolResult = await addMessage(
      source.id,
      "user",
      JSON.stringify([
        {
          type: "tool_result",
          tool_use_id: "computer-use-call",
          content: "Clicked",
          contentBlocks: [
            {
              type: "image",
              source: {
                type: "workspace_ref",
                media_type: "image/png",
                attachmentId: screenshot.id,
                sizeBytes: Buffer.from(screenshotBase64, "base64").byteLength,
              },
            },
          ],
        },
      ]),
      { skipIndexing: true },
    );
    await linkAttachmentToMessage(toolResult.id, screenshot.id, 0);

    const reply = await addMessage(
      source.id,
      "assistant",
      JSON.stringify([{ type: "text", text: "Done." }]),
      { skipIndexing: true },
    );
    await linkAttachmentToMessage(reply.id, screenshot.id, 0);
    const explicit = await uploadAttachment(
      "report.pdf",
      "application/pdf",
      "JVBERg==",
    );
    await linkAttachmentToMessage(reply.id, explicit.id, 1);
    await updateMessageMetadata(reply.id, {
      [COMPUTER_USE_SCREENSHOT_ATTACHMENT_IDS_KEY]: [screenshot.id],
    });

    const fork = await forkConversation({ conversationId: source.id });
    const forkRows = await getMessages(fork.id);
    const forkToolResult = forkRows.find(
      (row) =>
        row.role === "user" &&
        JSON.stringify(row.content).includes("tool_result"),
    );
    const forkReply = forkRows.find(
      (row) =>
        row.role === "assistant" &&
        JSON.stringify(row.content).includes("Done."),
    );
    expect(forkToolResult).toBeDefined();
    expect(forkReply).toBeDefined();

    const forkReplyAttachments = await getAttachmentsForMessage(forkReply!.id);
    const clonedScreenshot = forkReplyAttachments.find(
      (attachment) => attachment.originalFilename === "computer-use-click.png",
    );
    const clonedExplicit = forkReplyAttachments.find(
      (attachment) => attachment.originalFilename === "report.pdf",
    );
    expect(clonedScreenshot?.id).toBeDefined();
    expect(clonedScreenshot?.id).not.toBe(screenshot.id);
    expect(clonedExplicit?.id).toBeDefined();
    expect(JSON.stringify(forkToolResult!.content)).toContain(
      `"attachmentId":"${clonedScreenshot!.id}"`,
    );
    expect(JSON.stringify(forkToolResult!.content)).not.toContain(
      `"attachmentId":"${screenshot.id}"`,
    );
    const persistedSourceToolResult = (await getMessages(source.id)).find(
      (row) => row.id === toolResult.id,
    );
    expect(JSON.stringify(persistedSourceToolResult?.content)).toContain(
      `"attachmentId":"${screenshot.id}"`,
    );
    expect(JSON.stringify(persistedSourceToolResult?.content)).not.toContain(
      `"attachmentId":"${clonedScreenshot!.id}"`,
    );
    expect(
      (await getAttachmentsForMessage(forkToolResult!.id)).map(
        (attachment) => attachment.id,
      ),
    ).toEqual([clonedScreenshot!.id]);

    await deleteConversation(source.id);

    const forkJsonl = readFileSync(
      join(getConversationDirPath(fork.id, fork.createdAt), "messages.jsonl"),
      "utf-8",
    );
    expect(forkJsonl).toContain(
      '"toolResults":[{"content":"Clicked"}],"attachments":["computer-use-click.png"]',
    );

    const forkMarkerIds = computerUseScreenshotAttachmentIdsFromMetadata(
      parseMetadata(forkReply!.metadata) as Record<string, unknown>,
    );
    expect(forkMarkerIds).toEqual([screenshot.id, clonedScreenshot!.id]);
    expect(forkMarkerIds).not.toContain(clonedExplicit!.id);

    const history = (await handleListMessages({
      queryParams: { conversationId: fork.id },
    })) as {
      messages: Array<{
        toolCalls?: Array<{ imageAttachmentIds?: string[] }>;
        attachments: Array<{
          id: string;
          computerUseScreenshot?: boolean;
        }>;
      }>;
    };
    expect(
      history.messages.flatMap((message) =>
        (message.toolCalls ?? []).flatMap(
          (toolCall) => toolCall.imageAttachmentIds ?? [],
        ),
      ),
    ).toEqual([clonedScreenshot!.id]);
    const hydratedScreenshot = history.messages
      .flatMap((message) => message.attachments)
      .find((attachment) => attachment.id === clonedScreenshot!.id);
    const hydratedExplicit = history.messages
      .flatMap((message) => message.attachments)
      .find((attachment) => attachment.id === clonedExplicit!.id);
    expect(hydratedScreenshot?.computerUseScreenshot).toBe(true);
    expect(hydratedExplicit?.computerUseScreenshot).toBeUndefined();
    expect(await getAttachmentContent(screenshot.id)).toBeNull();
    expect(
      (await getAttachmentContent(clonedScreenshot!.id))?.toString("base64"),
    ).toBe(screenshotBase64);

    const firstFilesPage = await listConversationAttachments(fork.id, {
      limit: 1,
      offset: 0,
    });
    const secondFilesPage = await listConversationAttachments(fork.id, {
      limit: 1,
      offset: 1,
    });
    expect(firstFilesPage.total).toBe(2);
    expect(secondFilesPage.total).toBe(2);
    expect(
      [...firstFilesPage.attachments, ...secondFilesPage.attachments].map(
        (attachment) => attachment.id,
      ),
    ).toEqual([clonedScreenshot!.id, clonedExplicit!.id]);
    expect(
      [...firstFilesPage.attachments, ...secondFilesPage.attachments].every(
        (attachment) => attachment.messageId === forkReply!.id,
      ),
    ).toBe(true);
  });

  test("inherits the source conversation's inference profile", async () => {
    const source = await createConversation("Pinned profile thread");
    await addMessage(source.id, "user", "Use the balanced profile", {
      skipIndexing: true,
    });
    await requireMainDb()
      .orm.update(conversations)
      .set({ inferenceProfile: "balanced" })
      .where(eq(conversations.id, source.id));

    const fork = await forkConversation({ conversationId: source.id });

    expect(fork.inferenceProfile).toBe("balanced");
  });

  test("leaves inference profile null when source has no override", async () => {
    const source = await createConversation("Default profile thread");
    await addMessage(source.id, "user", "No pinned profile", {
      skipIndexing: true,
    });

    const fork = await forkConversation({ conversationId: source.id });

    expect(fork.inferenceProfile).toBeNull();
  });

  test("marks copied assistant history as seen and excludes request logs, queued work, and inbound events", async () => {
    const source = await createConversation("Support thread");
    const sourceUser = await addMessage(
      source.id,
      "user",
      "The deploy is failing.",
      { skipIndexing: true },
    );
    const sourceAssistant = await addMessage(
      source.id,
      "assistant",
      "I found the failing migration.",
      { skipIndexing: true },
    );
    await markConversationUnread(source.id);

    const db = requireMainDb();
    const now = Date.now();
    await db.run(
      "INSERT INTO llm_request_logs (id, conversation_id, message_id, request_payload, response_payload, created_at) VALUES (?, ?, ?, ?, ?, ?)",
      [
        "llm-log-1",
        source.id,
        sourceAssistant.id,
        '{"prompt":"debug"}',
        '{"result":"ok"}',
        now,
      ],
    );
    await db.orm.insert(toolInvocations).values({
      id: "tool-invocation-1",
      conversationId: source.id,
      toolName: "bash",
      input: '{"command":"bun test"}',
      result: '{"ok":true}',
      decision: "allow",
      riskLevel: "medium",
      durationMs: 42,
      createdAt: now,
    });
    await db.run(
      "INSERT INTO memory_jobs (id, type, payload, status, attempts, deferrals, run_after, last_error, started_at, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
      [
        "memory-job-1",
        "delete_qdrant_vectors",
        JSON.stringify({ conversationId: source.id }),
        "pending",
        0,
        0,
        now,
        null,
        null,
        now,
        now,
      ],
    );
    await db.orm.insert(channelInboundEvents).values({
      id: "inbound-event-1",
      sourceChannel: "telegram",
      externalChatId: "chat-1",
      externalMessageId: "message-1",
      sourceMessageId: "source-message-1",
      conversationId: source.id,
      messageId: sourceUser.id,
      deliveryStatus: "pending",
      processingStatus: "pending",
      processingAttempts: 0,
      lastProcessingError: null,
      retryAfter: null,
      rawPayload: "{}",
      deliveredSegmentCount: 0,
      createdAt: now,
      updatedAt: now,
    });

    const sourceState = (
      await getAttentionStateByConversationIds([source.id])
    ).get(source.id);
    const fork = await forkConversation({ conversationId: source.id });
    const forkAssistant = (await getMessages(fork.id)).find(
      (message) => message.role === "assistant",
    );
    const forkAssistantMetadata = forkAssistant?.metadata
      ? (JSON.parse(forkAssistant.metadata) as {
          forkSourceMessageId?: string;
        })
      : null;
    const forkRequestLogs = forkAssistant
      ? await getRequestLogsByMessageId(forkAssistant.id)
      : [];
    const forkState = (await getAttentionStateByConversationIds([fork.id])).get(
      fork.id,
    );
    const forkRequestLogCount = (await db.get<{ cnt: number }>(
      "SELECT COUNT(*)::int AS cnt FROM llm_request_logs WHERE conversation_id = ?",
      [fork.id],
    ))!.cnt;
    const forkToolInvocationCount = (await db.get<{ cnt: number }>(
      "SELECT COUNT(*)::int AS cnt FROM tool_invocations WHERE conversation_id = ?",
      [fork.id],
    ))!.cnt;
    const forkInboundEventCount = (await db.get<{ cnt: number }>(
      "SELECT COUNT(*)::int AS cnt FROM channel_inbound_events WHERE conversation_id = ?",
      [fork.id],
    ))!.cnt;
    const forkQueuedWorkCount = (await db.get<{ cnt: number }>(
      "SELECT COUNT(*)::int AS cnt FROM memory_jobs WHERE payload LIKE ?",
      [`%${fork.id}%`],
    ))!.cnt;

    expect(sourceState).toBeDefined();
    expect(sourceState?.lastSeenAssistantMessageId).toBeNull();
    expect(forkAssistant).toBeDefined();
    expect(forkAssistantMetadata?.forkSourceMessageId).toBe(sourceAssistant.id);
    expect(forkRequestLogs).toHaveLength(1);
    expect(forkRequestLogs[0]?.conversationId).toBe(source.id);
    expect(forkRequestLogs[0]?.messageId).toBe(sourceAssistant.id);
    expect(forkState).toBeDefined();
    expect(forkState?.latestAssistantMessageId).toBe(forkAssistant?.id);
    expect(forkState?.lastSeenAssistantMessageId).toBe(forkAssistant?.id);
    expect(forkState?.lastSeenAssistantMessageAt).toBe(
      forkAssistant?.createdAt,
    );
    expect(forkRequestLogCount).toBe(0);
    expect(forkToolInvocationCount).toBe(0);
    expect(forkInboundEventCount).toBe(0);
    expect(forkQueuedWorkCount).toBe(0);
  });

  test("copies the parent's v2 activation state into the fork", async () => {
    const source = await createConversation("Activation thread");
    const sourceMessage = await addMessage(
      source.id,
      "user",
      "Tell me about the Q3 launch plan",
      { skipIndexing: true },
    );

    await insertActivationState({
      conversationId: source.id,
      messageId: sourceMessage.id,
      state: {
        "concepts/q3-launch-plan": 0.71,
        "concepts/marketing-ops": 0.34,
      },
      everInjected: [
        { slug: "concepts/q3-launch-plan", turn: 1 },
        { slug: "concepts/marketing-ops", turn: 1 },
      ],
      currentTurn: 2,
    });

    const fork = await forkConversation({ conversationId: source.id });

    const childState = await hydrateActivationState(fork.id);
    expect(childState).toEqual({
      messageId: sourceMessage.id,
      state: {
        "concepts/q3-launch-plan": 0.71,
        "concepts/marketing-ops": 0.34,
      },
      everInjected: [
        { slug: "concepts/q3-launch-plan", turn: 1 },
        { slug: "concepts/marketing-ops", turn: 1 },
      ],
      currentTurn: 2,
      updatedAt: 1_700_000_000_000,
    });

    // Parent state is untouched.
    const parentState = await hydrateActivationState(source.id);
    expect(parentState?.currentTurn).toBe(2);
  });

  test("copies the parent's v1 graph memory state into the fork", async () => {
    const source = await createConversation("Graph tracker thread");
    await addMessage(source.id, "user", "Look up alice's preferences", {
      skipIndexing: true,
    });

    const trackerSnapshot = JSON.stringify({
      initialized: true,
      needsReload: false,
      inContext: ["node-alice", "node-bob"],
      log: [
        { nodeId: "node-alice", turn: 1 },
        { nodeId: "node-bob", turn: 2 },
      ],
      currentTurn: 3,
    });
    await saveGraphMemoryState(source.id, trackerSnapshot);

    const fork = await forkConversation({ conversationId: source.id });

    expect(await loadGraphMemoryState(fork.id)).toBe(trackerSnapshot);
    // Parent row is untouched.
    expect(await loadGraphMemoryState(source.id)).toBe(trackerSnapshot);
  });

  test("leaves both memory state tables empty when the parent has none", async () => {
    const source = await createConversation("Pristine thread");
    await addMessage(source.id, "user", "first message", {
      skipIndexing: true,
    });

    const fork = await forkConversation({ conversationId: source.id });

    expect(await hydrateActivationState(fork.id)).toBeNull();
    expect(await loadGraphMemoryState(fork.id)).toBeNull();
  });

  test("does not copy memory state when the fork is truncated mid-history", async () => {
    const source = await createConversation("Truncated thread");
    const firstMessage = await addMessage(source.id, "user", "first turn", {
      skipIndexing: true,
    });
    await addMessage(source.id, "assistant", "first reply", {
      skipIndexing: true,
    });
    const lastMessage = await addMessage(source.id, "user", "second turn", {
      skipIndexing: true,
    });

    await insertActivationState({
      conversationId: source.id,
      messageId: lastMessage.id,
      state: { "concepts/foo": 0.5 },
      everInjected: [{ slug: "concepts/foo", turn: 2 }],
      currentTurn: 2,
    });
    await saveGraphMemoryState(
      source.id,
      JSON.stringify({
        initialized: true,
        needsReload: false,
        inContext: ["node-foo"],
        log: [{ nodeId: "node-foo", turn: 2 }],
        currentTurn: 2,
      }),
    );

    const fork = await forkConversation({
      conversationId: source.id,
      throughMessageId: firstMessage.id,
    });

    expect(await hydrateActivationState(fork.id)).toBeNull();
    expect(await loadGraphMemoryState(fork.id)).toBeNull();
  });

  test("truncated fork seeds everInjected from inherited memory attachments", async () => {
    const source = await createConversation("Truncated seed thread");
    await addMessage(source.id, "user", "first turn", {
      metadata: {
        memoryInjectedBlock:
          "# memory/concepts/topics/page-a.md\nSummary A\n\n# memory/concepts/topics/page-b.md\nSummary B",
      },
      skipIndexing: true,
    });
    await addMessage(source.id, "assistant", "first reply", {
      skipIndexing: true,
    });
    const boundaryMessage = await addMessage(source.id, "user", "second turn", {
      metadata: {
        memoryInjectedBlock: "# memory/concepts/topics/page-c.md\nSummary C",
      },
      skipIndexing: true,
    });
    await addMessage(source.id, "assistant", "second reply", {
      skipIndexing: true,
    });
    // Past the fork boundary — its attachment must NOT be claimed.
    await addMessage(source.id, "user", "third turn", {
      metadata: {
        memoryInjectedBlock: "# memory/concepts/topics/page-d.md\nSummary D",
      },
      skipIndexing: true,
    });

    await insertActivationState({
      conversationId: source.id,
      messageId: "parent-msg",
      state: { "topics/page-d": 0.9 },
      everInjected: [
        { slug: "topics/page-a", turn: 1 },
        { slug: "topics/page-b", turn: 1 },
        { slug: "topics/page-c", turn: 2 },
        { slug: "topics/page-d", turn: 3 },
      ],
      currentTurn: 3,
    });

    const fork = await forkConversation({
      conversationId: source.id,
      throughMessageId: boundaryMessage.id,
    });

    const childState = await hydrateActivationState(fork.id);
    expect(childState).not.toBeNull();
    // Exactly the slugs whose attachments live in the copied history —
    // page-d (injected past the boundary) stays re-injectable.
    expect(childState?.everInjected.map((e) => e.slug).sort()).toEqual([
      "topics/page-a",
      "topics/page-b",
      "topics/page-c",
    ]);
    expect(childState?.everInjected.every((e) => e.turn === 0)).toBe(true);
    // Activation scores and the turn counter start fresh, matching the
    // graph tracker (also not copied for truncated forks).
    expect(childState?.state).toEqual({});
    expect(childState?.currentTurn).toBe(0);
  });

  test("truncated fork ignores attachments behind an inherited compaction boundary", async () => {
    const source = await createConversation("Compacted truncated thread");
    const compactedTurn = await addMessage(
      source.id,
      "user",
      "compacted turn",
      {
        metadata: {
          memoryInjectedBlock:
            "# memory/concepts/topics/page-compacted.md\nOld summary",
        },
        skipIndexing: true,
      },
    );
    const compactedReply = await addMessage(
      source.id,
      "assistant",
      "compacted reply",
      { skipIndexing: true },
    );
    const boundaryMessage = await addMessage(source.id, "user", "live turn", {
      metadata: {
        memoryInjectedBlock: "# memory/concepts/topics/page-live.md\nSummary",
      },
      skipIndexing: true,
    });
    const liveReply = await addMessage(source.id, "assistant", "live reply", {
      skipIndexing: true,
    });
    const pastBoundary = await addMessage(source.id, "user", "past boundary", {
      skipIndexing: true,
    });
    // First two messages sit behind a compaction that ran before the live
    // turn: their injected blocks are not rendered, so the fork must not
    // claim them.
    const db = requireMainDb();
    const base = Date.now();
    await db.run(
      `UPDATE messages SET created_at = ${base} WHERE id = '${compactedTurn.id}'`,
    );
    await db.run(
      `UPDATE messages SET created_at = ${base + 1} WHERE id = '${compactedReply.id}'`,
    );
    await db.run(
      `UPDATE messages SET created_at = ${base + 3} WHERE id = '${boundaryMessage.id}'`,
    );
    await db.run(
      `UPDATE messages SET created_at = ${base + 4} WHERE id = '${liveReply.id}'`,
    );
    await db.run(
      `UPDATE messages SET created_at = ${base + 5} WHERE id = '${pastBoundary.id}'`,
    );
    const compactedAt = base + 2;
    await db.orm
      .update(conversations)
      .set({
        contextSummary: "Compacted summary",
        contextCompactedMessageCount: 2,
        contextCompactedAt: compactedAt,
      })
      .where(eq(conversations.id, source.id));
    await appendCompactionEvent(source.id, {
      compactedAt,
      summary: "Compacted summary",
      compactedMessageCount: 2,
    });

    const fork = await forkConversation({
      conversationId: source.id,
      throughMessageId: boundaryMessage.id,
    });

    const childState = await hydrateActivationState(fork.id);
    expect(childState?.everInjected.map((e) => e.slug)).toEqual([
      "topics/page-live",
    ]);
  });

  test("copies the parent's memory-v3 section record into a full fork", async () => {
    const source = await createConversation("V3 carry thread");
    await addMessage(source.id, "user", "first turn", { skipIndexing: true });

    await recordV3Injected(
      source.id,
      [
        { slug: "topics/page-a", key: "", bytes: 120 },
        { slug: "topics/page-a", key: "Notes", bytes: 80 },
        { slug: "topics/page-b", key: "", bytes: 340 },
      ],
      1_700_000_000_000,
    );
    await markV3Pruned(
      source.id,
      [{ slug: "topics/page-b", key: "" }],
      1_700_000_001_000,
    );

    const fork = await forkConversation({ conversationId: source.id });

    // Full-row copy, pruned state included.
    expect(await getV3Injected(fork.id)).toEqual([
      {
        slug: "topics/page-a",
        key: "",
        bytes: 120,
        injectedAt: 1_700_000_000_000,
        lastSelectedAt: 1_700_000_000_000,
        prunedAt: null,
      },
      {
        slug: "topics/page-a",
        key: "Notes",
        bytes: 80,
        injectedAt: 1_700_000_000_000,
        lastSelectedAt: 1_700_000_000_000,
        prunedAt: null,
      },
      {
        slug: "topics/page-b",
        key: "",
        bytes: 340,
        injectedAt: 1_700_000_000_000,
        lastSelectedAt: 1_700_000_000_000,
        prunedAt: 1_700_000_001_000,
      },
    ]);
    // Parent record is untouched.
    expect(await getV3Injected(source.id)).toHaveLength(3);
  });

  test("leaves the fork's memory-v3 record empty when the parent has none", async () => {
    const source = await createConversation("V3 pristine thread");
    await addMessage(source.id, "user", "first message", {
      skipIndexing: true,
    });

    const fork = await forkConversation({ conversationId: source.id });

    expect(await getV3Injected(fork.id)).toEqual([]);
  });

  test("truncated fork seeds the memory-v3 record from inherited v3 section blocks", async () => {
    const source = await createConversation("V3 truncated seed thread");
    // A lead (bare page header) and a heading section of one page, plus
    // another page's lead.
    const leadA = "# memory/concepts/topics/page-a.md\nLead A";
    const notesA = "# memory/concepts/topics/page-a.md § Notes\nNotes A";
    const leadB = "# memory/concepts/topics/page-b.md\nLead B";
    const skill = "# Skill: meet-join\nJoin a meeting.";
    await addMessage(source.id, "user", "first turn", {
      metadata: {
        [MEMORY_V3_INJECTED_BLOCK_FORMAT_METADATA_KEY]:
          MEMORY_V3_INJECTED_BLOCK_FORMAT,
        [MEMORY_V3_INJECTED_BLOCK_METADATA_KEY]: `${leadA}\n\n${notesA}\n\n${leadB}\n\n${skill}`,
        // A v2 block on the same message must seed only the v2 record.
        memoryInjectedBlock: "# memory/concepts/topics/page-v2.md\nSummary",
      },
      skipIndexing: true,
    });
    await addMessage(source.id, "assistant", "first reply", {
      skipIndexing: true,
    });
    const boundaryMessage = await addMessage(source.id, "user", "second turn", {
      skipIndexing: true,
    });
    await addMessage(source.id, "assistant", "second reply", {
      skipIndexing: true,
    });
    // Past the fork boundary, its section must NOT be claimed.
    await addMessage(source.id, "user", "third turn", {
      metadata: {
        [MEMORY_V3_INJECTED_BLOCK_FORMAT_METADATA_KEY]:
          MEMORY_V3_INJECTED_BLOCK_FORMAT,
        [MEMORY_V3_INJECTED_BLOCK_METADATA_KEY]:
          "# memory/concepts/topics/page-c.md\nLead C",
      },
      skipIndexing: true,
    });

    await recordV3Injected(
      source.id,
      [
        { slug: "topics/page-a", key: "", bytes: 120 },
        { slug: "topics/page-a", key: "Notes", bytes: 60 },
        { slug: "topics/page-b", key: "", bytes: 340 },
        { slug: "topics/page-c", key: "", bytes: 90 },
      ],
      1_700_000_000_000,
    );

    const fork = await forkConversation({
      conversationId: source.id,
      throughMessageId: boundaryMessage.id,
    });

    // Exactly the sections whose blocks live in the copied history, each
    // carrying the bytes of its inherited span (the child's resident
    // accounting starts at what it inherited), plus the inherited skill chunk
    // as a zero-byte capability row.
    expect(
      (await getV3Injected(fork.id)).map(({ slug, key, bytes, prunedAt }) => ({
        slug,
        key,
        bytes,
        prunedAt,
      })),
    ).toEqual([
      { slug: "skills/meet-join", key: "", bytes: 0, prunedAt: null },
      {
        slug: "topics/page-a",
        key: "",
        bytes: Buffer.byteLength(leadA),
        prunedAt: null,
      },
      {
        slug: "topics/page-a",
        key: "Notes",
        bytes: Buffer.byteLength(notesA),
        prunedAt: null,
      },
      {
        slug: "topics/page-b",
        key: "",
        bytes: Buffer.byteLength(leadB),
        prunedAt: null,
      },
    ]);
    // The v2 seed picked up only the v2 block, not the v3 sections.
    const childState = await hydrateActivationState(fork.id);
    expect(childState?.everInjected.map((e) => e.slug)).toEqual([
      "topics/page-v2",
    ]);
  });

  test("truncated fork carries the parent's pruned tombstones for inherited v3 sections", async () => {
    // Pruning never rewrites the persisted metadata block, so the fork scan
    // sees pruned sections too, the seed must tombstone them, or the child's
    // rehydration would resurrect sections the parent's live view lost.
    const source = await createConversation("V3 truncated pruned thread");
    const leadA = "# memory/concepts/topics/page-a.md\nLead A";
    const notesB = "# memory/concepts/topics/page-b.md § Notes\nNotes B";
    await addMessage(source.id, "user", "first turn", {
      metadata: {
        [MEMORY_V3_INJECTED_BLOCK_FORMAT_METADATA_KEY]:
          MEMORY_V3_INJECTED_BLOCK_FORMAT,
        [MEMORY_V3_INJECTED_BLOCK_METADATA_KEY]: `${leadA}\n\n${notesB}`,
      },
      skipIndexing: true,
    });
    const boundaryMessage = await addMessage(
      source.id,
      "assistant",
      "first reply",
      { skipIndexing: true },
    );
    // Past the fork boundary — forces the truncated-seed path (a fork through
    // the final message takes the wholesale-copy path instead).
    await addMessage(source.id, "user", "second turn", { skipIndexing: true });

    await recordV3Injected(
      source.id,
      [
        { slug: "topics/page-a", key: "", bytes: 120 },
        { slug: "topics/page-b", key: "Notes", bytes: 340 },
      ],
      1_700_000_000_000,
    );
    await markV3Pruned(
      source.id,
      [{ slug: "topics/page-b", key: "Notes" }],
      1_700_000_005_000,
    );

    const fork = await forkConversation({
      conversationId: source.id,
      throughMessageId: boundaryMessage.id,
    });

    expect(
      (await getV3Injected(fork.id)).map(({ slug, key, bytes, prunedAt }) => ({
        slug,
        key,
        bytes,
        prunedAt,
      })),
    ).toEqual([
      {
        slug: "topics/page-a",
        key: "",
        bytes: Buffer.byteLength(leadA),
        prunedAt: null,
      },
      {
        slug: "topics/page-b",
        key: "Notes",
        bytes: Buffer.byteLength(notesB),
        prunedAt: 1_700_000_005_000,
      },
    ]);
  });

  test("defaults conversationType to standard and inherits the parent's group", async () => {
    const source = await createConversation("Default inheritance thread");
    await addMessage(source.id, "user", "first message", {
      skipIndexing: true,
    });
    await rawRunAsync(
      "test:setGroupId",
      "UPDATE conversations SET group_id = ? WHERE id = ?",
      "system:pinned",
      source.id,
    );

    const fork = await forkConversation({ conversationId: source.id });
    const row = (
      await requireMainDb()
        .orm.select()
        .from(conversations)
        .where(eq(conversations.id, fork.id))
    )[0];
    const groupIdRow = await rawGetAsync<{ group_id: string | null }>(
      "test:fetchForkGroupId",
      "SELECT group_id FROM conversations WHERE id = ?",
      fork.id,
    );

    expect(row?.conversationType).toBe("standard");
    expect(groupIdRow?.group_id).toBe("system:pinned");
  });

  test("honors conversationType and groupId overrides on the fork", async () => {
    const source = await createConversation("Override thread");
    await addMessage(source.id, "user", "first message", {
      skipIndexing: true,
    });

    const fork = await forkConversation({
      conversationId: source.id,
      conversationType: "background",
      groupId: "system:background",
    });

    const row = (
      await requireMainDb()
        .orm.select()
        .from(conversations)
        .where(eq(conversations.id, fork.id))
    )[0];
    const groupIdRow = await rawGetAsync<{ group_id: string | null }>(
      "test:fetchForkGroupId",
      "SELECT group_id FROM conversations WHERE id = ?",
      fork.id,
    );

    expect(row?.conversationType).toBe("background");
    expect(groupIdRow?.group_id).toBe("system:background");
  });

  test("copies memory state when throughMessageId points at the last message", async () => {
    const source = await createConversation("Through-last thread");
    const lastMessage = await addMessage(source.id, "user", "only turn", {
      skipIndexing: true,
    });

    await insertActivationState({
      conversationId: source.id,
      messageId: lastMessage.id,
      state: { "concepts/foo": 0.9 },
      everInjected: [{ slug: "concepts/foo", turn: 1 }],
      currentTurn: 1,
    });

    const fork = await forkConversation({
      conversationId: source.id,
      throughMessageId: lastMessage.id,
    });

    const childState = await hydrateActivationState(fork.id);
    expect(childState?.currentTurn).toBe(1);
  });

  test("batch-copies every message with a complete id map and last-assistant pointer", async () => {
    // Multi-message transcript whose final row is a user message (after the
    // last assistant). The batched insert must map every source row to a
    // distinct forked row and track the latest *assistant* message — not the
    // trailing user row — for the attention pointer.
    const source = await createConversation("Batch fork thread");
    await addMessage(source.id, "user", "Question 1", { skipIndexing: true });
    await addMessage(source.id, "assistant", "Answer 1", {
      skipIndexing: true,
    });
    await addMessage(source.id, "user", "Question 2", { skipIndexing: true });
    const lastAssistant = await addMessage(source.id, "assistant", "Answer 2", {
      skipIndexing: true,
    });
    await addMessage(source.id, "user", "Trailing user message", {
      skipIndexing: true,
    });

    const sourceMessages = await getMessages(source.id);
    const fork = await forkConversation({ conversationId: source.id });
    const forkMessages = await getMessages(fork.id);

    // Same count, roles, content, and ordering as the source.
    expect(forkMessages).toHaveLength(sourceMessages.length);
    expect(forkMessages.map((m) => m.role)).toEqual(
      sourceMessages.map((m) => m.role),
    );
    expect(forkMessages.map((m) => m.content)).toEqual(
      sourceMessages.map((m) => m.content),
    );

    // Every source message maps to exactly one distinct forked message via the
    // forkSourceMessageId stamped into each copy's metadata.
    const sourceToFork = new Map<string, string>();
    for (const forked of forkMessages) {
      const md = parseMetadata(forked.metadata) as {
        forkSourceMessageId?: string;
      } | null;
      expect(md?.forkSourceMessageId).toBeDefined();
      sourceToFork.set(md!.forkSourceMessageId!, forked.id);
    }
    expect(sourceToFork.size).toBe(sourceMessages.length);
    for (const sourceMessage of sourceMessages) {
      expect(sourceToFork.has(sourceMessage.id)).toBe(true);
    }
    // Forked ids are all fresh — no source id is reused.
    expect(new Set(forkMessages.map((m) => m.id)).size).toBe(
      forkMessages.length,
    );
    expect(
      forkMessages.every((m, index) => m.id !== sourceMessages[index]?.id),
    ).toBe(true);

    // The attention pointer (driven by latestForkedAssistant) targets the
    // forked copy of the last assistant row, not the trailing user message.
    const forkState = (await getAttentionStateByConversationIds([fork.id])).get(
      fork.id,
    );
    expect(forkState?.lastSeenAssistantMessageId).toBe(
      sourceToFork.get(lastAssistant.id),
    );
    expect(forkState?.lastSeenAssistantMessageAt).toBe(lastAssistant.createdAt);
  });
});

describePg("forkConversation + memory_retrospective_state", () => {
  beforeEach(async () => {
    await resetTables();
  });

  test("does not seed state when the source has none", async () => {
    const source = await createConversation("Untouched thread");
    await addMessage(source.id, "user", "Message 1", {
      skipIndexing: true,
    });

    const fork = await forkConversation({ conversationId: source.id });

    expect(await getRetrospectiveState(fork.id)).toBeNull();
  });

  test("maps the source pointer when it falls within the copied range", async () => {
    const source = await createConversation("In-range thread");
    await addMessage(source.id, "user", "Message 1", {
      skipIndexing: true,
    });
    const processedMessage = await addMessage(
      source.id,
      "assistant",
      "Message 2",
      { skipIndexing: true },
    );
    await addMessage(source.id, "user", "Message 3", {
      skipIndexing: true,
    });

    await upsertRetrospectiveState({
      conversationId: source.id,
      lastProcessedMessageId: processedMessage.id,
      lastRunAt: 1_700_000_000_000,
    });

    const fork = await forkConversation({ conversationId: source.id });
    const forkState = await getRetrospectiveState(fork.id);
    const forkMessages = await getMessages(fork.id);
    const mappedProcessedId = forkMessages.find((m) => {
      const md = parseMetadata(m.metadata) as {
        forkSourceMessageId?: string;
      } | null;
      return md?.forkSourceMessageId === processedMessage.id;
    })?.id;

    expect(mappedProcessedId).toBeDefined();
    expect(forkState).not.toBeNull();
    expect(forkState?.lastProcessedMessageId).toBe(mappedProcessedId);
    expect(forkState?.lastRunAt).toBe(1_700_000_000_000);
  });

  test("clamps to the last copied message when the source pointer is past the fork boundary", async () => {
    const source = await createConversation("Past-boundary thread");
    await addMessage(source.id, "user", "Message 1", {
      skipIndexing: true,
    });
    const branchPoint = await addMessage(source.id, "assistant", "Message 2", {
      skipIndexing: true,
    });
    const pastBoundaryMessage = await addMessage(
      source.id,
      "user",
      "Message 3",
      { skipIndexing: true },
    );
    await addMessage(source.id, "assistant", "Message 4", {
      skipIndexing: true,
    });

    await upsertRetrospectiveState({
      conversationId: source.id,
      lastProcessedMessageId: pastBoundaryMessage.id,
      lastRunAt: 1_700_000_000_000,
    });

    const fork = await forkConversation({
      conversationId: source.id,
      throughMessageId: branchPoint.id,
    });
    const forkState = await getRetrospectiveState(fork.id);
    const forkMessages = await getMessages(fork.id);
    const lastForkedMessageId = forkMessages.at(-1)?.id;

    expect(forkMessages).toHaveLength(2);
    expect(forkState?.lastProcessedMessageId).toBe(lastForkedMessageId);
    expect(forkState?.lastRunAt).toBe(1_700_000_000_000);
  });

  test("preserves the empty-string sentinel from a failure-only source", async () => {
    const source = await createConversation("Failure-only thread");
    await addMessage(source.id, "user", "Message 1", {
      skipIndexing: true,
    });
    await bumpRetrospectiveLastRunAt(source.id, 1_700_000_000_000);

    const fork = await forkConversation({ conversationId: source.id });
    const forkState = await getRetrospectiveState(fork.id);

    expect(forkState?.lastProcessedMessageId).toBe("");
    expect(forkState?.lastRunAt).toBe(1_700_000_000_000);
  });

  test("copies lastRunAt so the cooldown gate inherits from the source", async () => {
    const source = await createConversation("Cooldown thread");
    const message = await addMessage(source.id, "user", "Message 1", {
      skipIndexing: true,
    });
    await upsertRetrospectiveState({
      conversationId: source.id,
      lastProcessedMessageId: message.id,
      lastRunAt: 1_700_000_000_000,
    });

    const fork = await forkConversation({ conversationId: source.id });

    expect((await getRetrospectiveState(fork.id))?.lastRunAt).toBe(
      1_700_000_000_000,
    );
  });

  test("inherits the earlier of two compactions when forking between them", async () => {
    const source = await createConversation("Twice-compacted thread");
    const m1 = await addMessage(source.id, "user", "Message 1", {
      skipIndexing: true,
    });
    const m2 = await addMessage(source.id, "assistant", "Message 2", {
      skipIndexing: true,
    });
    const m3 = await addMessage(source.id, "user", "Message 3", {
      skipIndexing: true,
    });
    const m4 = await addMessage(source.id, "assistant", "Message 4", {
      skipIndexing: true,
    });

    const db = requireMainDb();
    const base = Date.now();
    await db.run(
      `UPDATE messages SET created_at = ${base} WHERE id = '${m1.id}'`,
    );
    await db.run(
      `UPDATE messages SET created_at = ${base + 2} WHERE id = '${m2.id}'`,
    );
    await db.run(
      `UPDATE messages SET created_at = ${base + 4} WHERE id = '${m3.id}'`,
    );
    await db.run(
      `UPDATE messages SET created_at = ${base + 6} WHERE id = '${m4.id}'`,
    );
    // C1 ran after M1 (covers 1 message); C2 ran after M3 (covers 3).
    await appendCompactionEvent(source.id, {
      compactedAt: base + 1,
      summary: "Summary 1",
      compactedMessageCount: 1,
    });
    await appendCompactionEvent(source.id, {
      compactedAt: base + 5,
      summary: "Summary 2",
      compactedMessageCount: 3,
    });

    // Forking through M3 lands between the two compactions, so it inherits the
    // earlier one — the capability a single stored pointer cannot provide.
    const fork = await forkConversation({
      conversationId: source.id,
      throughMessageId: m3.id,
    });
    expect(fork.contextSummary).toBe("Summary 1");
    expect(fork.contextCompactedMessageCount).toBe(1);
    expect(fork.contextCompactedAt).toBe(base + 1);
  });

  test("carries a ledger into the fork so re-forks resolve compaction", async () => {
    const source = await createConversation("Re-fork thread");
    const m1 = await addMessage(source.id, "user", "Message 1", {
      skipIndexing: true,
    });
    const m2 = await addMessage(source.id, "assistant", "Message 2", {
      skipIndexing: true,
    });
    const m3 = await addMessage(source.id, "user", "Message 3", {
      skipIndexing: true,
    });

    const db = requireMainDb();
    const base = Date.now();
    await db.run(
      `UPDATE messages SET created_at = ${base} WHERE id = '${m1.id}'`,
    );
    await db.run(
      `UPDATE messages SET created_at = ${base + 1} WHERE id = '${m2.id}'`,
    );
    await db.run(
      `UPDATE messages SET created_at = ${base + 3} WHERE id = '${m3.id}'`,
    );
    const compactedAt = base + 2; // covers M1+M2, before M3
    await db.orm
      .update(conversations)
      .set({
        contextSummary: "Compacted summary",
        contextCompactedMessageCount: 2,
        contextCompactedAt: compactedAt,
      })
      .where(eq(conversations.id, source.id));
    await appendCompactionEvent(source.id, {
      compactedAt,
      summary: "Compacted summary",
      compactedMessageCount: 2,
    });

    const fork = await forkConversation({ conversationId: source.id });
    expect(fork.contextCompactedMessageCount).toBe(2);

    // The fork owns a copy of the ledger, so a re-fork resolves the inherited
    // compaction without walking back to the original source.
    const reFork = await forkConversation({ conversationId: fork.id });
    expect(reFork.contextSummary).toBe("Compacted summary");
    expect(reFork.contextCompactedMessageCount).toBe(2);
  });

  test("drops the stale Slack watermark when forking inherits an older compaction", async () => {
    const source = await createConversation("Slack twice-compacted thread");
    const m1 = await addMessage(source.id, "user", "Message 1", {
      skipIndexing: true,
    });
    const m2 = await addMessage(source.id, "assistant", "Message 2", {
      skipIndexing: true,
    });
    const m3 = await addMessage(source.id, "user", "Message 3", {
      skipIndexing: true,
    });
    const m4 = await addMessage(source.id, "assistant", "Message 4", {
      skipIndexing: true,
    });

    const db = requireMainDb();
    const base = Date.now();
    await db.run(
      `UPDATE messages SET created_at = ${base} WHERE id = '${m1.id}'`,
    );
    await db.run(
      `UPDATE messages SET created_at = ${base + 2} WHERE id = '${m2.id}'`,
    );
    await db.run(
      `UPDATE messages SET created_at = ${base + 4} WHERE id = '${m3.id}'`,
    );
    await db.run(
      `UPDATE messages SET created_at = ${base + 6} WHERE id = '${m4.id}'`,
    );
    await appendCompactionEvent(source.id, {
      compactedAt: base + 1,
      summary: "Summary 1",
      compactedMessageCount: 1,
    });
    await appendCompactionEvent(source.id, {
      compactedAt: base + 5,
      summary: "Summary 2",
      compactedMessageCount: 3,
    });
    // The source's single-valued watermark reflects only the latest compaction.
    await db.orm
      .update(conversations)
      .set({
        contextSummary: "Summary 2",
        contextCompactedMessageCount: 3,
        contextCompactedAt: base + 5,
        slackContextCompactionWatermarkTs: "ts-latest",
        slackContextCompactionWatermarkAt: base + 5,
      })
      .where(eq(conversations.id, source.id));

    // Forking through M3 inherits the OLDER compaction (Summary 1); the latest
    // watermark must not ride along, or it would hide Slack messages the older
    // summary does not cover.
    const fork = await forkConversation({
      conversationId: source.id,
      throughMessageId: m3.id,
    });
    expect(fork.contextSummary).toBe("Summary 1");
    expect(fork.contextCompactedMessageCount).toBe(1);
    expect(fork.slackContextCompactionWatermarkTs).toBeNull();
    expect(fork.slackContextCompactionWatermarkAt).toBeNull();
  });

  test("carries the Slack watermark when forking inherits the latest compaction", async () => {
    const source = await createConversation("Slack compacted thread");
    const m1 = await addMessage(source.id, "user", "Message 1", {
      skipIndexing: true,
    });
    const m2 = await addMessage(source.id, "assistant", "Message 2", {
      skipIndexing: true,
    });
    const m3 = await addMessage(source.id, "user", "Message 3", {
      skipIndexing: true,
    });

    const db = requireMainDb();
    const base = Date.now();
    await db.run(
      `UPDATE messages SET created_at = ${base} WHERE id = '${m1.id}'`,
    );
    await db.run(
      `UPDATE messages SET created_at = ${base + 1} WHERE id = '${m2.id}'`,
    );
    await db.run(
      `UPDATE messages SET created_at = ${base + 3} WHERE id = '${m3.id}'`,
    );
    const compactedAt = base + 2; // latest (and only) compaction, covers M1+M2
    await appendCompactionEvent(source.id, {
      compactedAt,
      summary: "Compacted summary",
      compactedMessageCount: 2,
    });
    await db.orm
      .update(conversations)
      .set({
        contextSummary: "Compacted summary",
        contextCompactedMessageCount: 2,
        contextCompactedAt: compactedAt,
        slackContextCompactionWatermarkTs: "ts-latest",
        slackContextCompactionWatermarkAt: compactedAt,
      })
      .where(eq(conversations.id, source.id));

    const fork = await forkConversation({
      conversationId: source.id,
      throughMessageId: m3.id,
    });
    expect(fork.contextCompactedMessageCount).toBe(2);
    expect(fork.slackContextCompactionWatermarkTs).toBe("ts-latest");
    expect(fork.slackContextCompactionWatermarkAt).toBe(compactedAt);
  });
});

describePg("forkConversation with unfinalized rows", () => {
  beforeEach(async () => {
    await resetTables();
  });

  test("skips unfinalized rows and anchors the fork at the last finalized message", async () => {
    const source = await createConversation("Mid-turn fork");
    await addMessage(source.id, "user", "question", { skipIndexing: true });
    const lastFinalized = await addMessage(
      source.id,
      "assistant",
      "completed reply",
      { skipIndexing: true },
    );
    const streaming = await addMessage(
      source.id,
      "assistant",
      "partial reply still being written",
      { skipIndexing: true },
    );
    await rawRunAsync(
      "test:markUnfinalized",
      "UPDATE messages SET finalized = 0 WHERE id = ?",
      streaming.id,
    );

    const fork = await forkConversation({ conversationId: source.id });
    const forkMessages = await getMessages(fork.id);

    // The invariant, not mere presence: exactly the finalized rows were
    // copied, every copy reads as finalized, no copy descends from the
    // unfinalized source row, and the lineage anchor is a row the fork
    // actually holds.
    expect(forkMessages).toHaveLength(2);
    expect(forkMessages.every((row) => row.finalized === 1)).toBe(true);
    const forkedFromIds = forkMessages.map(
      (row) =>
        (parseMetadata(row.metadata) as { forkSourceMessageId?: string })
          ?.forkSourceMessageId,
    );
    expect(forkedFromIds).not.toContain(streaming.id);
    expect(fork.forkParentMessageId).toBe(lastFinalized.id);
    // The source still owns its in-flight row untouched.
    expect(await getMessages(source.id)).toHaveLength(3);
  });

  test("a stale mid-history unfinalized row is skipped without shifting the anchor", async () => {
    const source = await createConversation("Stale row fork");
    await addMessage(source.id, "user", "first", { skipIndexing: true });
    const stale = await addMessage(source.id, "assistant", "orphaned partial", {
      skipIndexing: true,
    });
    const tail = await addMessage(source.id, "user", "latest", {
      skipIndexing: true,
    });
    await rawRunAsync(
      "test:markUnfinalized",
      "UPDATE messages SET finalized = 0 WHERE id = ?",
      stale.id,
    );

    const fork = await forkConversation({ conversationId: source.id });
    const forkMessages = await getMessages(fork.id);

    expect(forkMessages).toHaveLength(2);
    expect(fork.forkParentMessageId).toBe(tail.id);
  });
});

setDefaultTimeout(60_000);
