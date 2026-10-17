import { beforeEach, expect, setDefaultTimeout, test } from "bun:test";
setDefaultTimeout(30_000);

import { referenceMediaBlocksForPersist } from "../daemon/persist-media-references.js";
import { getAttachmentsForMessage } from "../persistence/attachments-store.js";
import {
  addMessage,
  createConversation,
} from "../persistence/conversation-crud.js";
import { requireMainDb } from "../persistence/db-facade.js";
import { mediaSourceBytes } from "../providers/media-resolve.js";
import type { ContentBlock } from "../providers/types.js";
import { describePg } from "./pg-test-db.js";

async function resetTables(): Promise<void> {
  const db = requireMainDb();
  await db.run("DELETE FROM message_attachments");
  await db.run("DELETE FROM attachments");
  await db.run("DELETE FROM messages");
  await db.run("DELETE FROM conversations");
}

// "aGVsbG8=" = "hello"
const IMAGE_B64 = Buffer.from("hello").toString("base64");

describePg("referenceMediaBlocksForPersist", () => {
  beforeEach(async () => {
    await resetTables();
  });

  test("materializes tool_result base64 media into a linked workspace_ref", async () => {
    const conv = await createConversation();
    const msg = await addMessage(conv.id, "user", "tool results");

    const blocks: ContentBlock[] = [
      {
        type: "tool_result",
        tool_use_id: "tool-1",
        content: "screenshot captured",
        contentBlocks: [
          {
            type: "image",
            source: {
              type: "base64",
              media_type: "image/png",
              data: IMAGE_B64,
            },
          },
        ],
      },
    ];

    const referenced = await referenceMediaBlocksForPersist(
      conv.id,
      conv.createdAt,
      msg.id,
      blocks,
    );

    // The nested image is now a workspace_ref, not inline base64.
    const toolResult = referenced[0] as Extract<
      ContentBlock,
      { type: "tool_result" }
    >;
    const nested = toolResult.contentBlocks![0] as Extract<
      ContentBlock,
      { type: "image" }
    >;
    expect(nested.source.type).toBe("workspace_ref");
    expect(JSON.stringify(referenced)).not.toContain(IMAGE_B64);

    // The attachment row is linked to the message (GC anchor) and its bytes
    // resolve back to the original image.
    if (nested.source.type !== "workspace_ref") {
      throw new Error("expected ref");
    }
    const linked = await getAttachmentsForMessage(msg.id);
    expect(linked.map((a) => a.id)).toEqual([nested.source.attachmentId]);
    expect(mediaSourceBytes(nested.source)?.toString()).toBe("hello");
  });

  test("leaves an already-referenced block untouched and creates no row", async () => {
    const conv = await createConversation();
    const msg = await addMessage(conv.id, "user", "tool results");

    const blocks: ContentBlock[] = [
      {
        type: "tool_result",
        tool_use_id: "tool-1",
        content: "ok",
        contentBlocks: [
          {
            type: "image",
            source: {
              type: "workspace_ref",
              media_type: "image/png",
              attachmentId: "att-existing",
              sizeBytes: 5,
            },
          },
        ],
      },
    ];

    const referenced = await referenceMediaBlocksForPersist(
      conv.id,
      conv.createdAt,
      msg.id,
      blocks,
    );

    expect(referenced).toEqual(blocks);
    expect(await getAttachmentsForMessage(msg.id)).toHaveLength(0);
  });

  test("retries unresolved materialization and applies the computer-use filename", async () => {
    const conv = await createConversation();
    const msg = await addMessage(conv.id, "user", "tool results");
    const blocks: ContentBlock[] = [
      {
        type: "tool_result",
        tool_use_id: "computer-use-call",
        content: "clicked",
        contentBlocks: [
          {
            type: "image",
            source: {
              type: "base64",
              media_type: "image/png",
              data: IMAGE_B64,
            },
          },
        ],
      },
    ];
    const toolNames = new Map([["computer-use-call", "computer_use_click"]]);

    const unresolved = await referenceMediaBlocksForPersist(
      conv.id,
      conv.createdAt,
      "missing-message",
      blocks,
      toolNames,
    );
    expect(unresolved).toEqual(blocks);

    const recovered = await referenceMediaBlocksForPersist(
      conv.id,
      conv.createdAt,
      msg.id,
      unresolved,
      toolNames,
    );
    const nested = (
      recovered[0] as Extract<ContentBlock, { type: "tool_result" }>
    ).contentBlocks?.[0];
    if (!nested || nested.type !== "image") {
      throw new Error("expected recovered image");
    }
    expect(nested.source.type).toBe("workspace_ref");
    expect(await getAttachmentsForMessage(msg.id)).toEqual([
      expect.objectContaining({ originalFilename: "computer-use-click.png" }),
    ]);
  });
});
