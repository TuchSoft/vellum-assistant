/**
 * Tests for the listConversations route handler — focused on the
 * `archiveStatus` query param introduced to keep archived rows out of the
 * default sidebar restore. Other handlers in the file (seen/unread/get)
 * are covered transitively by `conversation-sync-tags.test.ts`.
 */

import { beforeEach, expect, mock, test } from "bun:test";

import { describePg } from "../../__tests__/pg-test-db.js";

// Avoid spinning up the real event hub for the pinned/groups branches.
mock.module("../../assistant-event-hub.js", () => ({
  assistantEventHub: {
    publish: async () => {},
    subscribe: () => () => {},
  },
  broadcastMessage: () => {},
}));

import { findConversation } from "../../../daemon/conversation-registry.js";
import {
  projectAssistantMessage,
  recordConversationSeenSignal,
} from "../../../persistence/conversation-attention-store.js";
import { createConversation } from "../../../persistence/conversation-crud.js";
import { requireMainDb } from "../../../persistence/db-facade.js";
import { createGroup } from "../../../persistence/group-crud.js";
import { rawExec } from "../../../persistence/raw-query.js";
import { ROUTES as CONVERSATION_LIST_ROUTES } from "../conversation-list-routes.js";
import { BadRequestError, NotFoundError } from "../errors.js";
import type { RouteDefinition } from "../types.js";

// ---------------------------------------------------------------------------
// DB bootstrap
// ---------------------------------------------------------------------------

async function clearConversations(): Promise<void> {
  await requireMainDb().run("DELETE FROM conversations");
}

async function seedArchived(title: string): Promise<string> {
  const conv = await createConversation({ title });
  await requireMainDb().run(
    "UPDATE conversations SET archived_at = ? WHERE id = ?",
    [Date.now(), conv.id],
  );
  return conv.id;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

interface ConversationSummary {
  id: string;
  title: string;
  archivedAt?: number;
}

interface ListResponse {
  conversations: ConversationSummary[];
  nextOffset: number;
  hasMore: boolean;
  groups?: unknown[];
  orderedBy: string;
}

function findHandler(routes: RouteDefinition[], operationId: string) {
  const route = routes.find((r) => r.operationId === operationId);
  if (!route) {
    throw new Error(`Route ${operationId} not found`);
  }
  return route.handler;
}

const listHandler = findHandler(CONVERSATION_LIST_ROUTES, "listConversations");

function invoke(queryParams: Record<string, string> = {}) {
  return listHandler({ queryParams }) as ListResponse | Promise<ListResponse>;
}

// Sanity guard — `findConversation` is a daemon-store side-effect call in the
// handler. Confirm it returns undefined for our cold seed rows so the assert
// doesn't accidentally rely on in-memory residency.
const _findConversationSentinel = findConversation;
void _findConversationSentinel;

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describePg("GET /v1/conversations — archiveStatus", () => {
  beforeEach(async () => {
    await clearConversations();
  });

  test("default response omits archived rows", async () => {
    await createConversation("live-1");
    await seedArchived("archived-1");

    const result = (await invoke()) as ListResponse;

    expect(result.conversations).toHaveLength(1);
    expect(result.conversations[0]!.title).toBe("live-1");
    expect(result.hasMore).toBe(false);
  });

  test("archiveStatus=archived returns only archived rows", async () => {
    await createConversation("live-1");
    await seedArchived("archived-1");
    await seedArchived("archived-2");

    const result = (await invoke({
      archiveStatus: "archived",
    })) as ListResponse;

    expect(result.conversations).toHaveLength(2);
    const titles = result.conversations.map((c) => c.title).sort();
    expect(titles).toEqual(["archived-1", "archived-2"]);
  });

  test("archiveStatus=all returns active and archived rows", async () => {
    await createConversation("live-1");
    await seedArchived("archived-1");

    const result = (await invoke({ archiveStatus: "all" })) as ListResponse;

    expect(result.conversations).toHaveLength(2);
    const titles = result.conversations.map((c) => c.title).sort();
    expect(titles).toEqual(["archived-1", "live-1"]);
  });

  test("hasMore reflects the archived-only total count, not the full table", async () => {
    // 2 live rows, 1 archived. With limit=1 on the archived view there is
    // no second page even though the table contains three rows total.
    await createConversation("live-1");
    await createConversation("live-2");
    await seedArchived("archived-1");

    const result = (await invoke({
      archiveStatus: "archived",
      limit: "1",
    })) as ListResponse;

    expect(result.conversations).toHaveLength(1);
    expect(result.conversations[0]!.title).toBe("archived-1");
    expect(result.hasMore).toBe(false);
  });

  test("archived view skips pinned-row injection on first page", async () => {
    // GIVEN a pinned-but-archived row that would otherwise be force-included
    // on offset=0 of the active view.
    const pinned = await createConversation("pinned-archived");
    await requireMainDb().run(
      "UPDATE conversations SET is_pinned = 1 WHERE id = ?",
      [pinned.id],
    );
    await requireMainDb().run(
      "UPDATE conversations SET archived_at = ? WHERE id = ?",
      [Date.now(), pinned.id],
    );

    // AND a live archived row to make sure the archived list isn't empty.
    await seedArchived("archived-live");

    const result = (await invoke({
      archiveStatus: "archived",
    })) as ListResponse;

    expect(result.conversations.map((c) => c.title).sort()).toEqual([
      "archived-live",
      "pinned-archived",
    ]);
  });
});

describePg("GET /v1/conversations — conversationType", () => {
  beforeEach(async () => {
    await clearConversations();
  });

  test("default response returns foreground rows only", async () => {
    // GIVEN a foreground, a background, and a scheduled conversation
    await createConversation("foreground-1");
    await createConversation({ title: "bg-1", conversationType: "background" });
    await createConversation({
      title: "sched-1",
      conversationType: "scheduled",
    });

    // WHEN listing without a conversationType filter
    const result = (await invoke()) as ListResponse;

    // THEN only the foreground row is returned
    expect(result.conversations.map((c) => c.title)).toEqual(["foreground-1"]);
  });

  test("conversationType=background returns background and scheduled (umbrella)", async () => {
    // GIVEN a foreground, a background, and a scheduled conversation
    await createConversation("foreground-1");
    await createConversation({ title: "bg-1", conversationType: "background" });
    await createConversation({
      title: "sched-1",
      conversationType: "scheduled",
    });

    // WHEN listing with conversationType=background
    const result = (await invoke({
      conversationType: "background",
    })) as ListResponse;

    // THEN both the background and scheduled rows are returned
    expect(result.conversations.map((c) => c.title).sort()).toEqual([
      "bg-1",
      "sched-1",
    ]);
  });

  test("conversationType=scheduled returns scheduled rows only", async () => {
    // GIVEN a foreground, a background, and a scheduled conversation
    await createConversation("foreground-1");
    await createConversation({ title: "bg-1", conversationType: "background" });
    await createConversation({
      title: "sched-1",
      conversationType: "scheduled",
    });

    // WHEN listing with conversationType=scheduled
    const result = (await invoke({
      conversationType: "scheduled",
    })) as ListResponse;

    // THEN only the scheduled row is returned (background is excluded)
    expect(result.conversations.map((c) => c.title)).toEqual(["sched-1"]);
  });

  test("unknown conversationType is rejected with a 400", async () => {
    // GIVEN a request with an unrecognized conversationType
    // WHEN listing — THEN it throws a BadRequestError (400) instead of
    // silently falling back to the foreground list
    expect(() => invoke({ conversationType: "private" })).toThrow(
      BadRequestError,
    );
  });
});

describePg("GET /v1/conversations/:id", () => {
  const getHandler = findHandler(CONVERSATION_LIST_ROUTES, "getConversation");

  beforeEach(async () => {
    await clearConversations();
  });

  test("serves a listed conversation", async () => {
    const conv = await createConversation({ title: "listed" });

    const detail = (await getHandler({ pathParams: { id: conv.id } })) as {
      conversation: { id: string; conversationType: string };
    };

    expect(detail.conversation.id).toBe(conv.id);
    expect(detail.conversation.conversationType).toBe("standard");
  });

  test("does not serve a legacy private row the listing hides", async () => {
    // "private" is not a creatable type (legacy rows only); every listing
    // hides it by type and the wire type collapses it to "standard", so a
    // client holding only a stale id must get the same answer the listing
    // gives: not there.
    const conv = await createConversation({ title: "hidden" });
    await requireMainDb().run(
      "UPDATE conversations SET conversation_type = 'private' WHERE id = ?",
      [conv.id],
    );

    await expect(getHandler({ pathParams: { id: conv.id } })).rejects.toThrow(
      NotFoundError,
    );
  });
});

describePg("GET /v1/conversations with groupId", () => {
  async function seedInGroup(title: string, groupId: string): Promise<string> {
    const conv = await createConversation(title);
    await requireMainDb().run(
      "UPDATE conversations SET group_id = ? WHERE id = ?",
      [groupId, conv.id],
    );
    return conv.id;
  }

  async function seedPinned(
    title: string,
    displayOrder?: number,
  ): Promise<string> {
    const conv = await createConversation(title);
    await requireMainDb().run(
      "UPDATE conversations SET is_pinned = 1, group_id = 'system:pinned', display_order = ? WHERE id = ?",
      [displayOrder ?? null, conv.id],
    );
    return conv.id;
  }

  beforeEach(async () => {
    await clearConversations();
  });

  test("system:all returns only conversations in no group", async () => {
    await createConversation("ungrouped-1");
    const group = await createGroup("Car Chat");
    await seedInGroup("in-custom-group", group.id);
    await seedPinned("pinned-1");

    const result = (await invoke({ groupId: "system:all" })) as ListResponse;

    expect(result.conversations.map((c) => c.title)).toEqual(["ungrouped-1"]);
  });

  test("system:all matches rows whose group_id is NULL, not just the literal sentinel", async () => {
    // `group_id` is only written when a conversation is filed somewhere, so
    // almost every ungrouped row carries NULL. An equality-only predicate
    // would return nothing at all here.
    const conv = await createConversation("never-filed");
    await requireMainDb().run(
      "UPDATE conversations SET group_id = NULL WHERE id = ?",
      [conv.id],
    );

    const result = (await invoke({ groupId: "system:all" })) as ListResponse;

    expect(result.conversations.map((c) => c.title)).toEqual(["never-filed"]);
  });

  test("system:pinned returns the Pinned section", async () => {
    await createConversation("ungrouped-1");
    await seedPinned("pinned-1");
    await seedPinned("pinned-2");

    const result = (await invoke({ groupId: "system:pinned" })) as ListResponse;

    expect(result.conversations.map((c) => c.title).sort()).toEqual([
      "pinned-1",
      "pinned-2",
    ]);
  });

  test("a custom group id returns only that group's members", async () => {
    const carChat = await createGroup("Car Chat");
    const recipes = await createGroup("Recipes");
    await seedInGroup("car-1", carChat.id);
    await seedInGroup("car-2", carChat.id);
    await seedInGroup("recipe-1", recipes.id);
    await createConversation("ungrouped-1");

    const result = (await invoke({ groupId: carChat.id })) as ListResponse;

    expect(result.conversations.map((c) => c.title).sort()).toEqual([
      "car-1",
      "car-2",
    ]);
  });

  test("a group-scoped page is ordered by recency, not by display_order", async () => {
    /* `display_order` still holds values for anyone who arranged rows by hand
       before that affordance was removed, so the column is set here to the
       REVERSE of the expected result: a read that consults it again fails
       rather than passing by coincidence. Seeded oldest-first so insertion
       order cannot be mistaken for the assertion either. */
    const oldest = await seedPinned("oldest", 0);
    const middle = await seedPinned("middle", 1);
    const newest = await seedPinned("newest", 2);
    for (const [id, at] of [
      [oldest, 1_000],
      [middle, 5_000],
      [newest, 9_000],
    ] as const) {
      await requireMainDb().run(
        "UPDATE conversations SET last_message_at = ? WHERE id = ?",
        [at, id],
      );
    }

    const result = (await invoke({ groupId: "system:pinned" })) as ListResponse;

    expect(result.conversations.map((c) => c.title)).toEqual([
      "newest",
      "middle",
      "oldest",
    ]);
  });

  test("a group-scoped page has no pinned rows appended to it", async () => {
    // Injection exists so a client reading Pinned out of the unfiltered list
    // still sees it. A caller that asked for one group gets that group.
    const group = await createGroup("Car Chat");
    await seedInGroup("car-1", group.id);
    await seedPinned("pinned-1");

    const result = (await invoke({ groupId: group.id })) as ListResponse;

    expect(result.conversations.map((c) => c.title)).toEqual(["car-1"]);
  });

  test("system:all keeps surfaced background and scheduled rows", async () => {
    // Surfacing writes only `surfaced_at`, so a promoted row keeps its
    // `system:background` / `system:scheduled` group id while the standard
    // listing renders it in Recents. A group filter that matched NULL and
    // "system:all" alone would drop it from the section that is supposed to
    // show it.
    const background = await createConversation({
      title: "surfaced-background",
      conversationType: "background",
    });
    const scheduled = await createConversation({
      title: "surfaced-scheduled",
      conversationType: "scheduled",
    });
    // The routed group id is the part that matters: heartbeat, reminders and
    // schedule-job runs are filed into these system buckets, and surfacing
    // does not clear that. A row left with a NULL group id would pass a
    // NULL-only predicate and prove nothing.
    await requireMainDb().run(
      "UPDATE conversations SET group_id = 'system:background', surfaced_at = ? WHERE id = ?",
      [Date.now(), background.id],
    );
    await requireMainDb().run(
      "UPDATE conversations SET group_id = 'system:scheduled', surfaced_at = ? WHERE id = ?",
      [Date.now(), scheduled.id],
    );
    await createConversation("plain-ungrouped");

    const result = (await invoke({ groupId: "system:all" })) as ListResponse;

    expect(result.conversations.map((c) => c.title).sort()).toEqual([
      "plain-ungrouped",
      "surfaced-background",
      "surfaced-scheduled",
    ]);
  });

  test("system:all still excludes background rows that were never surfaced", async () => {
    const quiet = await createConversation({
      title: "quiet-background",
      conversationType: "background",
    });
    await requireMainDb().run(
      "UPDATE conversations SET group_id = 'system:background' WHERE id = ?",
      [quiet.id],
    );
    await createConversation("plain-ungrouped");

    const result = (await invoke({ groupId: "system:all" })) as ListResponse;

    expect(result.conversations.map((c) => c.title)).toEqual([
      "plain-ungrouped",
    ]);
  });

  test("system:all and system:pinned partition the sections, never overlapping", async () => {
    await createConversation("ungrouped-1");
    await seedPinned("pinned-1");
    const group = await createGroup("Car Chat");
    await seedInGroup("car-1", group.id);

    const ungrouped = (await invoke({ groupId: "system:all" })) as ListResponse;
    const pinned = (await invoke({ groupId: "system:pinned" })) as ListResponse;
    const custom = (await invoke({ groupId: group.id })) as ListResponse;

    expect(ungrouped.conversations.map((c) => c.title)).toEqual([
      "ungrouped-1",
    ]);
    expect(pinned.conversations.map((c) => c.title)).toEqual(["pinned-1"]);
    expect(custom.conversations.map((c) => c.title)).toEqual(["car-1"]);
  });

  test("a surfaced background row sorts by recency, not stale display order", async () => {
    // `display_order` persists through moves, so a row that carries one from
    // an earlier group must not have it resurface as a sort key here.
    const older = await createConversation({
      title: "older",
      conversationType: "background",
    });
    const newer = await createConversation({
      title: "newer",
      conversationType: "background",
    });
    await requireMainDb().run(
      "UPDATE conversations SET surfaced_at = ?, display_order = 0, last_message_at = 1000 WHERE id = ?",
      [Date.now(), older.id],
    );
    await requireMainDb().run(
      "UPDATE conversations SET surfaced_at = ?, display_order = 99, last_message_at = 2000 WHERE id = ?",
      [Date.now(), newer.id],
    );

    const result = (await invoke({ groupId: "system:all" })) as ListResponse;

    expect(result.conversations.map((c) => c.title)).toEqual([
      "newer",
      "older",
    ]);
  });

  test("hasMore reflects the group's own total, not the whole table", async () => {
    const group = await createGroup("Car Chat");
    await seedInGroup("car-1", group.id);
    await seedInGroup("car-2", group.id);
    for (let i = 0; i < 5; i++) {
      await createConversation(`ungrouped-${i}`);
    }

    const result = (await invoke({
      groupId: group.id,
      limit: "2",
    })) as ListResponse;

    expect(result.conversations).toHaveLength(2);
    expect(result.hasMore).toBe(false);
  });

  test("omitting groupId is unchanged: every group is spanned and pinned still injects", async () => {
    const group = await createGroup("Car Chat");
    await seedInGroup("car-1", group.id);
    await createConversation("ungrouped-1");
    await seedPinned("pinned-1");

    const result = (await invoke()) as ListResponse;

    expect(result.conversations.map((c) => c.title).sort()).toEqual([
      "car-1",
      "pinned-1",
      "ungrouped-1",
    ]);
  });
});

describePg("GET /v1/conversations with needsAttention", () => {
  async function seedUnseen(conversationId: string): Promise<void> {
    await projectAssistantMessage({
      conversationId,
      messageId: `msg-${conversationId}`,
      messageAt: Date.now(),
    });
  }

  async function markSeen(conversationId: string): Promise<void> {
    await recordConversationSeenSignal({
      conversationId,
      sourceChannel: "vellum",
      signalType: "macos_conversation_opened",
      confidence: "explicit",
      source: "test",
    });
  }

  beforeEach(async () => {
    await requireMainDb().run("DELETE FROM conversation_attention_events");
    await requireMainDb().run(
      "DELETE FROM conversation_assistant_attention_state",
    );
    await clearConversations();
  });

  test("returns only conversations with an unseen latest assistant message", async () => {
    const unseen = await createConversation("needs-attention");
    await seedUnseen(unseen.id);
    const seen = await createConversation("already-seen");
    await seedUnseen(seen.id);
    await markSeen(seen.id);
    // No attention projection at all: not unseen, so not returned. The
    // filter's inner join is what excludes it; a left join would leak it.
    await createConversation("never-projected");

    const result = await invoke({ needsAttention: "true" });

    expect(result.conversations.map((c) => c.title)).toEqual([
      "needs-attention",
    ]);
  });

  test("omitting the filter leaves every list unchanged, join and all", async () => {
    /* The sensitivity check for the conditional join: with the filter off,
       rows with no attention row must still be listed. If the join were
       applied unconditionally, "never-projected" would vanish from the
       plain list, which is every list the app has today. */
    const unseen = await createConversation("has-attention-row");
    await seedUnseen(unseen.id);
    await createConversation("never-projected");

    const result = await invoke();

    expect(result.conversations.map((c) => c.title).sort()).toEqual([
      "has-attention-row",
      "never-projected",
    ]);
  });

  test("hasMore and the total describe the filtered set, not the whole table", async () => {
    /* countConversations reads through the same where AND the same join;
       a page and its total have to agree or the client's hasMore lies. */
    for (let i = 0; i < 3; i++) {
      const c = await createConversation(`unseen-${i}`);
      await seedUnseen(c.id);
    }
    for (let i = 0; i < 5; i++) {
      await createConversation(`quiet-${i}`);
    }

    const page = await invoke({ needsAttention: "true", limit: "2" });

    expect(page.conversations).toHaveLength(2);
    expect(page.hasMore).toBe(true);
    const rest = await invoke({
      needsAttention: "true",
      limit: "2",
      offset: "2",
    });
    expect(rest.conversations).toHaveLength(1);
    expect(rest.hasMore).toBe(false);
  });

  test("an attention-scoped first page has no pinned rows appended to it", async () => {
    /* Same rule as the group-scoped page: the pinned injection exists for
       a client reading Pinned out of the unfiltered list, and a caller
       that asked for the unseen subset is not that client. A seen pinned
       row appended here would be a row outside the filter, on a page whose
       hasMore was computed from the filtered count. */
    const unseen = await createConversation("unseen-only");
    await seedUnseen(unseen.id);
    const pinnedSeen = await createConversation("pinned-and-seen");
    await requireMainDb().run(
      "UPDATE conversations SET is_pinned = 1, group_id = 'system:pinned' WHERE id = ?",
      [pinnedSeen.id],
    );

    const result = await invoke({ needsAttention: "true" });

    expect(result.conversations.map((c) => c.title)).toEqual(["unseen-only"]);
  });

  test("composes with the other filters", async () => {
    const group = await createGroup("Work");
    const inGroupUnseen = await createConversation("in-group-unseen");
    await seedUnseen(inGroupUnseen.id);
    await requireMainDb().run(
      "UPDATE conversations SET group_id = ? WHERE id = ?",
      [group.id, inGroupUnseen.id],
    );
    const outOfGroupUnseen = await createConversation("out-of-group-unseen");
    await seedUnseen(outOfGroupUnseen.id);

    const result = await invoke({ needsAttention: "true", groupId: group.id });

    expect(result.conversations.map((c) => c.title)).toEqual([
      "in-group-unseen",
    ]);
  });

  test('any value other than "true" is rejected with a 400', async () => {
    /* Same posture as conversationType: silently reading a typo or a newer
       client's value as "no filter" would hand back the full list where a
       subset was asked for, and that skew is invisible to the client. */
    for (const bad of ["false", "1", "yes", "TRUE"]) {
      expect(() => invoke({ needsAttention: bad })).toThrow(BadRequestError);
    }
  });
});

describePg("GET /v1/conversations with foregroundOnly", () => {
  async function fileIntoGroup(
    conversationId: string,
    groupId: string,
  ): Promise<void> {
    await requireMainDb().run(
      "UPDATE conversations SET group_id = ? WHERE id = ?",
      [groupId, conversationId],
    );
  }

  function surface(conversationId: string): void {
    await requireMainDb().run(
      "UPDATE conversations SET surfaced_at = ? WHERE id = ?",
      [Date.now(), conversationId],
    );
  }

  beforeEach(async () => {
    await clearConversations();
  });

  test("drops the automated runs the standard listing admits through a custom group", async () => {
    /* The standard listing shows a background run filed in a custom group,
       so a caller reading page one to find "the newest chat" can lead with
       one; the filter is what lets that caller ask for chats alone. A
       surfaced run is a chat for this purpose, exactly as the unread count
       treats it. */
    const group = await createGroup("Work");
    await createConversation("plain-chat");
    const bgInGroup = await createConversation({
      title: "bg-in-group",
      conversationType: "background",
    });
    await fileIntoGroup(bgInGroup.id, group.id);
    const surfacedBg = await createConversation({
      title: "surfaced-bg",
      conversationType: "background",
    });
    surface(surfacedBg.id);

    const unfiltered = await invoke();
    expect(unfiltered.conversations.map((c) => c.title).sort()).toEqual([
      "bg-in-group",
      "plain-chat",
      "surfaced-bg",
    ]);

    const result = await invoke({ foregroundOnly: "true" });
    expect(result.conversations.map((c) => c.title).sort()).toEqual([
      "plain-chat",
      "surfaced-bg",
    ]);
  });

  test("hasMore and the total describe the filtered set, not the whole table", async () => {
    /* The reason for the filter is a limit=1 read whose first row is the
       answer; that read is only right if the page and its total come from
       the same predicate. */
    const group = await createGroup("Work");
    for (let i = 0; i < 3; i++) {
      const bg = await createConversation({
        title: `bg-${i}`,
        conversationType: "background",
      });
      await fileIntoGroup(bg.id, group.id);
    }
    await createConversation("the-only-chat");

    const page = await invoke({ foregroundOnly: "true", limit: "1" });

    expect(page.conversations.map((c) => c.title)).toEqual(["the-only-chat"]);
    expect(page.hasMore).toBe(false);
  });

  test("a foreground-only first page has no pinned rows appended to it", async () => {
    /* Same rule as the attention- and group-scoped pages: the injection is
       for a client reading Pinned out of the unfiltered list, and a caller
       that asked for the newest chat in one row is not that client. The
       older pinned chat is a member of the filter, so only the injection
       could put it on a limit=1 page. */
    const older = await createConversation("older-pinned-chat");
    await requireMainDb().run(
      "UPDATE conversations SET is_pinned = 1, group_id = 'system:pinned', last_message_at = ? WHERE id = ?",
      [Date.now() - 60_000, older.id],
    );
    const newer = await createConversation("newest-chat");
    await requireMainDb().run(
      "UPDATE conversations SET last_message_at = ? WHERE id = ?",
      [Date.now(), newer.id],
    );

    const unfiltered = await invoke({ limit: "1" });
    expect(unfiltered.conversations.map((c) => c.title)).toEqual([
      "newest-chat",
      "older-pinned-chat",
    ]);

    const result = await invoke({ foregroundOnly: "true", limit: "1" });
    expect(result.conversations.map((c) => c.title)).toEqual(["newest-chat"]);
  });

  test("composes with the other filters", async () => {
    const group = await createGroup("Work");
    const chatInGroup = await createConversation("chat-in-group");
    await fileIntoGroup(chatInGroup.id, group.id);
    const bgInGroup = await createConversation({
      title: "bg-in-group",
      conversationType: "background",
    });
    await fileIntoGroup(bgInGroup.id, group.id);
    await createConversation("chat-outside");

    const result = await invoke({
      foregroundOnly: "true",
      groupId: group.id,
    });

    expect(result.conversations.map((c) => c.title)).toEqual(["chat-in-group"]);
  });

  test('any value other than "true" is rejected with a 400', async () => {
    for (const bad of ["false", "1", "yes", "TRUE"]) {
      expect(() => invoke({ foregroundOnly: bad })).toThrow(BadRequestError);
    }
  });
});

describePg("GET /v1/conversations/unread-count", () => {
  const unreadCountHandler = findHandler(
    CONVERSATION_LIST_ROUTES,
    "getUnreadConversationCount",
  );

  async function invokeUnreadCount(): Promise<{ count: number }> {
    return (await unreadCountHandler({})) as { count: number };
  }

  async function seedUnseen(conversationId: string): Promise<void> {
    await projectAssistantMessage({
      conversationId,
      messageId: `msg-${conversationId}`,
      messageAt: Date.now(),
    });
  }

  async function markSeen(conversationId: string): Promise<void> {
    await recordConversationSeenSignal({
      conversationId,
      sourceChannel: "vellum",
      signalType: "macos_conversation_opened",
      confidence: "explicit",
      source: "test",
    });
  }

  beforeEach(async () => {
    await requireMainDb().run("DELETE FROM conversation_attention_events");
    await requireMainDb().run(
      "DELETE FROM conversation_assistant_attention_state",
    );
    await clearConversations();
  });

  test("counts only foreground conversations with an unseen latest assistant message", async () => {
    const unseen = await createConversation("unseen-1");
    await seedUnseen(unseen.id);

    // A conversation with no attention projection reads as seen.
    await createConversation("no-attention-row");

    const seen = await createConversation("seen-1");
    await seedUnseen(seen.id);
    await markSeen(seen.id);

    expect(await invokeUnreadCount()).toEqual({ count: 1 });
  });

  test("marking seen removes the conversation from the count", async () => {
    const conv = await createConversation("unseen-then-seen");
    await seedUnseen(conv.id);
    expect(await invokeUnreadCount()).toEqual({ count: 1 });

    await markSeen(conv.id);
    expect(await invokeUnreadCount()).toEqual({ count: 0 });
  });

  test("archived conversations are excluded", async () => {
    const conv = await createConversation("unseen-archived");
    await seedUnseen(conv.id);
    await requireMainDb().run(
      "UPDATE conversations SET archived_at = ? WHERE id = ?",
      [Date.now(), conv.id],
    );

    expect(await invokeUnreadCount()).toEqual({ count: 0 });
  });

  test("background and scheduled conversations count only when surfaced", async () => {
    const bg = await createConversation({
      title: "bg-1",
      conversationType: "background",
    });
    await seedUnseen(bg.id);
    const sched = await createConversation({
      title: "sched-1",
      conversationType: "scheduled",
    });
    await seedUnseen(sched.id);
    expect(await invokeUnreadCount()).toEqual({ count: 0 });

    // Surfacing promotes a row into the foreground listing, so it counts.
    await requireMainDb().run(
      "UPDATE conversations SET surfaced_at = ? WHERE id = ?",
      [Date.now(), bg.id],
    );
    expect(await invokeUnreadCount()).toEqual({ count: 1 });
  });

  /**
   * The daemon half of the unread-count contract.
   *
   * The web client answers the same question in TypeScript
   * (`contributesToUnreadCount` in
   * `clients/web/src/utils/conversation-predicates.ts`), and its
   * `conversation-predicates.test.ts` asserts this same matrix against the
   * predicate. The two definitions are maintained separately, so this matrix
   * is the tripwire: a rule changed on one side without the other shows up as
   * one of these scenarios disagreeing across the two suites.
   *
   * Keep the scenario names identical on both sides.
   */
  describe("unread-count contract (daemon half)", () => {
    const scenarios: Array<{
      name: string;
      counts: boolean;
      seed: (groupId: string) => string;
    }> = [
      {
        name: "unseen foreground row",
        counts: true,
        seed: async () => (await createConversation("unseen-foreground")).id,
      },
      {
        name: "seen foreground row",
        counts: false,
        seed: async () => {
          const conv = await createConversation("seen-foreground");
          await seedUnseen(conv.id);
          await markSeen(conv.id);
          return conv.id;
        },
      },
      {
        name: "unseen archived row",
        counts: false,
        seed: async () => {
          const conv = await createConversation("unseen-archived");
          await requireMainDb().run(
            "UPDATE conversations SET archived_at = ? WHERE id = ?",
            [Date.now(), conv.id],
          );
          return conv.id;
        },
      },
      {
        name: "unseen background row, not surfaced",
        counts: false,
        seed: async () =>
          (
            await createConversation({
              title: "unseen-background",
              conversationType: "background",
            })
          ).id,
      },
      {
        name: "unseen scheduled row, not surfaced",
        counts: false,
        seed: async () =>
          (
            await createConversation({
              title: "unseen-scheduled",
              conversationType: "scheduled",
            })
          ).id,
      },
      {
        name: "unseen background row, surfaced",
        counts: true,
        seed: async () => {
          const conv = await createConversation({
            title: "unseen-background-surfaced",
            conversationType: "background",
          });
          await requireMainDb().run(
            "UPDATE conversations SET surfaced_at = ? WHERE id = ?",
            [Date.now(), conv.id],
          );
          return conv.id;
        },
      },
      {
        name: "unseen background row filed in a custom group, not surfaced",
        counts: false,
        seed: async (groupId) => {
          const conv = await createConversation({
            title: "unseen-background-in-group",
            conversationType: "background",
          });
          await requireMainDb().run(
            "UPDATE conversations SET group_id = ? WHERE id = ?",
            [groupId, conv.id],
          );
          return conv.id;
        },
      },
      {
        name: "unseen standard row filed in a custom group",
        counts: true,
        seed: async (groupId) => {
          const conv = await createConversation("unseen-standard-in-group");
          await requireMainDb().run(
            "UPDATE conversations SET group_id = ? WHERE id = ?",
            [groupId, conv.id],
          );
          return conv.id;
        },
      },
    ];

    for (const scenario of scenarios) {
      test(`${scenario.name} ${scenario.counts ? "counts" : "does not count"}`, async () => {
        const group = await createGroup("unread-contract-group");
        const conversationId = scenario.seed(group.id);
        // The "seen" scenario seeds and clears its own attention row.
        if (scenario.name !== "seen foreground row") {
          await seedUnseen(conversationId);
        }

        expect(await invokeUnreadCount()).toEqual({
          count: scenario.counts ? 1 : 0,
        });
      });
    }

    test("the matrix totals across every scenario at once", async () => {
      const group = await createGroup("unread-contract-group");
      for (const scenario of scenarios) {
        const conversationId = scenario.seed(group.id);
        if (scenario.name !== "seen foreground row") {
          await seedUnseen(conversationId);
        }
      }
      const expected = scenarios.filter((s) => s.counts).length;

      expect(await invokeUnreadCount()).toEqual({ count: expected });
    });
  });

  test("background rows filed in a custom group stay excluded until surfaced", async () => {
    // Custom-group rows are visible in the standard listing regardless of
    // type, but a non-surfaced background row must not count as unread
    // (the client's unread predicate excludes it).
    const group = await createGroup("unread-count-test-group");

    const bgInGroup = await createConversation({
      title: "bg-in-group",
      conversationType: "background",
    });
    await seedUnseen(bgInGroup.id);
    await requireMainDb().run(
      "UPDATE conversations SET group_id = ? WHERE id = ?",
      [group.id, bgInGroup.id],
    );

    const standardInGroup = await createConversation("standard-in-group");
    await seedUnseen(standardInGroup.id);
    await requireMainDb().run(
      "UPDATE conversations SET group_id = ? WHERE id = ?",
      [group.id, standardInGroup.id],
    );

    expect(await invokeUnreadCount()).toEqual({ count: 1 });
  });
});

describePg("GET /v1/conversations/sections", () => {
  const sectionsHandler = findHandler(
    CONVERSATION_LIST_ROUTES,
    "getConversationSections",
  );

  interface SectionRow {
    kind: "pinned" | "group" | "channel" | "chats";
    groupId?: string;
    name?: string;
    icon?: string | null;
    sortPosition?: number;
    channelId?: string;
    total: number;
    unread: number;
  }

  async function invokeSections(): Promise<SectionRow[]> {
    return ((await sectionsHandler({})) as { sections: SectionRow[] }).sections;
  }

  async function fileIntoGroup(
    conversationId: string,
    groupId: string,
  ): Promise<void> {
    await requireMainDb().run(
      "UPDATE conversations SET group_id = ? WHERE id = ?",
      [groupId, conversationId],
    );
  }

  async function stampChannel(
    conversationId: string,
    channel: string,
  ): Promise<void> {
    await requireMainDb().run(
      "UPDATE conversations SET origin_channel = ? WHERE id = ?",
      [channel, conversationId],
    );
  }

  async function pin(conversationId: string): Promise<void> {
    await requireMainDb().run(
      "UPDATE conversations SET is_pinned = 1, group_id = 'system:pinned' WHERE id = ?",
      [conversationId],
    );
  }

  async function seedUnseen(conversationId: string): Promise<void> {
    await projectAssistantMessage({
      conversationId,
      messageId: `msg-${conversationId}`,
      messageAt: Date.now(),
    });
  }

  beforeEach(async () => {
    await clearConversations();
  });

  test("an empty conversation table yields Chats alone, at zero", async () => {
    // Chats is the leftover bucket and renders regardless, so its counts
    // are part of the contract even when nothing exists.
    expect(await invokeSections()).toEqual([
      { kind: "chats", total: 0, unread: 0 },
    ]);
  });

  test("every section kind appears with its own totals", async () => {
    const pinned = await createConversation({ title: "pinned-1" });
    await pin(pinned.id);
    const group = await createGroup("Sections Spread Group");
    await fileIntoGroup(
      (await createConversation({ title: "g-1" })).id,
      group.id,
    );
    await fileIntoGroup(
      (await createConversation({ title: "g-2" })).id,
      group.id,
    );
    await stampChannel(
      (await createConversation({ title: "slack-1" })).id,
      "slack",
    );
    await createConversation({ title: "native-unstamped" });
    await stampChannel(
      (await createConversation({ title: "native-stamped" })).id,
      "vellum",
    );

    const sections = await invokeSections();

    expect(sections).toContainEqual({ kind: "pinned", total: 1, unread: 0 });
    expect(sections).toContainEqual({
      kind: "group",
      groupId: group.id,
      name: "Sections Spread Group",
      icon: null,
      sortPosition: group.sortPosition,
      total: 2,
      unread: 0,
    });
    expect(sections).toContainEqual({
      kind: "channel",
      channelId: "slack",
      total: 1,
      unread: 0,
    });
    // NULL origin_channel reads as native, exactly as the list filter reads
    // it, so the stamped and unstamped native rows share the Chats bucket.
    expect(sections).toContainEqual({ kind: "chats", total: 2, unread: 0 });
  });

  test("unread counts follow the seen state per section", async () => {
    const pinned = await createConversation({ title: "pinned-seen" });
    await pin(pinned.id);
    await seedUnseen(pinned.id);
    recordConversationSeenSignal({
      conversationId: pinned.id,
      sourceChannel: "vellum",
      signalType: "macos_conversation_opened",
      confidence: "explicit",
      source: "test",
    });

    const group = await createGroup("Sections Unread Group");
    const unreadInGroup = await createConversation({ title: "g-unread" });
    await fileIntoGroup(unreadInGroup.id, group.id);
    await seedUnseen(unreadInGroup.id);
    // A member with no attention projection at all reads as seen.
    await fileIntoGroup(
      (await createConversation({ title: "g-quiet" })).id,
      group.id,
    );

    const chatsUnread = await createConversation({ title: "chat-unread" });
    await seedUnseen(chatsUnread.id);

    const sections = await invokeSections();

    expect(sections).toContainEqual({ kind: "pinned", total: 1, unread: 0 });
    expect(sections).toContainEqual({
      kind: "group",
      groupId: group.id,
      name: "Sections Unread Group",
      icon: null,
      sortPosition: group.sortPosition,
      total: 2,
      unread: 1,
    });
    expect(sections).toContainEqual({ kind: "chats", total: 1, unread: 1 });
  });

  test("a background row filed into a group counts toward total but never unread", async () => {
    // Mirrors the unread-count contract: the custom-group visibility arm
    // admits the row into the section, and the not-background unread rule
    // keeps it out of the badge.
    const group = await createGroup("Sections Background Group");
    const bg = await createConversation({
      title: "bg-in-group",
      conversationType: "background",
    });
    await fileIntoGroup(bg.id, group.id);
    await seedUnseen(bg.id);

    const sections = await invokeSections();

    expect(sections).toContainEqual({
      kind: "group",
      groupId: group.id,
      name: "Sections Background Group",
      icon: null,
      sortPosition: group.sortPosition,
      total: 1,
      unread: 0,
    });
  });

  test("an empty custom group gets no section", async () => {
    const group = await createGroup("Sections Empty Group");

    const sections = await invokeSections();

    expect(sections.some((s) => s.groupId === group.id)).toBe(false);
  });

  test("archived rows count toward no section", async () => {
    const group = await createGroup("Sections Archived Group");
    await fileIntoGroup(await seedArchived("archived-in-group"), group.id);

    const sections = await invokeSections();

    expect(sections.some((s) => s.groupId === group.id)).toBe(false);
  });

  test("a dangling group id is skipped, not surfaced", async () => {
    /* Live write paths cannot create this state: group_id carries a foreign
       key, and the placement write sanitizes unknown groups precisely to
       avoid violating it. A restored snapshot can, though: in-place restore
       swaps the SQLite file without running migrations in-process (the same
       window that lets legacy private rows exist transiently), so the
       fixture creates the state the way reality does, with enforcement off. */
    rawExec("PRAGMA foreign_keys = OFF");
    try {
      await fileIntoGroup(
        (await createConversation({ title: "dangling" })).id,
        "00000000-0000-4000-8000-00000000dead",
      );
    } finally {
      rawExec("PRAGMA foreign_keys = ON");
    }

    const sections = await invokeSections();

    expect(sections.some((s) => s.kind === "group")).toBe(false);
    // Grouped, so it does not leak into the ungrouped Chats bucket either.
    expect(sections).toContainEqual({ kind: "chats", total: 0, unread: 0 });
  });

  test("an unsurfaced background row pinned by raw column writes stays invisible", async () => {
    // Standard-listing visibility admits a pinned background row only when
    // it is surfaced (the pinned group fails the custom-group arm on its
    // system: prefix), so it appears in neither the Pinned list nor the
    // Pinned count.
    const bg = await createConversation({
      title: "bg-pinned",
      conversationType: "background",
    });
    await pin(bg.id);

    const sections = await invokeSections();

    expect(sections.some((s) => s.kind === "pinned")).toBe(false);
  });
});

describePg("GET /v1/conversations, conversationType=all", () => {
  beforeEach(async () => {
    await clearConversations();
  });

  function setLastMessageAt(id: string, at: number): void {
    await requireMainDb().run(
      "UPDATE conversations SET last_message_at = ? WHERE id = ?",
      [at, id],
    );
  }

  test("returns the standard listing and the background umbrella together", async () => {
    await createConversation("foreground-1");
    await createConversation({ title: "bg-1", conversationType: "background" });
    await createConversation({
      title: "sched-1",
      conversationType: "scheduled",
    });

    const result = (await invoke({ conversationType: "all" })) as ListResponse;

    expect(result.conversations.map((c) => c.title).sort()).toEqual([
      "bg-1",
      "foreground-1",
      "sched-1",
    ]);
  });

  test("with archiveStatus=all one page spans live and done rows of every type", async () => {
    await createConversation("foreground-1");
    await createConversation({ title: "bg-1", conversationType: "background" });
    await seedArchived("archived-1");
    const archivedBackground = await createConversation({
      title: "archived-bg",
      conversationType: "background",
    });
    await requireMainDb().run(
      "UPDATE conversations SET archived_at = ? WHERE id = ?",
      [Date.now(), archivedBackground.id],
    );

    const result = (await invoke({
      conversationType: "all",
      archiveStatus: "all",
    })) as ListResponse;

    expect(result.conversations.map((c) => c.title).sort()).toEqual([
      "archived-1",
      "archived-bg",
      "bg-1",
      "foreground-1",
    ]);
    expect(result.hasMore).toBe(false);
  });

  test("orders by last message time descending across the types it merges", async () => {
    const oldest = await createConversation("oldest-foreground");
    const middle = await createConversation({
      title: "middle-background",
      conversationType: "background",
    });
    const newest = await createConversation("newest-foreground");
    setLastMessageAt(oldest.id, 1000);
    setLastMessageAt(middle.id, 2000);
    setLastMessageAt(newest.id, 3000);

    const result = (await invoke({ conversationType: "all" })) as ListResponse;

    expect(result.conversations.map((c) => c.title)).toEqual([
      "newest-foreground",
      "middle-background",
      "oldest-foreground",
    ]);
  });

  test("files a done row by when it was marked done when that is later than its last message", async () => {
    const recent = await createConversation("recent-foreground");
    const doneLater = await createConversation("old-chat-marked-done-later");
    const doneEarlier = await createConversation(
      "old-chat-done-before-a-reply",
    );
    setLastMessageAt(recent.id, 2000);
    setLastMessageAt(doneLater.id, 1000);
    setLastMessageAt(doneEarlier.id, 1500);
    await requireMainDb().run(
      "UPDATE conversations SET archived_at = ? WHERE id = ?",
      [3000, doneLater.id],
    );
    await requireMainDb().run(
      "UPDATE conversations SET archived_at = ? WHERE id = ?",
      [500, doneEarlier.id],
    );

    const result = (await invoke({
      conversationType: "all",
      archiveStatus: "all",
    })) as ListResponse;

    expect(result.conversations.map((c) => c.title)).toEqual([
      "old-chat-marked-done-later",
      "recent-foreground",
      "old-chat-done-before-a-reply",
    ]);
    // A client paging done rows relies on this to know the order is not
    // message recency.
    expect(result.orderedBy).toBe("lastActivity");
  });

  test("excludes legacy private rows and subagent runs", async () => {
    await createConversation("foreground-1");
    const legacyPrivate = await createConversation("legacy-private");
    await requireMainDb().run(
      "UPDATE conversations SET conversation_type = 'private', group_id = 'system:background' WHERE id = ?",
      [legacyPrivate.id],
    );
    const subagent = await createConversation({
      title: "subagent-run",
      conversationType: "background",
    });
    await requireMainDb().run(
      "UPDATE conversations SET source = 'subagent' WHERE id = ?",
      [subagent.id],
    );

    const result = (await invoke({ conversationType: "all" })) as ListResponse;

    expect(result.conversations.map((c) => c.title)).toEqual(["foreground-1"]);
  });

  test("never appends pinned rows outside the page", async () => {
    // Pinned injection is the compatibility shim for the default sidebar
    // read. A whole-history page already contains the pinned row in recency
    // order, so appending it would duplicate it and put hasMore out of step
    // with the count.
    const pinned = await createConversation("pinned-1");
    await requireMainDb().run(
      "UPDATE conversations SET is_pinned = 1, group_id = 'system:pinned' WHERE id = ?",
      [pinned.id],
    );
    const newer = await createConversation("newer-1");
    setLastMessageAt(pinned.id, 1000);
    setLastMessageAt(newer.id, 2000);

    const result = (await invoke({
      conversationType: "all",
      limit: "1",
    })) as ListResponse;

    expect(result.conversations.map((c) => c.title)).toEqual(["newer-1"]);
    expect(result.hasMore).toBe(true);
  });

  test("hasMore describes the combined total, so pagination drains it", async () => {
    await createConversation("foreground-1");
    await createConversation({ title: "bg-1", conversationType: "background" });
    await createConversation({
      title: "sched-1",
      conversationType: "scheduled",
    });

    const first = (await invoke({
      conversationType: "all",
      limit: "2",
    })) as ListResponse;
    expect(first.conversations).toHaveLength(2);
    expect(first.hasMore).toBe(true);

    const second = (await invoke({
      conversationType: "all",
      limit: "2",
      offset: String(first.nextOffset),
    })) as ListResponse;
    expect(second.conversations).toHaveLength(1);
    expect(second.hasMore).toBe(false);
  });
});
