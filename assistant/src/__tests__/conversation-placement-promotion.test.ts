/**
 * Filing a background or scheduled conversation into a section the user reads
 * promotes it durably.
 *
 * Placement into Pinned or a custom group stamps `surfaced_at`, so the
 * promotion outlives the placement that caused it: taking the conversation
 * back out returns it to Recents rather than hiding it. Demotion is the
 * mirror image, and filing into `system:background` / `system:scheduled`
 * clears the stamp.
 *
 * The cases below pin both edges. Under-promoting hides a conversation the
 * user deliberately filed somewhere; over-promoting drags hidden automation
 * into the sidebar, so the "what promotion must not do" block is as
 * load-bearing as the rest.
 */

import { beforeEach, expect, test } from "bun:test";

import {
  batchSetConversationPlacement,
  createConversation,
} from "../persistence/conversation-crud.js";
import { listConversations } from "../persistence/conversation-queries.js";
import { requireMainDb } from "../persistence/db-facade.js";
import { createGroup } from "../persistence/group-crud.js";
import { rawRunAsync } from "../persistence/raw-query.js";
import { describePg } from "./pg-test-db.js";

async function seedRoutedBackground(
  title: string,
  type: "background" | "scheduled",
) {
  const conv = await createConversation({ title, conversationType: type });
  await rawRunAsync(
    "test:routeToSystemBucket",
    "UPDATE conversations SET group_id = ? WHERE id = ?",
    type === "scheduled" ? "system:scheduled" : "system:background",
    conv.id,
  );
  return conv;
}

/** Titles the sidebar's standard listing would render. */
async function visibleTitles(): Promise<string[]> {
  return (await listConversations({ limit: 100 })).map((c) => c.title ?? "");
}

async function titlesInGroup(groupId: string): Promise<string[]> {
  return (await listConversations({ limit: 100, groupId })).map(
    (c) => c.title ?? "",
  );
}

beforeEach(async () => {
  await requireMainDb().run("DELETE FROM conversations");
});

describePg("pinning a background conversation", () => {
  test("shows it in Pinned", async () => {
    const conv = await seedRoutedBackground("bg-job", "background");
    expect(await visibleTitles()).toEqual([]);

    await batchSetConversationPlacement([
      { id: conv.id, groupId: "system:pinned" },
    ]);

    expect(await titlesInGroup("system:pinned")).toEqual(["bg-job"]);
  });

  test("unpinning lands it in Recents rather than hiding it again", async () => {
    const conv = await seedRoutedBackground("bg-job", "background");
    await batchSetConversationPlacement([
      { id: conv.id, groupId: "system:pinned" },
    ]);

    await batchSetConversationPlacement([
      { id: conv.id, groupId: "system:all" },
    ]);

    expect(await titlesInGroup("system:all")).toEqual(["bg-job"]);
  });
});

describePg("filing a background conversation into a custom group", () => {
  test("shows it in that group", async () => {
    const group = await createGroup("Car Chat");
    const conv = await seedRoutedBackground("bg-job", "background");

    await batchSetConversationPlacement([{ id: conv.id, groupId: group.id }]);

    expect(await titlesInGroup(group.id)).toEqual(["bg-job"]);
  });

  test("removing it from the group lands it in Recents rather than losing it", async () => {
    const group = await createGroup("Car Chat");
    const conv = await seedRoutedBackground("bg-job", "background");
    await batchSetConversationPlacement([{ id: conv.id, groupId: group.id }]);

    await batchSetConversationPlacement([
      { id: conv.id, groupId: "system:all" },
    ]);

    expect(await titlesInGroup("system:all")).toEqual(["bg-job"]);
    expect(await visibleTitles()).toEqual(["bg-job"]);
  });

  test("applies to scheduled conversations too", async () => {
    const group = await createGroup("Morning Briefs");
    const conv = await seedRoutedBackground("sched-job", "scheduled");

    await batchSetConversationPlacement([{ id: conv.id, groupId: group.id }]);
    await batchSetConversationPlacement([
      { id: conv.id, groupId: "system:all" },
    ]);

    expect(await titlesInGroup("system:all")).toEqual(["sched-job"]);
  });
});

describePg("what promotion must not do", () => {
  test("filing into system:background still demotes", async () => {
    const conv = await seedRoutedBackground("bg-job", "background");
    // Promote first, so the demotion has something to undo.
    await batchSetConversationPlacement([
      { id: conv.id, groupId: "system:pinned" },
    ]);
    expect(await titlesInGroup("system:pinned")).toEqual(["bg-job"]);

    await batchSetConversationPlacement([
      { id: conv.id, groupId: "system:background" },
    ]);

    expect(await visibleTitles()).toEqual([]);
  });

  test("a background conversation nobody placed anywhere stays hidden", async () => {
    await seedRoutedBackground("untouched", "background");

    expect(await visibleTitles()).toEqual([]);
  });

  test("moving to system:all does not by itself promote", async () => {
    // Removal is not a promotion: a row that was never filed into a section
    // the user reads must not become visible just by being moved out of its
    // system bucket.
    const conv = await seedRoutedBackground("bg-job", "background");

    await batchSetConversationPlacement([
      { id: conv.id, groupId: "system:all" },
    ]);

    expect(await visibleTitles()).toEqual([]);
  });

  test("unpinning through the legacy isPinned path still lands in Recents", async () => {
    // Old clients send `isPinned: false` with no `groupId`, and that branch
    // restores the row's original system bucket to keep its provenance. It
    // deliberately does not clear the promotion: unpinning is not a demotion,
    // so the conversation belongs in Recents afterwards, the same as the
    // modern path that sends `groupId: "system:all"`.
    //
    // The row therefore sits in `system:background` while remaining visible.
    // That is the intended split: the bucket records where the conversation
    // came from, `surfaced_at` records that the user promoted it, and only
    // an explicit demotion clears the latter.
    const conv = await seedRoutedBackground("bg-job", "background");
    await batchSetConversationPlacement([
      { id: conv.id, groupId: "system:pinned" },
    ]);

    await batchSetConversationPlacement([{ id: conv.id, isPinned: false }]);

    expect(await visibleTitles()).toEqual(["bg-job"]);
    expect(await titlesInGroup("system:all")).toEqual(["bg-job"]);
  });

  test("standard conversations are not stamped as surfaced", async () => {
    // They are already visible, so stamping them would leave `surfaced_at`
    // meaning nothing.
    const group = await createGroup("Car Chat");
    const conv = await createConversation("plain-chat");

    await batchSetConversationPlacement([{ id: conv.id, groupId: group.id }]);

    const row = await requireMainDb().get<{ surfaced_at: number | null }>(
      "SELECT surfaced_at FROM conversations WHERE id = ?",
      [conv.id],
    );
    expect(row?.surfaced_at).toBeNull();
  });
});
