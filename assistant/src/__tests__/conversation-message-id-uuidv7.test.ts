import { beforeEach, expect, test } from "bun:test";

import {
  addMessage,
  createConversation,
} from "../persistence/conversation-crud.js";
import { requireMainDb } from "../persistence/db-facade.js";
import { describePg } from "./pg-test-db.js";

/** The UUID version nibble is the first hex digit of the third dash group. */
function uuidVersion(id: string): string {
  return id.split("-")[2]?.[0] ?? "";
}

describePg("conversation & message ids use UUIDv7", () => {
  beforeEach(async () => {
    const db = requireMainDb();
    await db.run("DELETE FROM messages");
    await db.run("DELETE FROM conversations");
  });

  test("server-generated conversation ids are v7 and monotonic", async () => {
    const ids: string[] = [];
    for (let i = 0; i < 5; i++) {
      ids.push((await createConversation({ title: `c${i}` })).id);
    }

    for (const id of ids) {
      expect(uuidVersion(id)).toBe("7");
    }
    // Time-ordered: ids sort in creation order (this is the append property).
    expect([...ids].sort()).toEqual(ids);
    expect(new Set(ids).size).toBe(ids.length);
  });

  test("server-generated message ids are v7", async () => {
    const conv = await createConversation({ title: "messages" });
    const ids: string[] = [];
    for (let i = 0; i < 5; i++) {
      const m = await addMessage(conv.id, "assistant", `m${i}`, {
        skipIndexing: true,
      });
      ids.push(m.id);
    }

    for (const id of ids) {
      expect(uuidVersion(id)).toBe("7");
    }
    expect([...ids].sort()).toEqual(ids);
  });

  test("an explicitly supplied message id is still adopted verbatim", async () => {
    const conv = await createConversation({ title: "adopt" });
    const requestId = "11111111-2222-4333-8444-555555555555"; // a v4-shaped id
    const m = await addMessage(conv.id, "user", "hi", {
      id: requestId,
      skipIndexing: true,
    });
    expect(m.id).toBe(requestId);
  });
});
