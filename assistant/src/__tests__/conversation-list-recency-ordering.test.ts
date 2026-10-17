import { beforeEach, expect, test } from "bun:test";

import { createConversation } from "../persistence/conversation-crud.js";
import { ensureGroupMigrationAsync } from "../persistence/conversation-group-migration.js";
import {
  listConversations,
  listPinnedConversations,
} from "../persistence/conversation-queries.js";
import { requireMainDb } from "../persistence/db-facade.js";
import { createGroup } from "../persistence/group-crud.js";
import { describePg } from "./pg-test-db.js";

await ensureGroupMigrationAsync();

/**
 * Every conversation list orders by recency, pinned and custom groups
 * included.
 *
 * `display_order` is a live column and some rows carry a value in it, so
 * "nothing writes it" is not enough to make the order consistent: a read that
 * consulted it would serve those rows in an arrangement no user can change,
 * while every other surface shows recency.
 *
 * Each test sets `display_order` to contradict recency, so a read that
 * consults it fails here rather than passing by coincidence.
 */
describePg("conversation list ordering ignores display_order", () => {
  beforeEach(async () => {
    const db = requireMainDb();
    await db.run("DELETE FROM conversations");
    await db.run("DELETE FROM conversation_groups WHERE is_system_group = 0");
  });

  /** Give a row a `display_order` and a recency stamp that disagree. */
  async function arrange(
    id: string,
    displayOrder: number,
    lastMessageAt: number,
  ): Promise<void> {
    await requireMainDb().run(
      "UPDATE conversations SET display_order = ?, last_message_at = ? WHERE id = ?",
      [displayOrder, lastMessageAt, id],
    );
  }

  test("a custom group orders by recency, ignoring display_order", async () => {
    const groupId = (await createGroup("Briefs")).id;
    await createConversation({ id: "conv-old", source: "user", groupId });
    await createConversation({ id: "conv-new", source: "user", groupId });
    // `display_order` says old-then-new; recency says the opposite.
    await arrange("conv-old", 0, 1_000);
    await arrange("conv-new", 1, 9_000);

    expect((await listConversations({ groupId })).map((c) => c.id)).toEqual([
      "conv-new",
      "conv-old",
    ]);
  });

  test("the pinned group orders by recency, ignoring display_order", async () => {
    await createConversation({
      id: "pin-old",
      source: "user",
      groupId: "system:pinned",
    });
    await createConversation({
      id: "pin-new",
      source: "user",
      groupId: "system:pinned",
    });
    await arrange("pin-old", 0, 1_000);
    await arrange("pin-new", 1, 9_000);

    expect(
      (await listConversations({ groupId: "system:pinned" })).map((c) => c.id),
    ).toEqual(["pin-new", "pin-old"]);
  });

  /* The page-one pinned injection reads through its own query, so it needs
     the same guarantee: one section must not have two orderings depending on
     which read served it. */
  test("listPinnedConversations orders by recency too", async () => {
    await createConversation({
      id: "pin-old",
      source: "user",
      groupId: "system:pinned",
    });
    await createConversation({
      id: "pin-new",
      source: "user",
      groupId: "system:pinned",
    });
    await requireMainDb().run("UPDATE conversations SET is_pinned = 1");
    await arrange("pin-old", 0, 1_000);
    await arrange("pin-new", 1, 9_000);

    expect((await listPinnedConversations()).map((c) => c.id)).toEqual([
      "pin-new",
      "pin-old",
    ]);
  });
});
