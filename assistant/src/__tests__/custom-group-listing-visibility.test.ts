import { beforeEach, expect, test } from "bun:test";

import { createConversation } from "../persistence/conversation-crud.js";
import { ensureGroupMigrationAsync } from "../persistence/conversation-group-migration.js";
import { listConversations } from "../persistence/conversation-queries.js";
import { requireMainDb } from "../persistence/db-facade.js";
import { createGroup } from "../persistence/group-crud.js";
import { describePg } from "./pg-test-db.js";

await ensureGroupMigrationAsync();

/**
 * Custom-group arm of standard-listing visibility: a row filed into a
 * user-created group renders in the standard (Recents) listing regardless of
 * conversation type, so custom groups survive a cold sidebar load. System
 * groups keep the type-based exclusions, and private/subagent rows stay
 * hidden unconditionally.
 */
describePg("custom-group standard-listing visibility", () => {
  let groupId: string;

  beforeEach(async () => {
    const raw = requireMainDb();
    await raw.run("DELETE FROM conversations");
    await raw.run("DELETE FROM conversation_groups WHERE is_system_group = 0");
    groupId = (await createGroup("Briefs")).id;
  });

  async function listedIds(): Promise<string[]> {
    return (await listConversations({ conversationType: "standard" })).map(
      (c) => c.id,
    );
  }

  test("scheduled conversation in a custom group is listed", async () => {
    await createConversation({
      id: "conv-sched-custom",
      conversationType: "scheduled",
      source: "schedule",
      groupId,
    });

    expect(await listedIds()).toContain("conv-sched-custom");
  });

  test("background conversation in a custom group is listed", async () => {
    await createConversation({
      id: "conv-bg-custom",
      conversationType: "background",
      source: "task",
      groupId,
    });

    expect(await listedIds()).toContain("conv-bg-custom");
  });

  test("scheduled conversation in system:scheduled stays excluded", async () => {
    await createConversation({
      id: "conv-sched-system",
      conversationType: "scheduled",
      source: "schedule",
      groupId: "system:scheduled",
    });

    expect(await listedIds()).not.toContain("conv-sched-system");
  });

  test("subagent conversation stays hidden even in a custom group", async () => {
    await createConversation({
      id: "conv-subagent-custom",
      conversationType: "background",
      source: "subagent",
      groupId,
    });

    expect(await listedIds()).not.toContain("conv-subagent-custom");
  });

  test("private conversation stays hidden even in a custom group", async () => {
    // "private" is not a creatable type (legacy rows only, see the
    // conversationTypeClause docstring), so simulate a legacy row directly.
    await createConversation({ id: "conv-private-custom", groupId });
    await requireMainDb().run(
      "UPDATE conversations SET conversation_type = 'private' WHERE id = 'conv-private-custom'",
    );

    expect(await listedIds()).not.toContain("conv-private-custom");
  });
});
