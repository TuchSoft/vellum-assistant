/**
 * Route-level tests for the conversations import route.
 *
 * Covers two behaviors: non-renderable roles are never persisted (the
 * messages store is UI-facing (`ConversationMessage`), so an imported export
 * carrying agent-context `system` rows must land only its `user`/`assistant`
 * turns; the `system` rows are dropped, not persisted), and imported
 * conversations carry a provenance `source` derived from the `sourceKey`
 * prefix (`import:<provider>`, or `import:unknown` when absent).
 */

import { beforeEach, expect, mock, test } from "bun:test";

mock.module("../plugins/defaults/memory/indexer.js", () => ({
  indexMessageNow: async () => {},
}));

import { getMessages } from "../persistence/conversation-crud.js";
import { requireMainDb } from "../persistence/db-facade.js";
import { ROUTES } from "../runtime/routes/conversations-import-routes.js";
import type { RouteHandlerArgs } from "../runtime/routes/types.js";
import { describePg } from "./pg-test-db.js";

async function resetTables() {
  const db = requireMainDb();
  await db.run("DELETE FROM message_attachments");
  await db.run("DELETE FROM attachments");
  await db.run("DELETE FROM messages");
  await db.run("DELETE FROM conversation_keys");
  await db.run("DELETE FROM conversations");
}

const importHandler = ROUTES.find(
  (r) => r.operationId === "conversations_import",
)!.handler;

describePg("conversations import system-row filtering", () => {
  beforeEach(resetTables);

  test("imports renderable turns but drops system rows", async () => {
    // GIVEN an export whose conversation sandwiches a system row between two
    // renderable turns (e.g. agent-context scaffolding an export carried)
    const body = {
      conversations: [
        {
          sourceKey: "src-1",
          title: "Imported chat",
          messages: [
            { role: "user", content: "first visible" },
            { role: "system", content: "agent-context scaffolding" },
            { role: "assistant", content: "second visible" },
          ],
        },
      ],
    };

    // WHEN the conversation is imported
    const result = (await importHandler({
      body,
    } as unknown as RouteHandlerArgs)) as {
      ok: boolean;
      imported: number;
      messages: number;
    };

    // THEN the import succeeds and only counts the renderable turns
    expect(result.ok).toBe(true);
    expect(result.imported).toBe(1);
    expect(result.messages).toBe(2);

    // AND the persisted rows are exactly the user/assistant turns, never the
    // system scaffolding
    const db = requireMainDb();
    const conv = (
      await db.all<{ id: string }>("SELECT * FROM conversations")
    )[0]!;
    const rows = await getMessages(conv.id);
    expect(rows.map((m) => m.role)).toEqual(["user", "assistant"]);
    expect(
      (await db.all<{ role: string }>("SELECT * FROM messages")).some(
        (m) => m.role === "system",
      ),
    ).toBe(false);
  });
});

describePg("conversations import provenance source", () => {
  beforeEach(resetTables);

  test("stamps import:<provider> from a prefixed sourceKey and keeps dedup", async () => {
    // GIVEN an export whose sourceKey carries a provider prefix
    const body = {
      conversations: [
        {
          sourceKey: "chatgpt:abc123",
          title: "ChatGPT import",
          messages: [{ role: "user", content: "hello" }],
        },
      ],
    };

    // WHEN the conversation is imported
    const result = (await importHandler({
      body,
    } as unknown as RouteHandlerArgs)) as { imported: number };
    expect(result.imported).toBe(1);

    // THEN the created row records the provider-derived provenance source
    const db = requireMainDb();
    const conv = (
      await db.all<{ source: string }>("SELECT * FROM conversations")
    )[0]!;
    expect(conv.source).toBe("import:chatgpt");

    // AND re-importing the same sourceKey still dedups (no second row)
    const again = (await importHandler({
      body,
    } as unknown as RouteHandlerArgs)) as { imported: number; skipped: number };
    expect(again.imported).toBe(0);
    expect(again.skipped).toBe(1);
    expect(await db.all("SELECT * FROM conversations")).toHaveLength(1);
  });

  test("normalizes non-canonical prefixes instead of dropping them", async () => {
    // GIVEN sourceKeys whose prefixes carry uppercase or underscore characters
    const body = {
      conversations: [
        {
          sourceKey: "OpenAI:abc",
          title: "Uppercase prefix",
          messages: [{ role: "user", content: "hello" }],
        },
        {
          sourceKey: "chat_gpt:def",
          title: "Underscore prefix",
          messages: [{ role: "user", content: "hello" }],
        },
      ],
    };

    // WHEN the conversations are imported
    const result = (await importHandler({
      body,
    } as unknown as RouteHandlerArgs)) as { imported: number };
    expect(result.imported).toBe(2);

    // THEN each prefix is normalized into import:<provider>, not import:unknown
    const db = requireMainDb();
    const sources = (
      await db.all<{ source: string }>("SELECT * FROM conversations")
    )
      .map((row) => row.source)
      .sort();
    expect(sources).toEqual(["import:chat-gpt", "import:openai"]);
  });

  test("falls back to import:unknown when sourceKey is absent", async () => {
    // GIVEN an export entry with no sourceKey at all
    const body = {
      conversations: [
        {
          title: "Prefixless import",
          messages: [{ role: "user", content: "hello" }],
        },
      ],
    };

    // WHEN the conversation is imported
    const result = (await importHandler({
      body,
    } as unknown as RouteHandlerArgs)) as { imported: number };
    expect(result.imported).toBe(1);

    // THEN the created row falls back to the unknown-provider source
    const db = requireMainDb();
    const conv = (
      await db.all<{ source: string }>("SELECT * FROM conversations")
    )[0]!;
    expect(conv.source).toBe("import:unknown");
  });
});
