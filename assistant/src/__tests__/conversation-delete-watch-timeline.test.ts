/**
 * A watch session's timeline is the most sensitive thing a conversation owns:
 * what the user narrated, and frames of their screen while they narrated it.
 * Both live in the timeline row, so every path that removes a conversation has
 * to take those rows with it.
 *
 * `clearAll` is the sharpest case. Its bulk deletes run in a sqlite3
 * subprocess, so the daemon's event loop is free between them and an append
 * can land mid-wipe. The timeline purge is the wipe's last statement, after
 * `conversations` is emptied: an append that beat it is a row it deletes, and
 * one that follows it has no conversation to key itself to.
 */
import { expect, mock, setDefaultTimeout, test } from "bun:test";

// Keep the rest of the module real; only the Qdrant collection drop is
// replaced, so `clearAll` does not reach for a lexical index that is not
// running here.
const actualLexical =
  await import("../persistence/job-handlers/message-lexical.js");
mock.module("../persistence/job-handlers/message-lexical.js", () => ({
  ...actualLexical,
  clearMessagesLexicalIndex: async () => {},
}));

/**
 * An append to run from inside the wipe, on the statement it is keyed to.
 *
 * Which interleaving a race test runs is otherwise up to whichever subprocess
 * happens to be slow, and the interleaving that matters is a narrow one: the
 * append has to write its row while `conversations` is still populated, so its
 * own existence check has nothing to catch and only the wipe's ordering keeps
 * the row from outliving the wipe.
 */
let appendDuringWipe: { onStatement: string; run: () => void } | null = null;

// Every bulk delete in `clearAll` goes through `runAsyncSqlite`, which spawns
// a sqlite3 subprocess and yields the event loop. The wrapper runs the real
// statement and stands in for whatever else the daemon would have done while
// it was in flight.
const actualAsyncQuery = await import("../persistence/db-async-query.js");
const realRunAsyncSqlite = actualAsyncQuery.runAsyncSqlite;
mock.module("../persistence/db-async-query.js", () => ({
  ...actualAsyncQuery,
  runAsyncSqlite: async (
    sql: string,
    label: string,
    options?: Parameters<typeof actualAsyncQuery.runAsyncSqlite>[2],
  ) => {
    const result = await realRunAsyncSqlite(sql, label, options);
    if (appendDuringWipe && appendDuringWipe.onStatement === sql) {
      const pending = appendDuringWipe;
      appendDuringWipe = null;
      pending.run();
    }
    return result;
  },
}));

import {
  clearAll,
  createConversation,
  deleteConversation,
  deleteConversationGently,
} from "../persistence/conversation-crud.js";
import { requireMainDb } from "../persistence/db-facade.js";
import { initializeDb } from "../persistence/db-init.js";
import { attachments } from "../persistence/pg-schema/index.js";
import type { WatchAppendResult } from "../watch/watch-timeline.js";
import {
  appendNarration,
  appendObservation,
  readWatchScreenshot,
  renderWatchTimeline,
} from "../watch/watch-timeline.js";
import { describePg } from "./pg-test-db.js";

await initializeDb();

/** A 1x1 JPEG, the shape the host hands over on every observe. */
const SCREENSHOT_BASE64 =
  "/9j/4AAQSkZJRgABAQEAYABgAAD/2wBDAAgGBgcGBQgHBwcJCQgKDBQNDAsLDBkSEw8UHRofHh0aHBwgJC4nICIsIxwcKDcpLDAxNDQ0Hyc5PTgyPC4zNDL/2wBDAQkJCQwLDBgNDRgyIRwhMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjL/wAARCAABAAEDASIAAhEBAxEB/8QAHwAAAQUBAQEBAQEAAAAAAAAAAAECAwQFBgcICQoL/8QAtRAAAgEDAwIEAwUFBAQAAAF9AQIDAAQRBRIhMUEGE1FhByJxFDKBkaEII0KxwRVS0fAkM2JyggkKFhcYGRolJicoKSo0NTY3ODk6Q0RFRkdISUpTVFVWV1hZWmNkZWZnaGlqc3R1dnd4eXqDhIWGh4iJipKTlJWWl5iZmqKjpKWmp6ipqrKztLW2t7i5usLDxMXGx8jJytLT1NXW19jZ2uHi4+Tl5ufo6erx8vP09fb3+Pn6/8QAHwEAAwEBAQEBAQEBAQAAAAAAAAECAwQFBgcICQoL/8QAtREAAgECBAQDBAcFBAQAAQJ3AAECAxEEBSExBhJBUQdhcRMiMoEIFEKRobHBCSMzUvAVYnLRChYkNOEl8RcYGRomJygpKjU2Nzg5OkNERUZHSElKU1RVVldYWVpjZGVmZ2hpanN0dXZ3eHl6goOEhYaHiImKkpOUlZaXmJmaoqOkpaanqKmqsrO0tba3uLm6wsPExcbHyMnK0tPU1dbX2Nna4uPk5ebn6Onq8vP09fb3+Pn6/9oADAMBAAIRAxEAPwD3+iiigD//2Q==";

interface WatchedConversation {
  readonly conversationId: string;
  readonly sessionId: string;
  readonly entryId: string;
}

/** A conversation with one narration and one screenshot-carrying observation. */
async function seedWatchedConversation(
  title: string,
): Promise<WatchedConversation> {
  const conversation = await createConversation(title);
  const sessionId = `watch-${conversation.id}`;

  appendObservation(sessionId, {
    conversationId: conversation.id,
    atMs: 1_000,
    observation: { axTree: "window Mail", screenshot: SCREENSHOT_BASE64 },
    attachScreenshot: true,
  });
  appendNarration(sessionId, {
    conversationId: conversation.id,
    atMs: 2_000,
    text: "this is how I file it",
  });

  const rendered = renderWatchTimeline(sessionId);
  expect(rendered.totalEntries).toBe(2);
  const entryId = rendered.screenshotEntryIds[0];
  expect(entryId).toBeDefined();
  expect(readWatchScreenshot(entryId as string)).not.toBeNull();

  return { conversationId: conversation.id, sessionId, entryId: entryId ?? "" };
}

async function expectPurged(watched: WatchedConversation): Promise<void> {
  expect(renderWatchTimeline(watched.sessionId).totalEntries).toBe(0);
  expect(readWatchScreenshot(watched.entryId)).toBeNull();
}

/** Every attachment row in the store. */
async function attachmentCount(): Promise<number> {
  return (
    await requireMainDb().orm.select({ id: attachments.id }).from(attachments)
  ).length;
}

describePg("deleteConversation purges the watch timeline", () => {
  test("takes the entries and the frames they carry", async () => {
    const watched = await seedWatchedConversation("watched-sync");
    const other = await seedWatchedConversation("watched-sync-other");

    // A timeline keeps its screenshots in its own rows, so watching a session
    // stages nothing in the attachment store for a delete to chase.
    expect(await attachmentCount()).toBe(0);

    await deleteConversation(watched.conversationId);

    await expectPurged(watched);
    // Scoped to the conversation being deleted, not the whole store.
    expect(renderWatchTimeline(other.sessionId).totalEntries).toBe(2);
    expect(readWatchScreenshot(other.entryId)).not.toBeNull();
  });
});

describePg("deleteConversationGently purges the watch timeline", () => {
  test("the off-loop path clears the same state as the synchronous one", async () => {
    const watched = await seedWatchedConversation("watched-gentle");

    await deleteConversationGently(watched.conversationId);

    await expectPurged(watched);
  });
});

describePg("an append that lands after the delete", () => {
  test("is refused and leaves no row", async () => {
    const watched = await seedWatchedConversation("watched-late-append");

    await deleteConversation(watched.conversationId);
    const result = appendObservation(watched.sessionId, {
      conversationId: watched.conversationId,
      atMs: 3_000,
      observation: { axTree: "window Mail", screenshot: SCREENSHOT_BASE64 },
      attachScreenshot: true,
    });

    expect(result).toEqual({ ok: false, reason: "conversation_missing" });
    expect(renderWatchTimeline(watched.sessionId).totalEntries).toBe(0);
  });
});

describePg("clearAll purges every watch timeline", () => {
  test("wipes the entries and the frames they carry", async () => {
    const first = await seedWatchedConversation("watched-clear-all-a");
    const second = await seedWatchedConversation("watched-clear-all-b");

    await clearAll();

    await expectPurged(first);
    await expectPurged(second);
  });
});

describePg("an append that lands inside a clear-all", () => {
  test("does not outlive the wipe that overtook it", async () => {
    const watched = await seedWatchedConversation("watched-clear-all-race");

    // The append runs where the wipe is most exposed: mid-sequence, with
    // `conversations` still populated so its existence check has nothing to
    // catch. Only the timeline purge coming after `conversations` keeps the
    // row from surviving.
    let landed: WatchAppendResult | null = null;
    appendDuringWipe = {
      onStatement: "DELETE FROM messages",
      run: () => {
        landed = appendObservation(watched.sessionId, {
          conversationId: watched.conversationId,
          atMs: 3_000,
          observation: {
            axTree: "window Mail",
            screenshot: SCREENSHOT_BASE64,
          },
          attachScreenshot: true,
        });
      },
    };

    await clearAll();

    // The row really did land, so the wipe had something to sweep.
    const result = landed as WatchAppendResult | null;
    expect(result?.ok).toBe(true);
    expect(renderWatchTimeline(watched.sessionId).totalEntries).toBe(0);
    expect(
      readWatchScreenshot(result?.ok === true ? result.entryId : ""),
    ).toBeNull();
  });
});

describePg("an append that arrives once the clear-all is done", () => {
  test("is refused, because there is no conversation left to key it to", async () => {
    const watched = await seedWatchedConversation("watched-clear-all-after");

    await clearAll();
    const result = appendNarration(watched.sessionId, {
      conversationId: watched.conversationId,
      atMs: 3_000,
      text: "too late",
    });

    expect(result).toEqual({ ok: false, reason: "conversation_missing" });
    expect(renderWatchTimeline(watched.sessionId).totalEntries).toBe(0);
  });
});

setDefaultTimeout(30_000);
