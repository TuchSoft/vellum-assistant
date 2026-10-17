import { randomUUID } from "node:crypto";
import { beforeEach, describe, expect, test } from "bun:test";

import { addMessage, getMessages } from "../persistence/conversation-crud.js";
import { requireMainDb } from "../persistence/db-facade.js";

async function ensureConversation(id: string): Promise<void> {
  const db = requireMainDb();
  const now = Date.now();
  await db.run(
    "INSERT INTO conversations (id, title, created_at, updated_at, last_message_at) VALUES (?, ?, ?, ?, ?) ON CONFLICT (id) DO NOTHING",
    [id, "test", now, now, now],
  );
}

describe("addMessage pre-assigned id", () => {
  beforeEach(async () => {
    await ensureConversation("conv-preassigned-id");
  });

  test("uses the provided id as the persisted row id", async () => {
    const customId = randomUUID();
    const result = await addMessage("conv-preassigned-id", "user", "hello", {
      id: customId,
    });

    expect(result.id).toBe(customId);
    expect(result.deduplicated).toBe(false);

    const msgs = await getMessages("conv-preassigned-id");
    const found = msgs.find((m) => m.id === customId);
    expect(found).toBeDefined();
    expect(found?.content).toEqual([{ type: "text", text: "hello" }]);
  });

  test("generates a uuid when no id is provided", async () => {
    const result = await addMessage("conv-preassigned-id", "user", "world");

    expect(result.id).toBeTruthy();
    expect(result.deduplicated).toBe(false);
    // Should be a UUID-like string (36 chars with hyphens)
    expect(result.id).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/,
    );
  });
});
