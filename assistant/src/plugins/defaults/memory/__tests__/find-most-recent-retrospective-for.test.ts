import { beforeEach, expect, test } from "bun:test";

import { describePg } from "../../../../__tests__/pg-test-db.js";
import { createConversation } from "../../../../persistence/conversation-crud.js";
import { requireMainDb } from "../../../../persistence/db-facade.js";
import { findMostRecentRetrospectiveFor } from "../find-most-recent-retrospective-for.js";
import { MEMORY_RETROSPECTIVE_SOURCE } from "../memory-retrospective-constants.js";

async function resetTables(): Promise<void> {
  const db = requireMainDb();
  await db.run(`DELETE FROM messages`);
  await db.run(`DELETE FROM conversations`);
}

async function setForkParent(
  conversationId: string,
  parentId: string,
): Promise<void> {
  await requireMainDb().run(
    "UPDATE conversations SET fork_parent_conversation_id = ? WHERE id = ?",
    [parentId, conversationId],
  );
}

async function setCreatedAt(
  conversationId: string,
  createdAt: number,
): Promise<void> {
  await requireMainDb().run(
    "UPDATE conversations SET created_at = ? WHERE id = ?",
    [createdAt, conversationId],
  );
}

async function createRetro(
  parentId: string,
  createdAt: number,
): Promise<{ id: string }> {
  const retro = await createConversation({
    title: "retro",
    source: MEMORY_RETROSPECTIVE_SOURCE,
  });
  await setForkParent(retro.id, parentId);
  await setCreatedAt(retro.id, createdAt);
  return { id: retro.id };
}

describePg("findMostRecentRetrospectiveFor", () => {
  beforeEach(async () => {
    await resetTables();
  });

  test("returns null when no retrospective exists anywhere in the fork chain", async () => {
    const conv = await createConversation("conv");
    expect(await findMostRecentRetrospectiveFor(conv.id)).toBeNull();
  });

  test("returns a direct retrospective rooted at the conversation", async () => {
    const conv = await createConversation("conv");
    const retro = await createRetro(conv.id, 1_000);

    expect(await findMostRecentRetrospectiveFor(conv.id)).toEqual({
      id: retro.id,
      forkParentConversationId: conv.id,
    });
  });

  test("returns the most recently created retrospective when multiple exist at the same level", async () => {
    const conv = await createConversation("conv");
    await createRetro(conv.id, 1_000);
    const newer = await createRetro(conv.id, 2_000);
    await createRetro(conv.id, 500);

    expect(await findMostRecentRetrospectiveFor(conv.id)).toEqual({
      id: newer.id,
      forkParentConversationId: conv.id,
    });
  });

  test("walks up the fork chain when the current conversation has no retros", async () => {
    const parent = await createConversation("parent");
    const parentRetro = await createRetro(parent.id, 1_000);

    const fork = await createConversation("fork");
    await setForkParent(fork.id, parent.id);

    expect(await findMostRecentRetrospectiveFor(fork.id)).toEqual({
      id: parentRetro.id,
      // Owned by the PARENT — callers must not GC it on the fork's behalf.
      forkParentConversationId: parent.id,
    });
  });

  test("prefers the fork's own retros over the parent's", async () => {
    const parent = await createConversation("parent");
    await createRetro(parent.id, 5_000);

    const fork = await createConversation("fork");
    await setForkParent(fork.id, parent.id);
    const forkRetro = await createRetro(fork.id, 1_000);

    expect(await findMostRecentRetrospectiveFor(fork.id)).toEqual({
      id: forkRetro.id,
      forkParentConversationId: fork.id,
    });
  });

  test("walks multiple levels (fork-of-fork) until it finds a retro", async () => {
    const grandparent = await createConversation("grandparent");
    const grandparentRetro = await createRetro(grandparent.id, 1_000);

    const parent = await createConversation("parent");
    await setForkParent(parent.id, grandparent.id);

    const fork = await createConversation("fork");
    await setForkParent(fork.id, parent.id);

    expect(await findMostRecentRetrospectiveFor(fork.id)).toEqual({
      id: grandparentRetro.id,
      forkParentConversationId: grandparent.id,
    });
  });

  test("returns null when the entire fork chain has no retros", async () => {
    const grandparent = await createConversation("grandparent");
    const parent = await createConversation("parent");
    await setForkParent(parent.id, grandparent.id);
    const fork = await createConversation("fork");
    await setForkParent(fork.id, parent.id);

    expect(await findMostRecentRetrospectiveFor(fork.id)).toBeNull();
  });
});
