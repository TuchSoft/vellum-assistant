import { randomUUID } from "node:crypto";
import { describe, expect, setDefaultTimeout, test } from "bun:test";

setDefaultTimeout(60_000);

import {
  createConversation,
  deleteConversation,
} from "../../persistence/conversation-crud.js";
import { requireMainDb } from "../../persistence/db-facade.js";
import { initializeDb } from "../../persistence/db-init.js";
import {
  appendNarration,
  appendObservation,
  DEFAULT_MAX_AX_TREES,
  DEFAULT_MAX_ENTRIES,
  DEFAULT_MAX_RENDER_BYTES,
  drainOrphanedWatchTimelineEntries,
  purgeAllWatchTimelines,
  purgeWatchTimelineForConversation,
  readWatchScreenshot,
  renderWatchTimeline,
  sweepOrphanedWatchTimelineEntries,
  WATCH_SCREENSHOT_MIME,
} from "../watch-timeline.js";

await initializeDb();

/** A 1x1 JPEG, the shape the host hands over on every observe. */
const SCREENSHOT_BASE64 =
  "/9j/4AAQSkZJRgABAQEAYABgAAD/2wBDAAgGBgcGBQgHBwcJCQgKDBQNDAsLDBkSEw8UHRofHh0aHBwgJC4nICIsIxwcKDcpLDAxNDQ0Hyc5PTgyPC4zNDL/2wBDAQkJCQwLDBgNDRgyIRwhMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjL/wAARCAABAAEDASIAAhEBAxEB/8QAHwAAAQUBAQEBAQEAAAAAAAAAAAECAwQFBgcICQoL/8QAtRAAAgEDAwIEAwUFBAQAAAF9AQIDAAQRBRIhMUEGE1FhByJxFDKBkaEII0KxwRVS0fAkM2JyggkKFhcYGRolJicoKSo0NTY3ODk6Q0RFRkdISUpTVFVWV1hZWmNkZWZnaGlqc3R1dnd4eXqDhIWGh4iJipKTlJWWl5iZmqKjpKWmp6ipqrKztLW2t7i5usLDxMXGx8jJytLT1NXW19jZ2uHi4+Tl5ufo6erx8vP09fb3+Pn6/8QAHwEAAwEBAQEBAQEBAQAAAAAAAAECAwQFBgcICQoL/8QAtREAAgECBAQDBAcFBAQAAQJ3AAECAxEEBSExBhJBUQdhcRMiMoEIFEKRobHBCSMzUvAVYnLRChYkNOEl8RcYGRomJygpKjU2Nzg5OkNERUZHSElKU1RVVldYWVpjZGVmZ2hpanN0dXZ3eHl6goOEhYaHiImKkpOUlZaXmJmaoqOkpaanqKmqsrO0tba3uLm6wsPExcbHyMnK0tPU1dbX2Nna4uPk5ebn6Onq8vP09fb3+Pn6/9oADAMBAAIRAxEAPwD3+iiigD//2Q==";

const SCREENSHOT_BYTES = Buffer.from(SCREENSHOT_BASE64, "base64");

/**
 * A fresh session against a real conversation row, so entries from one test are
 * invisible to the next and appends are not refused as orphans.
 */
async function newSession() {
  const conversation = await createConversation(`watch-${randomUUID()}`);
  return { sessionId: randomUUID(), conversationId: conversation.id };
}

/** A fresh session against a real conversation row, so entries from one test are
 * invisible to the next and appends are not refused as orphans. */
describe("watch timeline", () => {
  test("reads entries back in timestamp order, not append order", async () => {
    const { sessionId, conversationId } = await newSession();

    await appendObservation(sessionId, {
      conversationId,
      atMs: 4_000,
      observation: { axTree: "window Mail" },
    });
    await appendNarration(sessionId, {
      conversationId,
      atMs: 2_000,
      text: "this is the inbox",
    });
    await appendNarration(sessionId, {
      conversationId,
      atMs: 12_000,
      text: "and this is where I file it",
    });

    const rendered = await renderWatchTimeline(sessionId);

    expect(rendered.entries.map((e) => e.atMs)).toEqual([2_000, 4_000, 12_000]);
    expect(rendered.totalEntries).toBe(3);
    expect(rendered.truncated).toBe(false);
    expect(rendered.text).toContain("[t+00:02] narration: this is the inbox");
    expect(rendered.text).toContain("[t+00:04] screen:");
    expect(rendered.text).toContain("<ax-tree>\nwindow Mail\n</ax-tree>");
    expect(rendered.text.indexOf("[t+00:04]")).toBeGreaterThan(
      rendered.text.indexOf("[t+00:02]"),
    );
    expect(rendered.text.indexOf("[t+00:12]")).toBeGreaterThan(
      rendered.text.indexOf("[t+00:04]"),
    );
  });

  test("renders hours only once the session has any", async () => {
    const { sessionId, conversationId } = await newSession();
    await appendNarration(sessionId, {
      conversationId,
      atMs: 3_723_000,
      text: "still going",
    });

    expect((await renderWatchTimeline(sessionId)).text).toContain(
      "[t+01:02:03]",
    );
  });

  test("appends nothing for an observation that failed", async () => {
    const { sessionId, conversationId } = await newSession();

    const result = await appendObservation(sessionId, {
      conversationId,
      atMs: 1_000,
      observation: {
        axTree: "window Mail",
        screenshot: SCREENSHOT_BASE64,
        executionError: "screen recording permission denied",
      },
      attachScreenshot: true,
    });

    expect(result).toEqual({ ok: false, reason: "observation_failed" });
    expect((await renderWatchTimeline(sessionId)).totalEntries).toBe(0);
  });

  test("appends nothing for a screenshot the caller did not ask to keep", async () => {
    const { sessionId, conversationId } = await newSession();

    const result = await appendObservation(sessionId, {
      conversationId,
      atMs: 1_000,
      observation: { screenshot: SCREENSHOT_BASE64 },
    });

    expect(result).toEqual({ ok: false, reason: "empty" });
    expect((await renderWatchTimeline(sessionId)).totalEntries).toBe(0);
  });

  test("keeps a screenshot-only observation the host fell back to", async () => {
    // No focused window means no AX tree, and the host answers with a bare
    // screenshot. Discarding that would leave a session spent in an
    // inaccessible app with an entirely empty timeline.
    const { sessionId, conversationId } = await newSession();

    const result = await appendObservation(sessionId, {
      conversationId,
      atMs: 1_000,
      observation: { screenshot: SCREENSHOT_BASE64 },
      attachScreenshot: true,
    });

    expect(result.ok).toBe(true);

    const rendered = await renderWatchTimeline(sessionId);
    expect(rendered.totalEntries).toBe(1);
    expect(rendered.screenshotEntryIds).toHaveLength(1);
    expect(rendered.text).toContain("[t+00:01] screen:");
    // The retrospective can tell a screen it cannot read from a screen with
    // nothing on it, and knows an image of it exists.
    expect(rendered.text).toContain("<ax-tree-unavailable />");
    expect(rendered.text).toContain(
      "a screenshot of this moment was captured.",
    );
  });

  test("appends nothing for a narration that is only whitespace", async () => {
    const { sessionId, conversationId } = await newSession();

    const result = await appendNarration(sessionId, {
      conversationId,
      atMs: 1_000,
      text: "   \n ",
    });

    expect(result).toEqual({ ok: false, reason: "empty" });
    expect((await renderWatchTimeline(sessionId)).totalEntries).toBe(0);
  });

  test("stores a screenshot only when attachScreenshot asks for it", async () => {
    const { sessionId, conversationId } = await newSession();
    const observation = {
      axTree: "window Mail",
      screenshot: SCREENSHOT_BASE64,
    };

    await appendObservation(sessionId, {
      conversationId,
      atMs: 1_000,
      observation,
    });
    await appendObservation(sessionId, {
      conversationId,
      atMs: 2_000,
      observation,
      attachScreenshot: false,
    });
    await appendObservation(sessionId, {
      conversationId,
      atMs: 3_000,
      observation,
      attachScreenshot: true,
    });

    const rendered = await renderWatchTimeline(sessionId);
    expect(rendered.entries.map((e) => e.screenshotBytes)).toEqual([
      null,
      null,
      SCREENSHOT_BYTES.length,
    ]);
    expect(rendered.screenshotEntryIds).toEqual([
      rendered.entries[2]?.id as string,
    ]);
    expect(rendered.text).toContain(
      "a screenshot of this moment was captured.",
    );
  });

  test("hands back the exact frame the observation carried", async () => {
    const { sessionId, conversationId } = await newSession();
    await appendObservation(sessionId, {
      conversationId,
      atMs: 1_000,
      observation: { axTree: "window Mail", screenshot: SCREENSHOT_BASE64 },
      attachScreenshot: true,
    });

    const [entryId] = (await renderWatchTimeline(sessionId)).screenshotEntryIds;

    const frame = await readWatchScreenshot(entryId as string);
    expect(frame?.mimeType).toBe(WATCH_SCREENSHOT_MIME);
    expect(Buffer.from(frame?.bytes as Buffer)).toEqual(SCREENSHOT_BYTES);
  });

  test("has no frame to hand back for an entry that carries none", async () => {
    const { sessionId, conversationId } = await newSession();
    await appendNarration(sessionId, {
      conversationId,
      atMs: 1_000,
      text: "hello",
    });

    const [entry] = (await renderWatchTimeline(sessionId)).entries;

    expect(await readWatchScreenshot(entry?.id as string)).toBeNull();
    expect(await readWatchScreenshot("no-such-entry")).toBeNull();
  });

  test("drops a frame over the per-entry size cap and keeps the rest", async () => {
    const { sessionId, conversationId } = await newSession();
    const oversized = Buffer.alloc(2_000_001, 0x41).toString("base64");

    const result = await appendObservation(sessionId, {
      conversationId,
      atMs: 1_000,
      observation: { axTree: "window Mail", screenshot: oversized },
      attachScreenshot: true,
    });

    expect(result.ok).toBe(true);
    const rendered = await renderWatchTimeline(sessionId);
    expect(rendered.entries[0]?.screenshotBytes).toBeNull();
    expect(rendered.screenshotEntryIds).toHaveLength(0);
    expect(rendered.text).toContain("<ax-tree>\nwindow Mail\n</ax-tree>");
  });

  test("refuses an observation whose only content is an oversized frame", async () => {
    const { sessionId, conversationId } = await newSession();
    const oversized = Buffer.alloc(2_000_001, 0x41).toString("base64");

    const result = await appendObservation(sessionId, {
      conversationId,
      atMs: 1_000,
      observation: { screenshot: oversized },
      attachScreenshot: true,
    });

    expect(result).toEqual({ ok: false, reason: "empty" });
    expect((await renderWatchTimeline(sessionId)).totalEntries).toBe(0);
  });

  test("bounds the rendered entries by default and reports the truncation", async () => {
    const { sessionId, conversationId } = await newSession();
    const total = DEFAULT_MAX_ENTRIES + 5;
    for (let i = 0; i < total; i++) {
      await appendNarration(sessionId, {
        conversationId,
        atMs: i * 1_000,
        text: `line ${i}`,
      });
    }

    const rendered = await renderWatchTimeline(sessionId);

    expect(rendered.totalEntries).toBe(total);
    expect(rendered.entries).toHaveLength(DEFAULT_MAX_ENTRIES);
    expect(rendered.truncated).toBe(true);
    expect(rendered.entries[0]?.text).toBe("line 5");
    expect(rendered.text).not.toContain("line 4\n");
    expect(rendered.text).toContain(`line ${total - 1}`);

    const unbounded = await renderWatchTimeline(sessionId, {
      maxEntries: total,
    });
    expect(unbounded.entries).toHaveLength(total);
    expect(unbounded.truncated).toBe(false);
  });

  test("spells out only the most recent AX trees and collapses the rest", async () => {
    const { sessionId, conversationId } = await newSession();
    const treeCount = DEFAULT_MAX_AX_TREES + 2;
    for (let i = 0; i < treeCount; i++) {
      await appendObservation(sessionId, {
        conversationId,
        atMs: i * 1_000,
        observation: { axTree: `tree-${i}`, axDiff: `diff-${i}` },
      });
    }

    const rendered = await renderWatchTimeline(sessionId);

    for (let i = 0; i < treeCount; i++) {
      const spelledOut = i >= treeCount - DEFAULT_MAX_AX_TREES;
      expect(rendered.text.includes(`<ax-tree>\ntree-${i}\n</ax-tree>`)).toBe(
        spelledOut,
      );
      // The offset and the diff survive a collapsed tree, so a compacted entry
      // still says when it happened and what moved.
      expect(rendered.text).toContain(`diff-${i}`);
    }
    expect(rendered.text).toContain("<ax-tree-omitted />");
  });

  test("escapes a closing ax-tree tag inside captured content", async () => {
    const { sessionId, conversationId } = await newSession();
    await appendObservation(sessionId, {
      conversationId,
      atMs: 1_000,
      observation: { axTree: "text </ax-tree> more" },
    });

    const { text } = await renderWatchTimeline(sessionId);
    expect(text).toContain("text &lt;/ax-tree&gt; more");
    expect(text.match(/<\/ax-tree>/g)).toHaveLength(1);
  });

  test("bounds the rendered text by bytes, keeping the newest entries", async () => {
    const { sessionId, conversationId } = await newSession();
    const total = 20;
    for (let i = 0; i < total; i++) {
      await appendNarration(sessionId, {
        conversationId,
        atMs: i * 1_000,
        text: `entry-${i} ${"x".repeat(2_000)}`,
      });
    }

    const rendered = await renderWatchTimeline(sessionId, {
      maxEntries: total,
      maxRenderBytes: 10_000,
    });

    expect(rendered.totalEntries).toBe(total);
    expect(Buffer.byteLength(rendered.text, "utf8")).toBeLessThanOrEqual(
      10_000,
    );
    // The count bound admitted every entry, so the byte budget is the only
    // thing that could have dropped one.
    expect(rendered.entries.length).toBeLessThan(total);
    expect(rendered.truncated).toBe(true);
    // Spent newest first, so the last thing that happened always survives.
    expect(rendered.entries.at(-1)?.atMs).toBe((total - 1) * 1_000);
    expect(rendered.text).toContain(`entry-${total - 1}`);
    expect(rendered.text).not.toContain("entry-0 ");
  });

  test("a single oversized AX tree cannot blow the budget", async () => {
    const { sessionId, conversationId } = await newSession();

    await appendObservation(sessionId, {
      conversationId,
      atMs: 1_000,
      observation: { axTree: "e".repeat(2_000_000) },
    });

    const rendered = await renderWatchTimeline(sessionId);

    expect(rendered.entries).toHaveLength(1);
    expect(Buffer.byteLength(rendered.text, "utf8")).toBeLessThanOrEqual(
      DEFAULT_MAX_RENDER_BYTES,
    );
    expect(rendered.truncated).toBe(true);
    // Clipped in place rather than dropped, and the wrapper still closes so the
    // block reads as one tree.
    expect(rendered.text).toContain("[truncated]");
    expect(rendered.text).toContain("<ax-tree>");
    expect(rendered.text.match(/<\/ax-tree>/g)).toHaveLength(1);
  });

  test("gives up the tree before the offset and the diff", async () => {
    const { sessionId, conversationId } = await newSession();

    await appendObservation(sessionId, {
      conversationId,
      atMs: 1_000,
      observation: { axTree: "e".repeat(50_000), axDiff: "row added" },
    });

    const rendered = await renderWatchTimeline(sessionId, {
      maxRenderBytes: 320,
    });

    expect(rendered.text).toContain("[t+00:01] screen:");
    expect(rendered.text).toContain("row added");
    expect(rendered.text).not.toContain("e".repeat(1_000));
    expect(rendered.truncated).toBe(true);
  });

  test("reports nothing truncated when everything fits", async () => {
    const { sessionId, conversationId } = await newSession();
    await appendNarration(sessionId, {
      conversationId,
      atMs: 1_000,
      text: "short enough",
    });

    expect((await renderWatchTimeline(sessionId)).truncated).toBe(false);
  });

  test("bounds the read itself, not a slice of the whole session", async () => {
    const { sessionId, conversationId } = await newSession();
    const total = 12;
    for (let i = 0; i < total; i++) {
      await appendNarration(sessionId, {
        conversationId,
        atMs: i * 1_000,
        text: `line ${i}`,
      });
    }

    const rendered = await renderWatchTimeline(sessionId, {
      maxEntries: 3,
    });

    // The entries the render reasoned over are the newest three, and the count
    // it reports is the session's real one rather than what it read.
    expect(rendered.entries.map((e) => e.text)).toEqual([
      "line 9",
      "line 10",
      "line 11",
    ]);
    expect(rendered.totalEntries).toBe(total);
    expect(rendered.truncated).toBe(true);
  });

  test("reports the true total when the count bound admits nothing", async () => {
    const { sessionId, conversationId } = await newSession();
    await appendNarration(sessionId, {
      conversationId,
      atMs: 1_000,
      text: "hello",
    });

    const rendered = await renderWatchTimeline(sessionId, { maxEntries: 0 });

    expect(rendered.entries).toHaveLength(0);
    expect(rendered.totalEntries).toBe(1);
    expect(rendered.truncated).toBe(true);
  });

  test("refuses an append whose conversation is gone", async () => {
    const { sessionId, conversationId } = await newSession();
    await deleteConversation(conversationId);

    const result = await appendNarration(sessionId, {
      conversationId,
      atMs: 1_000,
      text: "too late",
    });

    expect(result).toEqual({ ok: false, reason: "conversation_missing" });
    expect((await renderWatchTimeline(sessionId)).totalEntries).toBe(0);
  });

  test("purges a conversation's rows and the frames they carry", async () => {
    const { sessionId, conversationId } = await newSession();
    const other = await newSession();

    await appendObservation(sessionId, {
      conversationId,
      atMs: 1_000,
      observation: { axTree: "window Mail", screenshot: SCREENSHOT_BASE64 },
      attachScreenshot: true,
    });
    await appendNarration(sessionId, {
      conversationId,
      atMs: 2_000,
      text: "filing it here",
    });
    await appendNarration(other.sessionId, {
      conversationId: other.conversationId,
      atMs: 1_000,
      text: "a different conversation",
    });

    const [entryId] = (await renderWatchTimeline(sessionId)).screenshotEntryIds;
    expect(await readWatchScreenshot(entryId as string)).not.toBeNull();

    expect(await purgeWatchTimelineForConversation(conversationId)).toBe(2);

    expect((await renderWatchTimeline(sessionId)).totalEntries).toBe(0);
    expect(await readWatchScreenshot(entryId as string)).toBeNull();
    expect((await renderWatchTimeline(other.sessionId)).totalEntries).toBe(1);
  });

  test("purges every session's rows and frames", async () => {
    const first = await newSession();
    const second = await newSession();

    for (const session of [first, second]) {
      await appendObservation(session.sessionId, {
        conversationId: session.conversationId,
        atMs: 1_000,
        observation: { axTree: "window Mail", screenshot: SCREENSHOT_BASE64 },
        attachScreenshot: true,
      });
    }

    const entryIds = await Promise.all(
      [first, second].map(
        async (session) =>
          (await renderWatchTimeline(session.sessionId)).screenshotEntryIds[0],
      ),
    );
    for (const id of entryIds) {
      expect(await readWatchScreenshot(id as string)).not.toBeNull();
    }

    expect(await purgeAllWatchTimelines()).toBeGreaterThanOrEqual(2);

    expect((await renderWatchTimeline(first.sessionId)).totalEntries).toBe(0);
    expect((await renderWatchTimeline(second.sessionId)).totalEntries).toBe(0);
    for (const id of entryIds) {
      expect(await readWatchScreenshot(id as string)).toBeNull();
    }
  });
});

describe("watch timeline orphan sweep", () => {
  /**
   * Delete the conversation row without going through `deleteConversation`,
   * which purges the timeline on its way out. This is the state a purge that
   * failed after the row was committed as deleted leaves behind, and the state
   * a crash between the two writes leaves behind.
   */
  async function orphanConversation(conversationId: string): Promise<void> {
    await requireMainDb().run("DELETE FROM conversations WHERE id = ?", [
      conversationId,
    ]);
  }

  test("drains a backlog larger than one sweep page", async () => {
    // A single sweep is deliberately one page. Startup drains, because on an
    // install where database maintenance never runs it is the only pass the
    // residue will ever see.
    await drainOrphanedWatchTimelineEntries();

    const { sessionId, conversationId } = await newSession();
    const PAGE = 5_000;
    // More than two pages on purpose: with a single leftover page, a `drain`
    // that never looped would still clear the remainder in its one sweep and
    // the test would pass without exercising the loop at all.
    const TOTAL = PAGE * 2 + 25;
    const db = requireMainDb();
    await db.transaction(async (tx) => {
      for (let i = 0; i < TOTAL; i += 1) {
        await tx.run(
          "INSERT INTO watch_timeline_entries (id, session_id, conversation_id, at_ms, kind, text, created_at) VALUES (?, ?, ?, ?, 'narration', ?, ?)",
          [`drain-${i}`, sessionId, conversationId, i, "step", i],
        );
      }
    });
    await orphanConversation(conversationId);

    // One page, and the remainder is still there: this is what a single
    // startup sweep would have left behind for good.
    expect(await sweepOrphanedWatchTimelineEntries()).toBe(PAGE);
    expect(
      (
        await db.get<{ n: number }>(
          "SELECT count(*) AS n FROM watch_timeline_entries WHERE conversation_id = ?",
          [conversationId],
        )
      )?.n,
    ).toBe(TOTAL - PAGE);

    // The drain finishes the job, which takes two more pages.
    expect(await drainOrphanedWatchTimelineEntries()).toBe(TOTAL - PAGE);
    expect(
      (
        await db.get<{ n: number }>(
          "SELECT count(*) AS n FROM watch_timeline_entries WHERE conversation_id = ?",
          [conversationId],
        )
      )?.n,
    ).toBe(0);
  });

  test("sweeps entries whose conversation is gone, frames included", async () => {
    // Drain anything earlier tests orphaned so the count below is this
    // session's rows and nothing else.
    await sweepOrphanedWatchTimelineEntries();

    const { sessionId, conversationId } = await newSession();
    await appendObservation(sessionId, {
      conversationId,
      atMs: 1_000,
      observation: { axTree: "window Mail", screenshot: SCREENSHOT_BASE64 },
      attachScreenshot: true,
    });
    await appendNarration(sessionId, {
      conversationId,
      atMs: 2_000,
      text: "filing it here",
    });
    const [entryId] = (await renderWatchTimeline(sessionId)).screenshotEntryIds;
    expect(await readWatchScreenshot(entryId as string)).not.toBeNull();

    await orphanConversation(conversationId);

    expect(await sweepOrphanedWatchTimelineEntries()).toBe(2);
    expect((await renderWatchTimeline(sessionId)).totalEntries).toBe(0);
    expect(await readWatchScreenshot(entryId as string)).toBeNull();
  });

  test("leaves entries whose conversation still exists", async () => {
    await sweepOrphanedWatchTimelineEntries();

    const live = await newSession();
    const orphaned = await newSession();
    await appendNarration(live.sessionId, {
      conversationId: live.conversationId,
      atMs: 1_000,
      text: "still here",
    });
    await appendNarration(orphaned.sessionId, {
      conversationId: orphaned.conversationId,
      atMs: 1_000,
      text: "conversation deleted",
    });

    await orphanConversation(orphaned.conversationId);

    expect(await sweepOrphanedWatchTimelineEntries()).toBe(1);
    expect((await renderWatchTimeline(orphaned.sessionId)).totalEntries).toBe(
      0,
    );
    expect((await renderWatchTimeline(live.sessionId)).totalEntries).toBe(1);
  });

  test("reports nothing swept when there is nothing to sweep", async () => {
    await sweepOrphanedWatchTimelineEntries();

    expect(await sweepOrphanedWatchTimelineEntries()).toBe(0);
  });

  test("reports nothing swept rather than throwing when the table is gone", async () => {
    const db = requireMainDb();
    await db.exec(
      "ALTER TABLE watch_timeline_entries RENAME TO watch_timeline_entries_hidden",
    );
    try {
      expect(await sweepOrphanedWatchTimelineEntries()).toBe(0);
    } finally {
      await db.exec(
        "ALTER TABLE watch_timeline_entries_hidden RENAME TO watch_timeline_entries",
      );
    }
  });
});
