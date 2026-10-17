import { expect, test } from "bun:test";

import { describePg } from "../__tests__/pg-test-db.js";
import { createConversation } from "../persistence/conversation-crud.js";
import { requireMainDb } from "../persistence/db-facade.js";
import {
  assembleUserContentBlocks,
  offloadLinkPlan,
  offloadOversizedText,
  OVERSIZED_CONTENT_FILENAME_PREFIX,
  OVERSIZED_CONTENT_NOTE,
  oversizedContentFilename,
} from "./port-oversized-content.js";

const OVERSIZED_FILENAME_RE = /^oversized-content-[0-9a-f-]{36}\.txt$/;

async function resetTables(): Promise<void> {
  const db = requireMainDb();
  await db.run("DELETE FROM message_attachments");
  await db.run("DELETE FROM attachments");
  await db.run("DELETE FROM messages");
  await db.run("DELETE FROM conversations");
}

describePg("offloadOversizedText", () => {
  test("leaves text under the cap unchanged", async () => {
    await resetTables();
    const conv = await createConversation();
    const result = await offloadOversizedText("hello", {
      conversationId: conv.id,
      conversationCreatedAt: conv.createdAt,
    });
    expect(result).toEqual({ text: "hello" });
  });

  test("ports over-cap text into a workspace_ref attachment", async () => {
    await resetTables();
    const conv = await createConversation();
    const original = "x".repeat(32);
    const result = await offloadOversizedText(
      original,
      {
        conversationId: conv.id,
        conversationCreatedAt: conv.createdAt,
      },
      16,
    );

    expect(result.text).toBe(OVERSIZED_CONTENT_NOTE);
    expect(result.attachmentId).toBeDefined();
    expect(result.filename).toMatch(OVERSIZED_FILENAME_RE);
    expect(result.fileBlock).toMatchObject({
      type: "file",
      source: {
        type: "workspace_ref",
        media_type: "text/plain",
        filename: result.filename,
        attachmentId: result.attachmentId,
      },
    });
    expect(JSON.stringify(result)).not.toContain(original);
    if (result.fileBlock === undefined) {
      throw new Error("expected an offloaded file block");
    }

    const blocks = assembleUserContentBlocks(result.text, [], result.fileBlock);
    expect(JSON.stringify(blocks)).not.toContain(original);
    expect(blocks[0]).toEqual({ type: "text", text: OVERSIZED_CONTENT_NOTE });
    expect(blocks[1]).toEqual(result.fileBlock);
  });

  test("assigns a distinct generated filename per offload in one conversation", async () => {
    await resetTables();
    const conv = await createConversation();
    const ctx = {
      conversationId: conv.id,
      conversationCreatedAt: conv.createdAt,
    };
    const first = await offloadOversizedText("a".repeat(32), ctx, 16);
    const second = await offloadOversizedText("b".repeat(32), ctx, 16);

    expect(first.filename).toMatch(OVERSIZED_FILENAME_RE);
    expect(second.filename).toMatch(OVERSIZED_FILENAME_RE);
    expect(first.filename).not.toBe(second.filename);
    expect(first.filename).toContain(OVERSIZED_CONTENT_FILENAME_PREFIX);
  });
});

describePg("oversizedContentFilename", () => {
  test("embeds the given id", () => {
    expect(
      oversizedContentFilename("11111111-1111-1111-1111-111111111111"),
    ).toBe("oversized-content-11111111-1111-1111-1111-111111111111.txt");
  });
});

describePg("offloadLinkPlan", () => {
  test("same persist and live id is linked and model-facing", () => {
    const plan = offloadLinkPlan("att-1", "att-1");
    expect(plan.linkIds).toEqual(["att-1"]);
    expect([...plan.modelFacingIds]).toEqual(["att-1"]);
  });

  test("display-only persist offload is linked but not model-facing", () => {
    const plan = offloadLinkPlan("att-display", undefined);
    expect(plan.linkIds).toEqual(["att-display"]);
    expect(plan.modelFacingIds.size).toBe(0);
  });

  test("distinct persist and live ids keep only live model-facing", () => {
    const plan = offloadLinkPlan("att-display", "att-live");
    expect(plan.linkIds).toEqual(["att-display", "att-live"]);
    expect([...plan.modelFacingIds]).toEqual(["att-live"]);
  });
});
