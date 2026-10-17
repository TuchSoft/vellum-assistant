// Integration coverage for the messages lexical-index write wiring:
//   - a real persist (`addMessage`) enqueues one `index_message_lexical` job
//     for the message, regardless of whether memory is enabled or disabled
//     (message-content search is host infrastructure);
//   - forking a conversation copies message rows WITHOUT routing through
//     the persist path, so a fork enqueues ZERO `index_message_lexical`
//     jobs (the fork-exclusion regression);
//   - wiping a conversation enqueues one `purge_conversation_lexical` job.
//
// The heavy segment indexer (`indexMessageNow`) is stubbed to a no-op so these
// tests exercise only the lexical enqueue seam, not the embedding/extraction
// machinery. Memory config is real (default-enabled), flipped on disk for the
// disabled case.

import {
  afterAll,
  afterEach,
  beforeAll,
  beforeEach,
  expect,
  mock,
  setDefaultTimeout,
  test,
} from "bun:test";
setDefaultTimeout(30_000);

// Stub the segment indexer so the persist path's memory indexing runs cheaply.
// The lexical enqueue is a separate call on the persist path and still fires.
// Other exports are provided so any transitive importer of this module
// resolves. `throwFromIndex` lets a test simulate a transient segment-indexing
// failure to prove the lexical enqueue survives it.
let throwFromIndex = false;
mock.module("../plugins/defaults/memory/indexer.js", () => ({
  MIN_SEGMENT_CHARS: 50,
  indexMessageNow: async () => {
    if (throwFromIndex) {
      throw new Error("simulated segment-indexing failure");
    }
    return { indexedSegments: 0, enqueuedJobs: 0 };
  },
  enqueueBackfillJob: () => "",
  enqueueRebuildIndexJob: () => "",
}));

import {
  invalidateConfigCache,
  loadRawConfig,
  saveRawConfig,
} from "../config/loader.js";
import { consolidateAssistantMessages } from "../daemon/conversation-history.js";
import {
  registerPluginHooks,
  unregisterPluginHooks,
} from "../hooks/registry.js";
import {
  addMessage,
  createConversation,
  deleteConversation,
  deleteConversationGently,
  deleteLastExchange,
  deleteMessageById,
  forkConversation,
  getMessages,
  updateMessageContent,
} from "../persistence/conversation-crud.js";
import { requireMainDb } from "../persistence/db-facade.js";
import { enqueueLexicalIndexForMessage } from "../persistence/job-handlers/message-lexical.js";
import type { MemoryJobType } from "../persistence/jobs-store.js";
import { enqueueMemoryJob } from "../persistence/jobs-store.js";
import memoryConversationDeleted from "../plugins/defaults/memory/hooks/conversation-deleted.js";
import type { PluginHooks } from "../plugins/types.js";
import { describePg } from "./pg-test-db.js";

// Register the memory plugin's `conversation-deleted` hook the way boot does,
// so the delete primitives' dispatch reaches the plugin's job sweep.
registerPluginHooks("default-memory", {
  "conversation-deleted": memoryConversationDeleted,
} as PluginHooks);

/** Poll until `read()` returns a defined value or the timeout elapses. */
async function waitFor<T>(
  read: () => T | Promise<T | undefined> | undefined,
  timeoutMs = 2000,
): Promise<T | undefined> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const value = await read();
    if (value !== undefined || Date.now() > deadline) {
      return value;
    }
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

async function rowsOfType(
  type: MemoryJobType,
): Promise<Array<{ payload: string }>> {
  return requireMainDb().all<{ payload: string }>(
    "SELECT payload FROM memory_jobs WHERE type = ?",
    [type],
  );
}

async function countJobs(
  type: MemoryJobType,
  conversationId?: string,
): Promise<number> {
  const rows = await rowsOfType(type);
  if (conversationId == null) {
    return rows.length;
  }
  return rows.filter((r) => {
    try {
      return (
        (JSON.parse(r.payload) as { conversationId?: string })
          .conversationId === conversationId
      );
    } catch {
      return false;
    }
  }).length;
}

async function lexicalJobMessageIds(): Promise<string[]> {
  return (await rowsOfType("index_message_lexical")).map((r) => {
    try {
      return (JSON.parse(r.payload) as { messageId?: string }).messageId ?? "";
    } catch {
      return "";
    }
  });
}

async function resetMemoryJobs(): Promise<void> {
  await requireMainDb().run("DELETE FROM memory_jobs");
}

function setMemoryEnabled(enabled: boolean): void {
  const raw = loadRawConfig();
  const memory =
    raw.memory && typeof raw.memory === "object"
      ? (raw.memory as Record<string, unknown>)
      : {};
  saveRawConfig({ ...raw, memory: { ...memory, enabled } });
  invalidateConfigCache();
}

describePg("messages lexical-index dual-write", () => {
  beforeEach(async () => {
    await resetMemoryJobs();
  });

  afterEach(() => {
    // Restore the default-enabled config so a disabled-case test cannot leak
    // into later tests sharing this process.
    setMemoryEnabled(true);
    throwFromIndex = false;
  });

  test("addMessage enqueues one index_message_lexical job for the persisted message", async () => {
    const conv = await createConversation("Lexical persist thread");
    const message = await addMessage(conv.id, "user", "hello lexical world");

    const ids = await lexicalJobMessageIds();
    expect(ids).toContain(message.id);
    expect(ids.filter((id) => id === message.id)).toHaveLength(1);
  });

  test("lexical job is still enqueued when segment indexing (indexMessageNow) throws", async () => {
    // The sparse lexical job is independent of the dense embedding path, so a
    // transient segment-indexing failure must not leave the message missing
    // from the lexical index. `addMessage` catches the indexing throw as
    // non-fatal.
    throwFromIndex = true;
    const conv = await createConversation("Segment failure thread");
    const message = await addMessage(
      conv.id,
      "user",
      "index me despite failure",
    );

    expect(await lexicalJobMessageIds()).toContain(message.id);
  });

  test("addMessage still enqueues an index_message_lexical job when memory is disabled", async () => {
    setMemoryEnabled(false);
    const conv = await createConversation("Disabled memory thread");
    const message = await addMessage(
      conv.id,
      "user",
      "lexically indexed regardless of memory state",
    );

    expect(await lexicalJobMessageIds()).toContain(message.id);
  });

  test("enqueueLexicalIndexForMessage no-ops on an empty message id", async () => {
    enqueueLexicalIndexForMessage("");
    expect(await countJobs("index_message_lexical")).toBe(0);
  });

  test("forking a conversation enqueues ZERO index_message_lexical jobs", async () => {
    const source = await createConversation("Fork exclusion thread");
    // Persist source messages through the real path so each enqueues a lexical
    // job — this makes the "fork adds none" assertion meaningful.
    await addMessage(source.id, "user", "Draft a launch plan");
    await addMessage(source.id, "assistant", "Here is a first pass.");
    await addMessage(source.id, "user", "Fork from here");

    const beforeFork = await countJobs("index_message_lexical");
    expect(beforeFork).toBe(3);

    // The fork copies every source row directly, bypassing the addMessage
    // persist path (and its lexical enqueue).
    const fork = await forkConversation({ conversationId: source.id });
    expect(fork.id).not.toBe(source.id);

    // No new lexical index jobs were enqueued for the copied fork rows.
    expect(await countJobs("index_message_lexical")).toBe(beforeFork);
    // ...and specifically none of the fork's own message ids were enqueued.
    const enqueuedMessageIds = new Set(await lexicalJobMessageIds());
    for (const forkMessage of await getMessages(fork.id)) {
      expect(enqueuedMessageIds.has(forkMessage.id)).toBe(false);
    }
  });

  test("deleteConversation (direct, no route) enqueues a purge for the conversation", async () => {
    // Retrospective startup cleanup calls deleteConversation directly, bypassing
    // the HTTP route — the purge must still fire from the shared primitive.
    const conv = await createConversation("Direct delete thread");
    await addMessage(conv.id, "user", "index me then delete me");

    await resetMemoryJobs();
    await deleteConversation(conv.id);

    expect(await countJobs("purge_conversation_lexical", conv.id)).toBe(1);
  });

  test("deleteConversation fails its pending memory jobs but leaves host jobs runnable", async () => {
    const conv = await createConversation("Cancel pending jobs thread");
    await addMessage(conv.id, "user", "index me then delete me");

    await resetMemoryJobs();
    // One memory-plugin job type, one host-owned job type — both keyed by the
    // conversation id.
    enqueueMemoryJob("graph_extract", { conversationId: conv.id });
    enqueueMemoryJob("media_processing", { conversationId: conv.id });

    await deleteConversation(conv.id);

    const jobStatus = async (
      type: MemoryJobType,
    ): Promise<string | undefined> => {
      const rows = await requireMainDb().all<{
        status: string;
        payload: string;
      }>("SELECT status, payload FROM memory_jobs WHERE type = ?", [type]);
      return rows.find((r) => {
        try {
          return (
            (JSON.parse(r.payload) as { conversationId?: string })
              .conversationId === conv.id
          );
        } catch {
          return false;
        }
      })?.status;
    };

    // The hook dispatch is fire-and-forget, so wait for the plugin's sweep to
    // land before asserting.
    const graphExtractStatus = await waitFor(async () =>
      (await jobStatus("graph_extract")) === "failed" ? "failed" : undefined,
    );
    expect(graphExtractStatus).toBe("failed");
    // The sweep is scoped to the plugin's own job types: host-owned jobs —
    // including the purge the delete primitive itself enqueued — stay
    // runnable.
    expect(await jobStatus("media_processing")).toBe("pending");
    expect(await jobStatus("purge_conversation_lexical")).toBe("pending");
  });

  test("deleteConversationGently (retrospective GC) enqueues a purge for the conversation", async () => {
    const conv = await createConversation("Gentle delete thread");
    await addMessage(conv.id, "user", "index me then gently delete me");

    await resetMemoryJobs();
    await deleteConversationGently(conv.id);

    expect(await countJobs("purge_conversation_lexical", conv.id)).toBe(1);
  });

  test("deleteMessageById enqueues a delete_message_lexical job for the removed message", async () => {
    const conv = await createConversation("Single delete thread");
    const message = await addMessage(conv.id, "user", "delete just me");

    await resetMemoryJobs();
    await deleteMessageById(message.id);

    const ids = (await rowsOfType("delete_message_lexical")).map(
      (r) => (JSON.parse(r.payload) as { messageId?: string }).messageId,
    );
    expect(ids).toEqual([message.id]);
  });

  test("deleteMessageById for a nonexistent message enqueues nothing", async () => {
    await resetMemoryJobs();
    await deleteMessageById("does-not-exist");
    expect(await countJobs("delete_message_lexical")).toBe(0);
  });

  test("deleteLastExchange enqueues delete_message_lexical for every removed message", async () => {
    // Undo bulk-deletes the last user turn + everything after it via a single
    // `tx.delete(messages)`, bypassing `deleteMessageById`. It must still purge
    // each removed message's lexical point.
    const conv = await createConversation("Undo thread");
    await addMessage(conv.id, "user", "first user turn");
    await addMessage(conv.id, "assistant", "first assistant reply");
    const lastUser = await addMessage(conv.id, "user", "undo this turn");
    const lastAssistant = await addMessage(
      conv.id,
      "assistant",
      "and this reply",
    );

    await resetMemoryJobs();
    const removed = await deleteLastExchange(conv.id);
    expect(removed).toBe(2);

    const deletedIds = (await rowsOfType("delete_message_lexical")).map(
      (r) => (JSON.parse(r.payload) as { messageId?: string }).messageId,
    );
    expect(new Set(deletedIds)).toEqual(
      new Set([lastUser.id, lastAssistant.id]),
    );
  });

  test("updateMessageContent (CRUD primitive) does not enqueue a reindex on its own", async () => {
    // The reindex is owned by the semantic seams (streaming finalize, edits,
    // consolidation), NOT the low-level primitive — this keeps mid-stream
    // partial flushes and tool-timing stamps from spamming reindex jobs.
    const conv = await createConversation("Raw update thread");
    const message = await addMessage(conv.id, "user", "original text");

    await resetMemoryJobs();
    await updateMessageContent(
      message.id,
      JSON.stringify([{ type: "text", text: "edited text" }]),
    );

    expect(await countJobs("index_message_lexical")).toBe(0);
  });

  test("consolidation reindexes the retained message and purges the merged-away rows", async () => {
    const conv = await createConversation("Consolidation thread");
    const userMsg = await addMessage(conv.id, "user", "do a multi-step task");
    const retained = await addMessage(
      conv.id,
      "assistant",
      JSON.stringify([{ type: "text", text: "first assistant segment" }]),
    );
    const mergedAway = await addMessage(
      conv.id,
      "assistant",
      JSON.stringify([{ type: "text", text: "second assistant segment" }]),
    );

    await resetMemoryJobs();
    const didConsolidate = await consolidateAssistantMessages(
      conv.id,
      userMsg.id,
    );
    expect(didConsolidate).toBe(true);

    // The retained (first) assistant row is reindexed with the merged content.
    expect(await lexicalJobMessageIds()).toContain(retained.id);
    // The merged-away row's point is removed via delete_message_lexical.
    const deletedIds = (await rowsOfType("delete_message_lexical")).map(
      (r) => (JSON.parse(r.payload) as { messageId?: string }).messageId,
    );
    expect(deletedIds).toContain(mergedAway.id);
    // The retained row is not itself scheduled for deletion.
    expect(deletedIds).not.toContain(retained.id);
  });
});

// Whole-conversation deletes must dispatch the `conversation-deleted` hook
// from the shared `deleteConversation`/`deleteConversationGently` primitive
// (covering every caller, not just the HTTP route). Captured through a
// registered test hook — the same chain a user plugin would subscribe on.
describePg("delete paths dispatch the conversation-deleted hook", () => {
  const deletedConversations: string[] = [];

  beforeAll(() => {
    registerPluginHooks("test-conversation-deleted-capture", {
      "conversation-deleted": async (ctx: { conversationId: string }) => {
        deletedConversations.push(ctx.conversationId);
      },
    } as PluginHooks);
  });

  afterAll(() => {
    unregisterPluginHooks("test-conversation-deleted-capture");
  });

  beforeEach(async () => {
    await resetMemoryJobs();
    deletedConversations.length = 0;
  });

  test("deleteConversation dispatches conversation-deleted (covers all callers, not just the route)", async () => {
    const conv = await createConversation("Hook conversation delete");
    await addMessage(conv.id, "user", "hello");

    await deleteConversation(conv.id);

    // The dispatch is fire-and-forget; wait for the chain to land.
    const seen = await waitFor(() =>
      deletedConversations.includes(conv.id) ? true : undefined,
    );
    expect(seen).toBe(true);
  });

  test("deleteConversationGently dispatches conversation-deleted (the retrospective-GC path)", async () => {
    const conv = await createConversation("Hook gentle delete");
    await addMessage(conv.id, "user", "hello");

    await deleteConversationGently(conv.id);

    const seen = await waitFor(() =>
      deletedConversations.includes(conv.id) ? true : undefined,
    );
    expect(seen).toBe(true);
  });
});
