/**
 * Tests for the monitor-side read of in-flight conversations. Rows are written
 * to the process's Postgres test schema through the shared async facade, which
 * is also what the module under test reads.
 */

import { beforeEach, expect, test } from "bun:test";

import { describePg } from "../../__tests__/pg-test-db.js";
import { requireMainDb } from "../../persistence/db-facade.js";
import { initializeDb } from "../../persistence/db-init.js";
import { readActiveConversations } from "../active-conversations.js";

await initializeDb();

async function clearConversations(): Promise<void> {
  await requireMainDb().run("DELETE FROM conversations");
}

describePg("readActiveConversations", () => {
  beforeEach(async () => {
    await clearConversations();
  });

  test("returns processing conversations, longest-running first", async () => {
    const db = requireMainDb();
    await db.run(
      "INSERT INTO conversations (id, title, origin_channel, origin_interface, processing_started_at, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)",
      ["conv-new", "Newer turn", "slack", "web", 2_000, 0, 0],
    );
    await db.run(
      "INSERT INTO conversations (id, title, origin_channel, origin_interface, processing_started_at, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)",
      ["conv-old", "Memory consolidation", null, null, 1_000, 0, 0],
    );
    await db.run(
      "INSERT INTO conversations (id, title, origin_channel, origin_interface, processing_started_at, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)",
      ["conv-idle", "Finished turn", null, null, null, 0, 0],
    );

    expect(await readActiveConversations()).toEqual([
      {
        conversationId: "conv-old",
        title: "Memory consolidation",
        originChannel: null,
        originInterface: null,
        processingStartedAt: 1_000,
      },
      {
        conversationId: "conv-new",
        title: "Newer turn",
        originChannel: "slack",
        originInterface: "web",
        processingStartedAt: 2_000,
      },
    ]);
  });

  test("truncates long titles", async () => {
    await requireMainDb().run(
      "INSERT INTO conversations (id, title, processing_started_at, created_at, updated_at) VALUES (?, ?, ?, ?, ?)",
      ["conv-long", "x".repeat(500), 1_000, 0, 0],
    );

    const active = await readActiveConversations();
    expect(active![0].title).toHaveLength(80);
  });

  test("returns null when nothing is processing", async () => {
    expect(await readActiveConversations()).toBeNull();
  });
});
