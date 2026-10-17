import { beforeEach, expect, test } from "bun:test";

import { describePg } from "../../../../__tests__/pg-test-db.js";
import { createConversation } from "../../../../persistence/conversation-crud.js";
import {
  buildExcerpt,
  buildRecallEvidenceExcerpt,
  countConversations,
  getMessageRoleStatsByConversation,
  listConversations,
  listConversationsBySource,
  listPinnedConversations,
  searchConversations,
} from "../../../../persistence/conversation-queries.js";
import { requireMainDb } from "../../../../persistence/db-facade.js";
import {
  appendContentDeltas,
  resolveContentRefPath,
} from "../../../../persistence/message-content-file.js";

async function resetTables(): Promise<void> {
  const db = requireMainDb();
  await db.run(`DELETE FROM messages`);
  await db.run(`DELETE FROM conversations`);
}

async function setConversationType(
  conversationId: string,
  type: string,
): Promise<void> {
  await requireMainDb().run(
    "UPDATE conversations SET conversation_type = ? WHERE id = ?",
    [type, conversationId],
  );
}

describe("buildExcerpt", () => {
  test("does not expose external_content tags for legacy plain-string rows", async () => {
    const excerpt = buildExcerpt(
      '<external_content source="slack">\nSearchable Slack text\n</external_content>',
      "external_content",
    );

    expect(excerpt).toBe("Searchable Slack text");
    expect(excerpt).not.toContain("<external_content");
    expect(excerpt).not.toContain("</external_content>");
  });

  test("does not expose external_content tags for legacy text block rows", async () => {
    const excerpt = buildExcerpt(
      JSON.stringify([
        {
          type: "text",
          text: '<external_content source="slack">\nSearchable block text\n</external_content>',
        },
      ]),
      "external_content",
    );

    expect(excerpt).toBe("Searchable block text");
    expect(excerpt).not.toContain("<external_content");
    expect(excerpt).not.toContain("</external_content>");
  });

  test("extracts thinking text instead of returning raw JSON", async () => {
    const excerpt = buildExcerpt(
      JSON.stringify([
        {
          type: "thinking",
          thinking: "A casual greeting, likely a reply to my earlier message",
          signature: "sig",
        },
      ]),
      "greeting",
    );

    expect(excerpt).toContain("casual greeting");
    expect(excerpt).not.toContain('[{"type"');
  });

  test("falls back to legible text when the query only matches JSON structure", async () => {
    const excerpt = buildExcerpt(
      JSON.stringify([
        { type: "thinking", thinking: "Plain reasoning text", signature: "s" },
      ]),
      "thinking",
    );

    expect(excerpt).toBe("Plain reasoning text");
  });

  test("extracts string-form tool_result content", async () => {
    const excerpt = buildExcerpt(
      JSON.stringify([
        {
          type: "tool_result",
          tool_use_id: "toolu_01",
          content: "Command output line",
        },
      ]),
      "output",
    );

    expect(excerpt).toBe("Command output line");
  });

  test("does not expose external_content tags for string-form tool_result content", async () => {
    const excerpt = buildExcerpt(
      JSON.stringify([
        {
          type: "tool_result",
          tool_use_id: "toolu_01",
          content:
            '<external_content source="slack">\nSearchable Slack text\n</external_content>',
        },
      ]),
      "Slack",
    );

    expect(excerpt).toContain("Searchable Slack text");
    expect(excerpt).not.toContain("<external_content");
  });

  test("extracts file block extracted_text", async () => {
    const excerpt = buildExcerpt(
      JSON.stringify([
        {
          type: "file",
          source: { type: "url", url: "https://example.com/report.pdf" },
          extracted_text: "Quarterly revenue grew nine percent",
        },
      ]),
      "revenue",
    );

    expect(excerpt).toBe("Quarterly revenue grew nine percent");
  });

  test("still extracts array-form tool_result inner text", async () => {
    const excerpt = buildExcerpt(
      JSON.stringify([
        {
          type: "tool_result",
          tool_use_id: "toolu_01",
          content: [{ type: "text", text: "Inner tool text" }],
        },
      ]),
      "Inner",
    );

    expect(excerpt).toBe("Inner tool text");
  });

  test("centers the excerpt on a token match when the query is not contiguous", async () => {
    const filler = "start padding ".repeat(25);
    const excerpt = buildExcerpt(
      JSON.stringify([
        { type: "text", text: `${filler}alpha and shortly after beta appear` },
      ]),
      "alpha beta",
    );

    expect(excerpt).toContain("alpha");
    expect(excerpt).toContain("beta");
    expect(excerpt.startsWith("…")).toBe(true);
  });

  test("keeps the match near the front of the display excerpt", async () => {
    const prefix = "p".repeat(200);
    const excerpt = buildExcerpt(
      JSON.stringify([{ type: "text", text: `${prefix} alpha trailing text` }]),
      "alpha",
    );

    const alphaIndex = excerpt.indexOf("alpha");
    expect(alphaIndex).toBeGreaterThan(0);
    expect(alphaIndex).toBeLessThanOrEqual(32);
  });

  test("whole-query matches also respect tokenizer boundaries", async () => {
    const filler = "party planning notes ".repeat(10);
    const excerpt = buildExcerpt(
      JSON.stringify([{ type: "text", text: `${filler}art supplies list` }]),
      "art",
    );

    expect(excerpt).toContain("art supplies");
  });

  test("ignores token substrings inside larger words when centering", async () => {
    const filler = "party planning notes ".repeat(10);
    const excerpt = buildExcerpt(
      JSON.stringify([{ type: "text", text: `${filler}alpha appears here` }]),
      "alpha art",
    );

    expect(excerpt).toContain("alpha");
  });

  test("keeps the excerpt window aligned when lowercasing changes string length", async () => {
    const prefix = "İ".repeat(120);
    const excerpt = buildExcerpt(
      JSON.stringify([
        { type: "text", text: `${prefix} alpha and beta follow` },
      ]),
      "alpha beta",
    );

    expect(excerpt).toContain("alpha");
    expect(excerpt).toContain("beta");
  });

  test("returns an empty excerpt for messages with no legible text", async () => {
    const excerpt = buildExcerpt(
      JSON.stringify([
        { type: "tool_use", id: "toolu_01", name: "bash", input: {} },
      ]),
      "bash",
    );

    expect(excerpt).toBe("");
  });

  test("returns an empty excerpt for non-block JSON objects", async () => {
    expect(buildExcerpt('{"foo":"bar"}', "foo")).toBe("");
  });

  test("returns an empty excerpt for unresolved content refs", async () => {
    const excerpt = buildExcerpt(
      JSON.stringify({ ref: "conversations/missing-conv/msg-1.jsonl" }),
      "anything",
    );

    expect(excerpt).toBe("");
  });

  test("folds and extracts text for resolvable content refs", async () => {
    const ref = "conversations/excerpt-test/msg-1.jsonl";
    const absPath = resolveContentRefPath(ref);
    expect(absPath).not.toBeNull();
    appendContentDeltas(absPath!, [
      {
        i: 0,
        seq: 1,
        block: { type: "text", text: "Folded delta text about pandas" },
      },
    ]);

    const excerpt = buildExcerpt(JSON.stringify({ ref }), "pandas");

    expect(excerpt).toBe("Folded delta text about pandas");
  });
});

describe("buildRecallEvidenceExcerpt", () => {
  test("preserves external_content boundaries for legacy plain-string rows", async () => {
    const excerpt = buildRecallEvidenceExcerpt(
      '<external_content source="slack" origin="@alice">\nSearchable Slack text\n</external_content>',
      "Slack",
    );

    expect(excerpt).toBe(
      '<external_content source="slack" origin="@alice">\nSearchable Slack text\n</external_content>',
    );
  });

  test("preserves external_content boundaries for legacy text block rows", async () => {
    const excerpt = buildRecallEvidenceExcerpt(
      JSON.stringify([
        {
          type: "text",
          text: '<external_content source="slack">\nSearchable block text\n</external_content>',
        },
      ]),
      "block",
    );

    expect(excerpt).toBe(
      '<external_content source="slack">\nSearchable block text\n</external_content>',
    );
  });

  test("preserves external_content boundaries when joined with other text blocks", async () => {
    const excerpt = buildRecallEvidenceExcerpt(
      JSON.stringify([
        {
          type: "text",
          text: '<external_content source="slack">\nSearchable block text\n</external_content>',
        },
        {
          type: "text",
          text: "Local follow-up text.",
        },
      ]),
      "block",
    );

    expect(excerpt).toBe(
      '<external_content source="slack">\nSearchable block text\n</external_content> Local follow-up text.',
    );
  });

  test("does not unwrap malformed or mixed external_content text", async () => {
    const malformed =
      '<external_content source="slack">Malformed Slack text</external_content>';
    const mixed =
      'prefix <external_content source="slack">\nMixed Slack text\n</external_content>';

    expect(buildRecallEvidenceExcerpt(malformed, "Slack")).toBe(malformed);
    expect(buildRecallEvidenceExcerpt(mixed, "Slack")).toBe(
      'prefix <external_content source="slack"> Mixed Slack text </external_content>',
    );
  });

  test("extracts thinking text for recall evidence", async () => {
    const excerpt = buildRecallEvidenceExcerpt(
      JSON.stringify([
        {
          type: "thinking",
          thinking: "Recall reasoning detail",
          signature: "s",
        },
      ]),
      "reasoning",
    );

    expect(excerpt).toBe("Recall reasoning detail");
  });

  test("preserves external_content boundaries for string-form tool_result content", async () => {
    const excerpt = buildRecallEvidenceExcerpt(
      JSON.stringify([
        {
          type: "tool_result",
          tool_use_id: "toolu_01",
          content:
            '<external_content source="slack">\nSearchable Slack text\n</external_content>',
        },
      ]),
      "Slack",
    );

    expect(excerpt).toBe(
      '<external_content source="slack">\nSearchable Slack text\n</external_content>',
    );
  });

  test("keeps the wide leading window for recall evidence", async () => {
    const prefix = "p".repeat(200);
    const excerpt = buildRecallEvidenceExcerpt(
      JSON.stringify([{ type: "text", text: `${prefix} alpha trailing text` }]),
      "alpha",
    );

    expect(excerpt.indexOf("alpha")).toBeGreaterThan(50);
  });

  test("keeps the raw fallback for messages with no legible text", async () => {
    const raw = JSON.stringify([
      { type: "tool_use", id: "toolu_01", name: "bash", input: {} },
    ]);

    const excerpt = buildRecallEvidenceExcerpt(raw, "bash");

    expect(excerpt).toContain("tool_use");
  });
});

describePg("countConversations", () => {
  beforeEach(async () => {
    await resetTables();
  });

  test("excludes 'private', 'background', and 'scheduled' rows from the foreground count", async () => {
    await createConversation("foreground-1");
    await createConversation("foreground-2");

    const priv = await createConversation("private-1");
    await setConversationType(priv.id, "private");

    await createConversation({ title: "bg-1", conversationType: "background" });
    await createConversation({
      title: "sched-1",
      conversationType: "scheduled",
    });

    expect(await countConversations()).toBe(2);
  });

  test("background-only count excludes private rows", async () => {
    await createConversation("foreground-1");
    await createConversation({ title: "bg-1", conversationType: "background" });
    await createConversation({
      title: "sched-1",
      conversationType: "scheduled",
    });

    const priv = await createConversation("private-1");
    await setConversationType(priv.id, "private");

    expect(await countConversations({ conversationType: "background" })).toBe(
      2,
    );
  });

  test("includes standard conversations with group_id system:background in background count", async () => {
    // GIVEN a standard conversation routed to system:background (e.g. heartbeat)
    await createConversation({
      title: "heartbeat-1",
      source: "heartbeat",
      groupId: "system:background",
    });

    // AND a regular foreground conversation
    await createConversation("foreground-1");

    // WHEN counting background conversations
    const bgCount = await countConversations({
      conversationType: "background",
    });

    // THEN the heartbeat conversation is included
    expect(bgCount).toBe(1);

    // AND excluded from the foreground count
    expect(await countConversations({ conversationType: "standard" })).toBe(1);
  });

  test("excludes standard conversations with group_id system:background from foreground count", async () => {
    // GIVEN two foreground conversations and one heartbeat
    await createConversation("foreground-1");
    await createConversation("foreground-2");
    await createConversation({
      title: "heartbeat-1",
      source: "heartbeat",
      groupId: "system:background",
    });

    // WHEN counting foreground conversations
    // THEN the heartbeat is excluded
    expect(await countConversations({ conversationType: "standard" })).toBe(2);
  });

  test('"scheduled" count returns only scheduled rows', async () => {
    // GIVEN one scheduled, one background, and one foreground conversation
    await createConversation({
      title: "sched-1",
      conversationType: "scheduled",
    });
    await createConversation({ title: "bg-1", conversationType: "background" });
    await createConversation("foreground-1");

    // WHEN counting scheduled conversations
    // THEN only the scheduled row is counted (background is excluded)
    expect(await countConversations({ conversationType: "scheduled" })).toBe(1);
  });

  describe("archiveStatus", () => {
    test("defaults to active — archived rows are excluded from the count", async () => {
      // GIVEN one live and one archived foreground conversation
      await createConversation("live-1");
      const archived = await createConversation("archived-1");
      await requireMainDb().run(
        "UPDATE conversations SET archived_at = ? WHERE id = ?",
        [Date.now(), archived.id],
      );

      expect(await countConversations()).toBe(1);
    });

    test('archiveStatus "archived" returns the archived count only', async () => {
      await createConversation("live-1");
      const a1 = await createConversation("archived-1");
      const a2 = await createConversation("archived-2");
      await requireMainDb().run(
        "UPDATE conversations SET archived_at = ? WHERE id IN (?, ?)",
        [Date.now(), a1.id, a2.id],
      );

      expect(
        await countConversations({
          conversationType: "standard",
          archiveStatus: "archived",
        }),
      ).toBe(2);
    });

    test('archiveStatus "all" returns both', async () => {
      await createConversation("live-1");
      const archived = await createConversation("archived-1");
      await requireMainDb().run(
        "UPDATE conversations SET archived_at = ? WHERE id = ?",
        [Date.now(), archived.id],
      );

      expect(
        await countConversations({
          conversationType: "standard",
          archiveStatus: "all",
        }),
      ).toBe(2);
    });
  });
});

describePg("listConversations", () => {
  beforeEach(async () => {
    await resetTables();
  });

  test("background fetch includes conversations with group_id system:background regardless of conversationType", async () => {
    // GIVEN a heartbeat conversation (conversationType standard, group_id system:background)
    await createConversation({
      title: "heartbeat-1",
      source: "heartbeat",
      groupId: "system:background",
    });

    // AND a real background conversation
    await createConversation({ title: "bg-1", conversationType: "background" });

    // AND a foreground conversation
    await createConversation("foreground-1");

    // WHEN listing background conversations
    const bgList = await listConversations({
      limit: 100,
      conversationType: "background",
    });

    // THEN both background and heartbeat conversations are returned
    expect(bgList).toHaveLength(2);
    const titles = bgList.map((c) => c.title);
    expect(titles).toContain("heartbeat-1");
    expect(titles).toContain("bg-1");
  });

  test("foreground fetch excludes conversations with group_id system:background", async () => {
    // GIVEN a heartbeat conversation (conversationType standard, group_id system:background)
    await createConversation({
      title: "heartbeat-1",
      source: "heartbeat",
      groupId: "system:background",
    });

    // AND a foreground conversation
    await createConversation("foreground-1");

    // WHEN listing foreground conversations
    const fgList = await listConversations({
      limit: 100,
      conversationType: "standard",
    });

    // THEN only the foreground conversation is returned
    expect(fgList).toHaveLength(1);
    expect(fgList[0]!.title).toBe("foreground-1");
  });

  test("conversations with group_id system:scheduled are included in background fetch", async () => {
    // GIVEN a conversation with group_id system:scheduled but conversationType standard
    const conv = await createConversation("schedule-routed");
    await requireMainDb().run(
      "UPDATE conversations SET group_id = 'system:scheduled' WHERE id = ?",
      [conv.id],
    );

    // WHEN listing background conversations
    const bgList = await listConversations({
      limit: 100,
      conversationType: "background",
    });

    // THEN it appears in the background list
    expect(bgList).toHaveLength(1);
    expect(bgList[0]!.title).toBe("schedule-routed");

    // AND not in the foreground list
    const fgList = await listConversations({
      limit: 100,
      conversationType: "standard",
    });
    expect(fgList).toHaveLength(0);
  });

  test('"scheduled" fetch returns only scheduled rows and excludes plain background', async () => {
    // GIVEN a scheduled conversation, a background conversation, and a foreground one
    await createConversation({
      title: "sched-1",
      conversationType: "scheduled",
    });
    await createConversation({ title: "bg-1", conversationType: "background" });
    await createConversation("foreground-1");

    // WHEN listing scheduled conversations
    const scheduledList = await listConversations({
      limit: 100,
      conversationType: "scheduled",
    });

    // THEN only the scheduled conversation is returned
    expect(scheduledList).toHaveLength(1);
    expect(scheduledList[0]!.title).toBe("sched-1");
  });

  test('"scheduled" fetch includes standard rows routed to group_id system:scheduled but not system:background', async () => {
    // GIVEN a standard conversation routed to system:scheduled
    const scheduledRouted = await createConversation("schedule-routed");
    await requireMainDb().run(
      "UPDATE conversations SET group_id = 'system:scheduled' WHERE id = ?",
      [scheduledRouted.id],
    );

    // AND a standard conversation routed to system:background
    const backgroundRouted = await createConversation("background-routed");
    await requireMainDb().run(
      "UPDATE conversations SET group_id = 'system:background' WHERE id = ?",
      [backgroundRouted.id],
    );

    // WHEN listing scheduled conversations
    const scheduledList = await listConversations({
      limit: 100,
      conversationType: "scheduled",
    });

    // THEN only the system:scheduled row appears
    expect(scheduledList).toHaveLength(1);
    expect(scheduledList[0]!.title).toBe("schedule-routed");
  });

  test('"scheduled" fetch excludes subagent runs', async () => {
    // GIVEN a scheduled conversation produced by a subagent
    await createConversation({
      title: "subagent-sched",
      conversationType: "scheduled",
      source: "subagent",
    });

    // WHEN listing scheduled conversations
    const scheduledList = await listConversations({
      limit: 100,
      conversationType: "scheduled",
    });

    // THEN the subagent run is excluded
    expect(scheduledList).toHaveLength(0);
  });

  describe("archiveStatus", () => {
    test("defaults to active — archived rows are excluded", async () => {
      // GIVEN a live conversation and an archived one
      await createConversation("live-1");
      const archived = await createConversation("archived-1");
      await requireMainDb().run(
        "UPDATE conversations SET archived_at = ? WHERE id = ?",
        [Date.now(), archived.id],
      );

      // WHEN listing without an explicit archiveStatus
      const rows = await listConversations({
        limit: 100,
        conversationType: "standard",
      });

      // THEN only the live conversation appears
      expect(rows).toHaveLength(1);
      expect(rows[0]!.title).toBe("live-1");
    });

    test('archiveStatus "archived" returns only archived rows', async () => {
      // GIVEN a live conversation and an archived one
      await createConversation("live-1");
      const archived = await createConversation("archived-1");
      await requireMainDb().run(
        "UPDATE conversations SET archived_at = ? WHERE id = ?",
        [Date.now(), archived.id],
      );

      // WHEN listing with archiveStatus "archived"
      const rows = await listConversations({
        limit: 100,
        conversationType: "standard",
        archiveStatus: "archived",
      });

      // THEN only the archived conversation appears
      expect(rows).toHaveLength(1);
      expect(rows[0]!.title).toBe("archived-1");
    });

    test('archiveStatus "all" returns both active and archived rows', async () => {
      // GIVEN a live conversation and an archived one
      await createConversation("live-1");
      const archived = await createConversation("archived-1");
      await requireMainDb().run(
        "UPDATE conversations SET archived_at = ? WHERE id = ?",
        [Date.now(), archived.id],
      );

      // WHEN listing with archiveStatus "all"
      const rows = await listConversations({
        limit: 100,
        conversationType: "standard",
        archiveStatus: "all",
      });

      // THEN both conversations appear
      expect(rows).toHaveLength(2);
      const titles = rows.map((c) => c.title);
      expect(titles).toContain("live-1");
      expect(titles).toContain("archived-1");
    });

    test('archiveStatus "archived" composes with background-only', async () => {
      // GIVEN an archived background conversation and an archived foreground one
      const archivedBg = await createConversation({
        title: "archived-bg",
        conversationType: "background",
      });
      const archivedFg = await createConversation("archived-fg");
      await requireMainDb().run(
        "UPDATE conversations SET archived_at = ? WHERE id IN (?, ?)",
        [Date.now(), archivedBg.id, archivedFg.id],
      );

      // WHEN listing archived background conversations
      const rows = await listConversations({
        limit: 100,
        conversationType: "background",
        archiveStatus: "archived",
      });

      // THEN only the archived background row appears
      expect(rows).toHaveLength(1);
      expect(rows[0]!.title).toBe("archived-bg");
    });
  });
});

describePg("listConversationsBySource", () => {
  beforeEach(async () => {
    await resetTables();
  });

  test("returns only conversations whose source matches exactly", async () => {
    await createConversation({
      title: "consol-1",
      source: "memory_v2_consolidation",
    });
    await createConversation({
      title: "consol-2",
      source: "memory_v2_consolidation",
    });
    await createConversation({ title: "heartbeat-1", source: "heartbeat" });
    await createConversation({ title: "user-1", source: "user" });

    const results = await listConversationsBySource("memory_v2_consolidation");

    expect(results).toHaveLength(2);
    expect(results.map((r) => r.title).sort()).toEqual([
      "consol-1",
      "consol-2",
    ]);
  });

  test("orders by createdAt descending", async () => {
    const a = await createConversation({
      title: "a",
      source: "memory_v2_consolidation",
    });
    const b = await createConversation({
      title: "b",
      source: "memory_v2_consolidation",
    });
    const c = await createConversation({
      title: "c",
      source: "memory_v2_consolidation",
    });
    // Force distinct createdAt regardless of ms-clock granularity.
    await requireMainDb().run(
      "UPDATE conversations SET created_at = ? WHERE id = ?",
      [1000, a.id],
    );
    await requireMainDb().run(
      "UPDATE conversations SET created_at = ? WHERE id = ?",
      [3000, b.id],
    );
    await requireMainDb().run(
      "UPDATE conversations SET created_at = ? WHERE id = ?",
      [2000, c.id],
    );

    const results = await listConversationsBySource("memory_v2_consolidation");

    expect(results.map((r) => r.id)).toEqual([b.id, c.id, a.id]);
  });

  test("honors the limit parameter", async () => {
    for (let i = 0; i < 5; i++) {
      await createConversation({
        title: `consol-${i}`,
        source: "memory_v2_consolidation",
      });
    }

    const results = await listConversationsBySource(
      "memory_v2_consolidation",
      3,
    );

    expect(results).toHaveLength(3);
  });

  test("includes archived rows by default", async () => {
    const conv = await createConversation({
      title: "archived",
      source: "memory_v2_consolidation",
    });
    await requireMainDb().run(
      "UPDATE conversations SET archived_at = ? WHERE id = ?",
      [Date.now(), conv.id],
    );

    const results = await listConversationsBySource("memory_v2_consolidation");

    expect(results).toHaveLength(1);
    expect(results[0]!.archivedAt).not.toBeNull();
  });

  test("excludes archived rows when includeArchived is false", async () => {
    const archived = await createConversation({
      title: "archived",
      source: "memory_v2_consolidation",
    });
    await createConversation({
      title: "live",
      source: "memory_v2_consolidation",
    });
    await requireMainDb().run(
      "UPDATE conversations SET archived_at = ? WHERE id = ?",
      [Date.now(), archived.id],
    );

    const results = await listConversationsBySource(
      "memory_v2_consolidation",
      20,
      {
        includeArchived: false,
      },
    );

    expect(results).toHaveLength(1);
    expect(results[0]!.title).toBe("live");
  });

  test("does not apply the subagent-exclusion that listConversations does", async () => {
    // The defensive `source != 'subagent'` carve-out in listConversations is
    // a foreground/background bucketing concern. A caller asking for the
    // exact `subagent` source via this query gets exactly that.
    await createConversation({ title: "sub-1", source: "subagent" });

    const results = await listConversationsBySource("subagent");

    expect(results).toHaveLength(1);
    expect(results[0]!.title).toBe("sub-1");
  });
});

// Content-arm (lexical candidate) surfacing behavior is covered in
// `persistence/__tests__/conversation-queries-search.test.ts`, which mocks the
// lexical index; this suite covers the title arm's surfacing rules.
describePg("searchConversations · surfaced conversations", () => {
  beforeEach(async () => {
    await resetTables();
  });

  async function setSurfaced(conversationId: string): Promise<void> {
    await requireMainDb().run(
      "UPDATE conversations SET surfaced_at = ? WHERE id = ?",
      [Date.now(), conversationId],
    );
  }

  test("a surfaced background conversation is found by title search", async () => {
    const surfaced = await createConversation({
      title: "Quarterly metrics rollup",
      conversationType: "background",
    });
    await setSurfaced(surfaced.id);

    const results = await searchConversations("Quarterly metrics");

    expect(results.map((r) => r.conversationId)).toEqual([surfaced.id]);
  });

  test("a non-surfaced background conversation stays excluded from title search", async () => {
    await createConversation({
      title: "Quarterly metrics rollup",
      conversationType: "background",
    });

    expect(await searchConversations("Quarterly metrics")).toEqual([]);
  });

  test("private conversations are never included, even with surfaced_at set", async () => {
    const priv = await createConversation("Quarterly metrics rollup");
    await setConversationType(priv.id, "private");
    await setSurfaced(priv.id);

    expect(await searchConversations("Quarterly metrics")).toEqual([]);
  });

  test("surfaced subagent runs stay excluded from title search", async () => {
    const subagent = await createConversation({
      title: "Quarterly metrics rollup",
      conversationType: "background",
      source: "subagent",
    });
    await setSurfaced(subagent.id);

    expect(await searchConversations("Quarterly metrics")).toEqual([]);
  });
});

describePg("listPinnedConversations · surfaced conversations", () => {
  beforeEach(async () => {
    await resetTables();
  });

  async function setSurfaced(conversationId: string): Promise<void> {
    await requireMainDb().run(
      "UPDATE conversations SET surfaced_at = ? WHERE id = ?",
      [Date.now(), conversationId],
    );
  }

  async function setPinned(conversationId: string): Promise<void> {
    await requireMainDb().run(
      "UPDATE conversations SET is_pinned = 1 WHERE id = ?",
      [conversationId],
    );
  }

  test("a pinned surfaced background conversation is returned", async () => {
    const surfaced = await createConversation({
      title: "bg-pinned-surfaced",
      conversationType: "background",
    });
    await setSurfaced(surfaced.id);
    await setPinned(surfaced.id);

    const results = await listPinnedConversations();

    expect(results.map((r) => r.id)).toEqual([surfaced.id]);
  });

  test("a pinned non-surfaced background conversation stays excluded", async () => {
    const background = await createConversation({
      title: "bg-pinned-hidden",
      conversationType: "background",
    });
    await setPinned(background.id);

    expect(await listPinnedConversations()).toEqual([]);
  });

  test("pinned private conversations are never included, even with surfaced_at set", async () => {
    const priv = await createConversation("private-pinned");
    await setConversationType(priv.id, "private");
    await setSurfaced(priv.id);
    await setPinned(priv.id);

    expect(await listPinnedConversations()).toEqual([]);
  });

  test("pinned surfaced subagent runs stay excluded", async () => {
    const subagent = await createConversation({
      title: "subagent-pinned",
      conversationType: "background",
      source: "subagent",
    });
    await setSurfaced(subagent.id);
    await setPinned(subagent.id);

    expect(await listPinnedConversations()).toEqual([]);
  });
});

describePg("getMessageRoleStatsByConversation", () => {
  beforeEach(async () => {
    await resetTables();
  });

  async function insertMessage(
    conversationId: string,
    role: string,
    createdAt: number,
  ): Promise<void> {
    await requireMainDb().run(
      "INSERT INTO messages (id, conversation_id, role, content, created_at) VALUES (?, ?, ?, ?, ?)",
      [
        `msg-${conversationId}-${role}-${createdAt}`,
        conversationId,
        role,
        "x",
        createdAt,
      ],
    );
  }

  test("returns empty map for empty input", async () => {
    const result = await getMessageRoleStatsByConversation([]);
    expect(result.size).toBe(0);
  });

  test("returns empty map when conversations exist but no matching role", async () => {
    const a = await createConversation("a");
    await insertMessage(a.id, "user", 1000);

    const result = await getMessageRoleStatsByConversation([a.id], "assistant");

    expect(result.size).toBe(0);
  });

  test("counts assistant messages and returns max createdAt", async () => {
    const a = await createConversation("a");
    await insertMessage(a.id, "user", 1000);
    await insertMessage(a.id, "assistant", 1500);
    await insertMessage(a.id, "assistant", 2500);
    await insertMessage(a.id, "assistant", 2000);

    const result = await getMessageRoleStatsByConversation([a.id], "assistant");

    expect(result.size).toBe(1);
    expect(result.get(a.id)).toEqual({ count: 3, lastAt: 2500 });
  });

  test("does not count messages from other roles", async () => {
    const a = await createConversation("a");
    await insertMessage(a.id, "user", 1000);
    await insertMessage(a.id, "user", 2000);
    await insertMessage(a.id, "system", 1500);
    await insertMessage(a.id, "assistant", 3000);

    const result = await getMessageRoleStatsByConversation([a.id], "assistant");

    expect(result.get(a.id)).toEqual({ count: 1, lastAt: 3000 });
  });

  test("scopes to the supplied conversation ids", async () => {
    const a = await createConversation("a");
    const b = await createConversation("b");
    await insertMessage(a.id, "assistant", 1000);
    await insertMessage(b.id, "assistant", 2000);

    const result = await getMessageRoleStatsByConversation([a.id], "assistant");

    expect(result.size).toBe(1);
    expect(result.has(a.id)).toBe(true);
    expect(result.has(b.id)).toBe(false);
  });

  test("aggregates per-conversation across many ids in a single query", async () => {
    const a = await createConversation("a");
    const b = await createConversation("b");
    const c = await createConversation("c");
    await insertMessage(a.id, "assistant", 1000);
    await insertMessage(a.id, "assistant", 1500);
    await insertMessage(b.id, "assistant", 2000);
    // c has no assistant messages → absent from the result.

    const result = await getMessageRoleStatsByConversation(
      [a.id, b.id, c.id],
      "assistant",
    );

    expect(result.size).toBe(2);
    expect(result.get(a.id)).toEqual({ count: 2, lastAt: 1500 });
    expect(result.get(b.id)).toEqual({ count: 1, lastAt: 2000 });
    expect(result.has(c.id)).toBe(false);
  });

  test("role parameter selects the counted role (defaults to assistant)", async () => {
    const a = await createConversation("a");
    await insertMessage(a.id, "user", 1000);
    await insertMessage(a.id, "user", 2000);
    await insertMessage(a.id, "assistant", 1500);

    const assistants = await getMessageRoleStatsByConversation([a.id]);
    expect(assistants.get(a.id)).toEqual({ count: 1, lastAt: 1500 });

    const users = await getMessageRoleStatsByConversation([a.id], "user");
    expect(users.get(a.id)).toEqual({ count: 2, lastAt: 2000 });
  });
});
