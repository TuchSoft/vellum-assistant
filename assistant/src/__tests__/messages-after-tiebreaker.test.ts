import { beforeEach, expect, setDefaultTimeout, test } from "bun:test";
setDefaultTimeout(30_000);

import {
  countMessagesAfter,
  getMessagesAfter,
} from "../persistence/conversation-crud.js";
import { requireMainDb } from "../persistence/db-facade.js";
import { resolveMessagesAfterBound } from "../persistence/message-cursor.js";
import { describePg } from "./pg-test-db.js";

const CONV_ID = "conv-tiebreaker";

async function clearDb(): Promise<void> {
  const db = requireMainDb();
  await db.run("DELETE FROM messages");
  await db.run("DELETE FROM conversations");
}

async function seedConversation(): Promise<void> {
  const now = Date.now();
  const db = requireMainDb();
  await db.orm.insert(db.schema.conversations).values({
    id: CONV_ID,
    title: null,
    createdAt: now,
    updatedAt: now,
    source: "test",
    conversationType: "default",
  });
}

async function insertMessage(id: string, createdAt: number): Promise<void> {
  const db = requireMainDb();
  await db.orm.insert(db.schema.messages).values({
    id,
    conversationId: CONV_ID,
    role: "user",
    content: "",
    createdAt,
    metadata: null,
  });
}

describePg(
  "countMessagesAfter / getMessagesAfter — millisecond-collision tie-breaker",
  () => {
    beforeEach(async () => {
      await clearDb();
      await seedConversation();
    });

    test("messages sharing a millisecond timestamp with the reference are NOT permanently skipped (countMessagesAfter)", async () => {
      const ts = 1_700_000_000_000;
      // Both messages share the exact same createdAt — id "b" sorts after
      // id "a" lexicographically. Without a tie-breaker the second message
      // would never be counted.
      await insertMessage("a", ts);
      await insertMessage("b", ts);

      expect(await countMessagesAfter(CONV_ID, "a")).toBe(1);
    });

    test("messages sharing a millisecond timestamp with the reference are NOT permanently skipped (getMessagesAfter)", async () => {
      const ts = 1_700_000_000_000;
      await insertMessage("a", ts);
      await insertMessage("b", ts);

      const result = await getMessagesAfter(CONV_ID, "a");
      expect(result.map((m) => m.id)).toEqual(["b"]);
    });

    test("strict-after semantics: a message with id sorting BEFORE the reference but identical timestamp is NOT included", async () => {
      const ts = 1_700_000_000_000;
      // "a" sorts before "b". Reference is "b", so "a" should be excluded
      // (strictly-after semantics, not "all rows at the same timestamp").
      await insertMessage("a", ts);
      await insertMessage("b", ts);

      expect(await countMessagesAfter(CONV_ID, "b")).toBe(0);
      expect(await getMessagesAfter(CONV_ID, "b")).toEqual([]);
    });

    test("mixed collision + later timestamps: counts both same-ts tie-breaker rows and strictly-later rows", async () => {
      const ts = 1_700_000_000_000;
      await insertMessage("a", ts);
      await insertMessage("b", ts);
      await insertMessage("c", ts);
      await insertMessage("d", ts + 1);

      expect(await countMessagesAfter(CONV_ID, "a")).toBe(3);
      const result = await getMessagesAfter(CONV_ID, "a");
      expect(result.map((m) => m.id)).toEqual(["b", "c", "d"]);
    });

    test("missing reference returns 0/[] (conservative semantics preserved)", async () => {
      await insertMessage("a", 1_700_000_000_000);
      expect(await countMessagesAfter(CONV_ID, "nonexistent")).toBe(0);
      expect(await getMessagesAfter(CONV_ID, "nonexistent")).toEqual([]);
    });

    test("null/empty reference still returns all messages", async () => {
      const ts = 1_700_000_000_000;
      await insertMessage("a", ts);
      await insertMessage("b", ts);

      expect(await countMessagesAfter(CONV_ID, null)).toBe(2);
      expect(await countMessagesAfter(CONV_ID, "")).toBe(2);
      expect(await getMessagesAfter(CONV_ID, null)).toHaveLength(2);
      expect(await getMessagesAfter(CONV_ID, "")).toHaveLength(2);
    });
  },
);

describePg(
  "countMessagesAfter / getMessagesAfter: a cursor survives its row's deletion",
  () => {
    beforeEach(async () => {
      await clearDb();
      await seedConversation();
    });

    test("a cursor carrying createdAt keeps bounding the read after its row is deleted", async () => {
      const ts = 1_700_000_000_000;
      await insertMessage("a", ts);
      // The row the cursor points at: a reply the user then regenerates.
      await insertMessage("b", ts + 1);
      await insertMessage("c", ts + 2);
      await requireMainDb().run("DELETE FROM messages WHERE id = 'b'");
      // The regenerated reply.
      await insertMessage("d", ts + 3);

      const cursor = { id: "b", createdAt: ts + 1 };
      expect(await countMessagesAfter(CONV_ID, cursor)).toBe(2);
      expect(
        await (await getMessagesAfter(CONV_ID, cursor)).map((m) => m.id),
      ).toEqual(["c", "d"]);
    });

    test("a cursor without createdAt keeps the conservative id-only semantics once its row is gone", async () => {
      await insertMessage("a", 1_700_000_000_000);

      const cursor = { id: "nonexistent", createdAt: null };
      expect(await countMessagesAfter(CONV_ID, cursor)).toBe(0);
      expect(await getMessagesAfter(CONV_ID, cursor)).toEqual([]);
    });

    test("the live row wins over the timestamp the cursor carries", async () => {
      const ts = 1_700_000_000_000;
      await insertMessage("a", ts);
      await insertMessage("b", ts + 10);

      // A stale cursor timestamp must not pull processed rows back in, nor
      // hide unprocessed ones, while the row itself can still be read.
      expect(
        await countMessagesAfter(CONV_ID, { id: "b", createdAt: ts - 100 }),
      ).toBe(0);
      expect(
        await countMessagesAfter(CONV_ID, { id: "a", createdAt: ts + 999 }),
      ).toBe(1);
    });

    test("a cursor with an empty id reads everything, like null and the empty string", async () => {
      await insertMessage("a", 1_700_000_000_000);

      expect(await countMessagesAfter(CONV_ID, { id: "", createdAt: 5 })).toBe(
        1,
      );
      expect(
        await getMessagesAfter(CONV_ID, { id: "", createdAt: 5 }),
      ).toHaveLength(1);
    });
  },
);

describePg("resolveMessagesAfterBound", () => {
  beforeEach(async () => {
    await clearDb();
    await seedConversation();
  });

  test("resolves the unbounded, live-row, stored-timestamp, and vanished cases", async () => {
    await insertMessage("a", 1_000);

    expect(await resolveMessagesAfterBound(null)).toEqual({ kind: "all" });
    expect(await resolveMessagesAfterBound("")).toEqual({ kind: "all" });
    expect(await resolveMessagesAfterBound({ id: "", createdAt: 3 })).toEqual({
      kind: "all",
    });
    expect(await resolveMessagesAfterBound("a")).toEqual({
      kind: "after",
      bound: { createdAt: 1_000, id: "a" },
    });
    expect(await resolveMessagesAfterBound({ id: "a", createdAt: 99 })).toEqual(
      {
        kind: "after",
        bound: { createdAt: 1_000, id: "a" },
      },
    );
    expect(await resolveMessagesAfterBound("gone")).toEqual({
      kind: "vanished",
    });
    expect(
      await resolveMessagesAfterBound({ id: "gone", createdAt: null }),
    ).toEqual({
      kind: "vanished",
    });
    expect(
      await resolveMessagesAfterBound({ id: "gone", createdAt: 7 }),
    ).toEqual({
      kind: "after",
      bound: { createdAt: 7, id: "gone" },
    });
  });
});
