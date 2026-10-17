/**
 * Tests for the `includeArchived` option on the agent-facing conversation
 * history search.
 *
 * The `"*"` wildcard takes its own branch (FTS reads `*` as a literal), so it
 * has to honor the option through the list read rather than through
 * `searchConversations`, which has its own coverage in
 * `persistence/__tests__/conversation-queries-search.test.ts`.
 */

import { beforeEach, expect, test } from "bun:test";

import { describePg } from "../../../__tests__/pg-test-db.js";
import { createConversation } from "../../../persistence/conversation-crud.js";
import { requireMainDb } from "../../../persistence/db-facade.js";
import { performConversationSearch } from "../conversation-history.js";

async function seedArchived(title: string): Promise<string> {
  const conv = await createConversation({ title });
  await requireMainDb().run(
    "UPDATE conversations SET archived_at = ? WHERE id = ?",
    [Date.now(), conv.id],
  );
  return conv.id;
}

describePg("performConversationSearch · wildcard listing", () => {
  beforeEach(async () => {
    await requireMainDb().orm.delete(requireMainDb().schema.conversations);
  });

  test("omits archived conversations by default", async () => {
    await createConversation("live-1");
    await seedArchived("archived-1");

    const results = await performConversationSearch({ query: "*" });

    expect(results.map((r) => r.conversationTitle)).toEqual(["live-1"]);
  });

  test("includeArchived reaches archived conversations", async () => {
    await createConversation("live-1");
    await seedArchived("archived-1");

    const results = await performConversationSearch({
      query: "*",
      includeArchived: true,
    });

    expect(results.map((r) => r.conversationTitle).sort()).toEqual([
      "archived-1",
      "live-1",
    ]);
  });
});
