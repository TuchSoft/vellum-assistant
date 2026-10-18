/**
 * Guards over `GET /v1/attachments?conversationId=`: the conversation
 * attachment listing that the Chat Info panel reads.
 *
 * Runs against a real database so the lineage predicate, the finalized
 * filter, and the camera-frame flags are exercised on stored rows rather than
 * on a stub's idea of them.
 */

import { beforeEach, expect, setDefaultTimeout, test } from "bun:test";

setDefaultTimeout(30_000);

import { describePg } from "../../__tests__/pg-test-db.js";
import { isToolResultOnlyUserMessage } from "../../conversations/message-consolidation.js";
import {
  linkAttachmentToMessage,
  setAttachmentThumbnail,
  uploadAttachment,
} from "../../persistence/attachments-store.js";
import {
  addMessage,
  createConversation,
  forkConversationForRetrospective,
  type MessageRow,
} from "../../persistence/conversation-crud.js";
import { requireMainDb } from "../../persistence/db-facade.js";
import { resolveMessageContentBlocks } from "../../persistence/message-content-file.js";
import { BadRequestError } from "./errors.js";

const { ROUTES } = await import("./attachment-routes.js");

interface ListedAttachment {
  id: string;
  filename: string;
  messageId: string;
  createdAt: number;
  sightFrame: boolean;
  ambientKeep: boolean;
  thumbnailData?: string;
}

interface ListResult {
  attachments: ListedAttachment[];
  total: number;
  hasMore: boolean;
}

async function listAttachments(
  queryParams: Record<string, string>,
): Promise<ListResult> {
  const route = ROUTES.find((r) => r.operationId === "attachment_list");
  if (!route) {
    throw new Error("attachment_list route not registered");
  }
  return (await route.handler({ queryParams })) as ListResult;
}

async function resetTables(): Promise<void> {
  const db = requireMainDb();
  await db.run("DELETE FROM message_attachments");
  await db.run("DELETE FROM attachments");
  await db.run("DELETE FROM messages");
  await db.run("DELETE FROM conversations");
}

async function setCreatedAt(
  messageId: string,
  createdAt: number,
): Promise<void> {
  await requireMainDb().run("UPDATE messages SET created_at = ? WHERE id = ?", [
    createdAt,
    messageId,
  ]);
}

async function setFinalized(
  messageId: string,
  finalized: number,
): Promise<void> {
  await requireMainDb().run("UPDATE messages SET finalized = ? WHERE id = ?", [
    finalized,
    messageId,
  ]);
}

async function setLinkId(attachmentId: string, linkId: string): Promise<void> {
  await requireMainDb().run(
    "UPDATE message_attachments SET id = ? WHERE attachment_id = ?",
    [linkId, attachmentId],
  );
}

async function setContent(messageId: string, content: string): Promise<void> {
  await requireMainDb().run("UPDATE messages SET content = ? WHERE id = ?", [
    content,
    messageId,
  ]);
}

/** The row the transcript classifier sees for a stored content string. */
function messageRowFor(content: string): MessageRow {
  return {
    id: "msg-parity",
    conversationId: "conv-parity",
    role: "user",
    content: resolveMessageContentBlocks(content),
    createdAt: 0,
    metadata: null,
    clientMessageId: null,
    finalized: 1,
  };
}

const SYSTEM_NOTICE = "<system_notice>done</system_notice>";

/** The grouped row the agent loop writes for a turn's tool results. */
function toolResultContent(toolUseId: string): string {
  return JSON.stringify([
    { type: "tool_result", tool_use_id: toolUseId, content: "ok" },
  ]);
}

const PNG_BASE64 = "iVBORw0K";

async function newAttachment(filename: string): Promise<string> {
  const uploaded = await uploadAttachment(filename, "image/png", PNG_BASE64);
  return uploaded.id;
}

async function newVideoAttachment(
  filename: string,
  thumbnail: string,
): Promise<string> {
  const uploaded = await uploadAttachment(filename, "video/mp4", PNG_BASE64);
  await setAttachmentThumbnail(uploaded.id, thumbnail);
  return uploaded.id;
}

interface Seeded {
  conversationId: string;
  photoA: string;
  photoB: string;
  photoC: string;
  ambientFrame: string;
  parkedFrame: string;
}

/**
 * A conversation carrying one attachment of every kind the listing has to tell
 * apart: plain photos, a standalone camera keep, a frame parked on a spoken
 * turn beside an ordinary photo, plus a hidden row, a channel-deleted row, and
 * an unfinalized row that must not surface at all.
 */
async function seedConversation(): Promise<Seeded> {
  const conversation = await createConversation("Camera thread");

  const photoA = await newAttachment("a.png");
  const first = await addMessage(conversation.id, "user", "first photo", {
    skipIndexing: true,
  });
  await linkAttachmentToMessage(first.id, photoA, 0);
  await setCreatedAt(first.id, 1000);

  const photoB = await newAttachment("b.png");
  const second = await addMessage(conversation.id, "user", "second photo", {
    skipIndexing: true,
  });
  await linkAttachmentToMessage(second.id, photoB, 0);
  await setCreatedAt(second.id, 2000);

  const ambientFrame = await newAttachment("ambient.png");
  const keep = await addMessage(conversation.id, "user", "", {
    metadata: { scripted: true, sightFrameAttachmentIds: [ambientFrame] },
    skipIndexing: true,
  });
  await linkAttachmentToMessage(keep.id, ambientFrame, 0);
  await setCreatedAt(keep.id, 3000);

  const photoC = await newAttachment("c.png");
  const parkedFrame = await newAttachment("parked.png");
  const spoken = await addMessage(conversation.id, "user", "look at this", {
    metadata: { sightFrameAttachmentIds: [parkedFrame] },
    skipIndexing: true,
  });
  await linkAttachmentToMessage(spoken.id, photoC, 0);
  await linkAttachmentToMessage(spoken.id, parkedFrame, 1);
  await setCreatedAt(spoken.id, 4000);

  const hiddenPhoto = await newAttachment("hidden.png");
  const hidden = await addMessage(conversation.id, "user", "scaffolding", {
    metadata: { hidden: true },
    skipIndexing: true,
  });
  await linkAttachmentToMessage(hidden.id, hiddenPhoto, 0);
  await setCreatedAt(hidden.id, 5000);

  const deletedPhoto = await newAttachment("deleted.png");
  const channelDeleted = await addMessage(
    conversation.id,
    "user",
    "sent then deleted",
    {
      metadata: {
        providerMeta: JSON.stringify({
          source: "slack",
          conversationExternalId: "chan-1",
          messageId: "msg-1",
          eventKind: "message",
          deletedAt: 1700000001000,
        }),
      },
      skipIndexing: true,
    },
  );
  await linkAttachmentToMessage(channelDeleted.id, deletedPhoto, 0);
  await setCreatedAt(channelDeleted.id, 5500);

  const streamingPhoto = await newAttachment("streaming.png");
  const streaming = await addMessage(conversation.id, "user", "mid write", {
    skipIndexing: true,
  });
  await linkAttachmentToMessage(streaming.id, streamingPhoto, 0);
  await setCreatedAt(streaming.id, 6000);
  await setFinalized(streaming.id, 0);

  return {
    conversationId: conversation.id,
    photoA,
    photoB,
    photoC,
    ambientFrame,
    parkedFrame,
  };
}

describePg("GET /v1/attachments", () => {
  beforeEach(async () => {
    await resetTables();
  });

  test("lists a conversation's attachments newest first, metadata only", async () => {
    const seeded = await seedConversation();

    const result = await listAttachments({
      conversationId: seeded.conversationId,
    });

    expect(result.attachments.map((a) => a.id)).toEqual([
      seeded.photoC,
      seeded.parkedFrame,
      seeded.ambientFrame,
      seeded.photoB,
      seeded.photoA,
    ]);
    expect(result.total).toBe(5);
    expect(result.hasMore).toBe(false);
    for (const attachment of result.attachments) {
      expect(attachment).not.toHaveProperty("data");
    }
  });

  test("flags the standalone keep as an ambient keep and the parked frame as neither", async () => {
    const seeded = await seedConversation();

    const byId = new Map(
      (
        await listAttachments({
          conversationId: seeded.conversationId,
        })
      ).attachments.map((a) => [a.id, a]),
    );

    expect(byId.get(seeded.ambientFrame)).toMatchObject({
      sightFrame: true,
      ambientKeep: true,
    });
    expect(byId.get(seeded.parkedFrame)).toMatchObject({
      sightFrame: true,
      ambientKeep: false,
    });
    expect(byId.get(seeded.photoC)).toMatchObject({
      sightFrame: false,
      ambientKeep: false,
    });
  });

  test("omits hidden, channel-deleted, and unfinalized rows", async () => {
    const seeded = await seedConversation();

    const listing = await listAttachments({
      conversationId: seeded.conversationId,
    });
    const filenames = listing.attachments.map((a) => a.filename);

    expect(filenames).not.toContain("hidden.png");
    expect(filenames).not.toContain("deleted.png");
    expect(filenames).not.toContain("streaming.png");
    expect(listing.total).toBe(5);
  });

  test("omits attachments carried only by a tool-result or system row", async () => {
    const conversation = await createConversation("Machine rows");

    const systemPhoto = await newAttachment("system.png");
    const systemRow = await addMessage(conversation.id, "system", "boot", {
      skipIndexing: true,
    });
    await linkAttachmentToMessage(systemRow.id, systemPhoto, 0);
    await setCreatedAt(systemRow.id, 1000);

    const toolPhoto = await newAttachment("tool.png");
    const toolRow = await addMessage(
      conversation.id,
      "user",
      toolResultContent("toolu_01"),
      { skipIndexing: true },
    );
    await linkAttachmentToMessage(toolRow.id, toolPhoto, 0);
    await setCreatedAt(toolRow.id, 2000);

    const spokenPhoto = await newAttachment("spoken.png");
    const spoken = await addMessage(conversation.id, "user", "mine", {
      skipIndexing: true,
    });
    await linkAttachmentToMessage(spoken.id, spokenPhoto, 0);
    await setCreatedAt(spoken.id, 3000);

    const result = await listAttachments({ conversationId: conversation.id });

    expect(result.attachments.map((a) => a.id)).toEqual([spokenPhoto]);
    expect(result.total).toBe(1);
  });

  test("lists a tool image once, on the assistant reply that carries the promoted copy", async () => {
    const conversation = await createConversation("Screenshot turn");

    const toolCopy = await newAttachment("tool-copy.png");
    const toolRow = await addMessage(
      conversation.id,
      "user",
      toolResultContent("toolu_screenshot"),
      { skipIndexing: true },
    );
    await linkAttachmentToMessage(toolRow.id, toolCopy, 0);
    await setCreatedAt(toolRow.id, 1000);

    const promotedCopy = await newAttachment("promoted.png");
    const reply = await addMessage(conversation.id, "assistant", "here it is", {
      skipIndexing: true,
    });
    await linkAttachmentToMessage(reply.id, promotedCopy, 0);
    await setCreatedAt(reply.id, 2000);

    const photo = await newAttachment("mine.png");
    const spoken = await addMessage(conversation.id, "user", "and mine", {
      skipIndexing: true,
    });
    await linkAttachmentToMessage(spoken.id, photo, 0);
    await setCreatedAt(spoken.id, 3000);

    const result = await listAttachments({ conversationId: conversation.id });

    expect(result.attachments.map((a) => a.id)).toEqual([photo, promotedCopy]);
    expect(result.attachments.map((a) => a.id)).not.toContain(toolCopy);
    expect(result.total).toBe(2);

    const excluded = await listAttachments({
      conversationId: conversation.id,
      sightFrames: "exclude",
    });
    expect(excluded.attachments.map((a) => a.id)).toEqual([
      photo,
      promotedCopy,
    ]);
    expect(excluded.total).toBe(2);
  });

  test("lists a row that mixes a text block with a tool result", async () => {
    const conversation = await createConversation("Mixed blocks");

    const photo = await newAttachment("mixed.png");
    const mixed = await addMessage(
      conversation.id,
      "user",
      JSON.stringify([
        { type: "text", text: "here is the file" },
        { type: "tool_result", tool_use_id: "toolu_mixed", content: "ok" },
      ]),
      { skipIndexing: true },
    );
    await linkAttachmentToMessage(mixed.id, photo, 0);
    await setCreatedAt(mixed.id, 1000);

    const result = await listAttachments({ conversationId: conversation.id });

    expect(result.attachments.map((a) => a.id)).toEqual([photo]);
    expect(result.total).toBe(1);
  });

  test("lists rows whose stored content is not a JSON array", async () => {
    const conversation = await createConversation("Legacy bodies");

    const plainPhoto = await newAttachment("plain.png");
    const plain = await addMessage(conversation.id, "user", "placeholder", {
      skipIndexing: true,
    });
    await linkAttachmentToMessage(plain.id, plainPhoto, 0);
    await setCreatedAt(plain.id, 1000);
    await setContent(plain.id, "first photo");

    const refPhoto = await newAttachment("ref.png");
    const refRow = await addMessage(conversation.id, "user", "placeholder", {
      skipIndexing: true,
    });
    await linkAttachmentToMessage(refRow.id, refPhoto, 0);
    await setCreatedAt(refRow.id, 2000);
    await setContent(refRow.id, JSON.stringify({ ref: "x" }));

    const result = await listAttachments({ conversationId: conversation.id });

    expect(result.attachments.map((a) => a.id)).toEqual([refPhoto, plainPhoto]);
    expect(result.total).toBe(2);
  });

  test("lists rows whose content array holds a bare string element", async () => {
    const conversation = await createConversation("Historical blocks");

    const textPhoto = await newAttachment("bare-text.png");
    const textRow = await addMessage(conversation.id, "user", "placeholder", {
      skipIndexing: true,
    });
    await linkAttachmentToMessage(textRow.id, textPhoto, 0);
    await setCreatedAt(textRow.id, 1000);
    await setContent(
      textRow.id,
      JSON.stringify([{ type: "text", text: "hi" }, "bare string"]),
    );

    const toolPhoto = await newAttachment("bare-tool.png");
    const toolRow = await addMessage(conversation.id, "user", "placeholder", {
      skipIndexing: true,
    });
    await linkAttachmentToMessage(toolRow.id, toolPhoto, 0);
    await setCreatedAt(toolRow.id, 2000);
    await setContent(
      toolRow.id,
      JSON.stringify([
        { type: "tool_result", tool_use_id: "x", content: "ok" },
        "bare string",
      ]),
    );

    const result = await listAttachments({ conversationId: conversation.id });

    expect(result.attachments.map((a) => a.id)).toEqual([toolPhoto, textPhoto]);
    expect(result.total).toBe(2);
  });

  test("excludes a row holding tool results beside a system notice", async () => {
    const conversation = await createConversation("Noticed turn");

    const noticedPhoto = await newAttachment("noticed.png");
    const noticed = await addMessage(conversation.id, "user", "placeholder", {
      skipIndexing: true,
    });
    await linkAttachmentToMessage(noticed.id, noticedPhoto, 0);
    await setCreatedAt(noticed.id, 1000);
    await setContent(
      noticed.id,
      JSON.stringify([
        { type: "tool_result", tool_use_id: "x", content: "ok" },
        { type: "text", text: SYSTEM_NOTICE },
      ]),
    );

    const spokenPhoto = await newAttachment("spoken.png");
    const spoken = await addMessage(conversation.id, "user", "mine", {
      skipIndexing: true,
    });
    await linkAttachmentToMessage(spoken.id, spokenPhoto, 0);
    await setCreatedAt(spoken.id, 2000);

    const result = await listAttachments({ conversationId: conversation.id });

    expect(result.attachments.map((a) => a.id)).toEqual([spokenPhoto]);
    expect(result.total).toBe(1);
  });

  test("excludes a row holding only a web search tool result", async () => {
    const conversation = await createConversation("Web search turn");

    const searchPhoto = await newAttachment("search.png");
    const search = await addMessage(conversation.id, "user", "placeholder", {
      skipIndexing: true,
    });
    await linkAttachmentToMessage(search.id, searchPhoto, 0);
    await setCreatedAt(search.id, 1000);
    await setContent(
      search.id,
      JSON.stringify([
        { type: "web_search_tool_result", tool_use_id: "x", content: [] },
      ]),
    );

    const result = await listAttachments({ conversationId: conversation.id });

    expect(result.attachments).toHaveLength(0);
    expect(result.total).toBe(0);
  });

  test("lists a row holding only a system notice", async () => {
    const conversation = await createConversation("Notice only");

    const photo = await newAttachment("notice-only.png");
    const row = await addMessage(conversation.id, "user", "placeholder", {
      skipIndexing: true,
    });
    await linkAttachmentToMessage(row.id, photo, 0);
    await setCreatedAt(row.id, 1000);
    await setContent(
      row.id,
      JSON.stringify([{ type: "text", text: SYSTEM_NOTICE }]),
    );

    const result = await listAttachments({ conversationId: conversation.id });

    expect(result.attachments.map((a) => a.id)).toEqual([photo]);
    expect(result.total).toBe(1);
  });

  test("agrees with the transcript classifier across stored content shapes", async () => {
    const bodies = [
      "first photo",
      '{"ref":"x"}',
      "[]",
      '[{"type":"tool_result","tool_use_id":"a","content":"ok"}]',
      '[{"type":"web_search_tool_result","tool_use_id":"a","content":[]}]',
      `[{"type":"tool_result","tool_use_id":"a","content":"ok"},{"type":"text","text":"${SYSTEM_NOTICE}"}]`,
      `[{"type":"text","text":"${SYSTEM_NOTICE}"}]`,
      '[{"type":"text","text":"<SYSTEM_NOTICE>done</SYSTEM_NOTICE>"}]',
      '[{"type":"text","text":"hi"},{"type":"tool_result","tool_use_id":"a","content":"ok"}]',
      '[{"type":"text","text":"hi"},"bare string"]',
      '[{"type":"tool_result","tool_use_id":"a","content":"ok"},"bare string"]',
      '[{"type":"tool_result","tool_use_id":"a","content":"ok"},null]',
      '[{"type":1}]',
      '["tool_result"]',
    ];

    const conversation = await createConversation("Parity");
    const attachmentIds: string[] = [];
    for (const [index, body] of bodies.entries()) {
      const attachmentId = await newAttachment(`parity-${index}.png`);
      const row = await addMessage(conversation.id, "user", "placeholder", {
        skipIndexing: true,
      });
      await linkAttachmentToMessage(row.id, attachmentId, 0);
      await setCreatedAt(row.id, 1000 + index);
      await setContent(row.id, body);
      attachmentIds.push(attachmentId);
    }

    const listed = new Set(
      (
        await listAttachments({
          conversationId: conversation.id,
          limit: String(bodies.length),
        })
      ).attachments.map((a) => a.id),
    );

    const disagreements = bodies.filter((body, index) => {
      const hidden = isToolResultOnlyUserMessage(messageRowFor(body));
      return listed.has(attachmentIds[index]) === hidden;
    });

    expect(disagreements).toEqual([]);
    expect(listed.size).toBe(
      bodies.filter((body) => !isToolResultOnlyUserMessage(messageRowFor(body)))
        .length,
    );
  });

  test("lists an attachment carried twice once, under the newest carrier", async () => {
    const conversation = await createConversation("Resent");

    const photo = await newAttachment("shared.png");
    const older = await addMessage(conversation.id, "user", "first send", {
      skipIndexing: true,
    });
    await linkAttachmentToMessage(older.id, photo, 0);
    await setCreatedAt(older.id, 1000);

    const newer = await addMessage(conversation.id, "user", "second send", {
      skipIndexing: true,
    });
    await linkAttachmentToMessage(newer.id, photo, 0);
    await setCreatedAt(newer.id, 2000);

    const result = await listAttachments({ conversationId: conversation.id });

    expect(result.attachments.map((a) => a.id)).toEqual([photo]);
    expect(result.total).toBe(1);
    expect(result.attachments[0]?.messageId).toBe(newer.id);
    expect(result.attachments[0]?.createdAt).toBe(2000);
  });

  test("falls back to an older visible carrier when the newest one is skipped", async () => {
    const conversation = await createConversation("Requoted");

    const hiddenCarried = await newAttachment("requoted.png");
    const visibleFirst = await addMessage(conversation.id, "user", "shared", {
      skipIndexing: true,
    });
    await linkAttachmentToMessage(visibleFirst.id, hiddenCarried, 0);
    await setCreatedAt(visibleFirst.id, 1000);

    const hiddenLater = await addMessage(
      conversation.id,
      "user",
      "scaffolding",
      { metadata: { hidden: true }, skipIndexing: true },
    );
    await linkAttachmentToMessage(hiddenLater.id, hiddenCarried, 0);
    await setCreatedAt(hiddenLater.id, 2000);

    const deletedCarried = await newAttachment("resent.png");
    const visibleSecond = await addMessage(
      conversation.id,
      "user",
      "also shared",
      { skipIndexing: true },
    );
    await linkAttachmentToMessage(visibleSecond.id, deletedCarried, 0);
    await setCreatedAt(visibleSecond.id, 3000);

    const deletedLater = await addMessage(
      conversation.id,
      "user",
      "sent then deleted",
      {
        metadata: {
          providerMeta: JSON.stringify({
            source: "slack",
            conversationExternalId: "chan-1",
            messageId: "msg-2",
            eventKind: "message",
            deletedAt: 1700000001000,
          }),
        },
        skipIndexing: true,
      },
    );
    await linkAttachmentToMessage(deletedLater.id, deletedCarried, 0);
    await setCreatedAt(deletedLater.id, 4000);

    const result = await listAttachments({ conversationId: conversation.id });

    expect(result.attachments.map((a) => a.id)).toEqual([
      deletedCarried,
      hiddenCarried,
    ]);
    expect(result.attachments.map((a) => a.messageId)).toEqual([
      visibleSecond.id,
      visibleFirst.id,
    ]);
    expect(result.total).toBe(2);
  });

  test("splits the set on sightFrames, and total follows the filter", async () => {
    const seeded = await seedConversation();

    const only = await listAttachments({
      conversationId: seeded.conversationId,
      sightFrames: "only",
    });
    expect(only.attachments.map((a) => a.id)).toEqual([
      seeded.parkedFrame,
      seeded.ambientFrame,
    ]);
    expect(only.total).toBe(2);

    const excluded = await listAttachments({
      conversationId: seeded.conversationId,
      sightFrames: "exclude",
    });
    expect(excluded.attachments.map((a) => a.id)).toEqual([
      seeded.photoC,
      seeded.photoB,
      seeded.photoA,
    ]);
    expect(excluded.total).toBe(3);
  });

  test("hasMore under a sightFrames filter counts the filtered set", async () => {
    const seeded = await seedConversation();

    const firstFrame = await listAttachments({
      conversationId: seeded.conversationId,
      sightFrames: "only",
      limit: "1",
    });
    expect(firstFrame.attachments.map((a) => a.id)).toEqual([
      seeded.parkedFrame,
    ]);
    expect(firstFrame.total).toBe(2);
    expect(firstFrame.hasMore).toBe(true);

    const lastFrame = await listAttachments({
      conversationId: seeded.conversationId,
      sightFrames: "only",
      limit: "1",
      offset: "1",
    });
    expect(lastFrame.attachments.map((a) => a.id)).toEqual([
      seeded.ambientFrame,
    ]);
    expect(lastFrame.hasMore).toBe(false);
  });

  test("pages with limit and offset", async () => {
    const seeded = await seedConversation();

    const page = await listAttachments({
      conversationId: seeded.conversationId,
      limit: "1",
      offset: "1",
    });

    expect(page.attachments.map((a) => a.id)).toEqual([seeded.parkedFrame]);
    expect(page.total).toBe(5);
    expect(page.hasMore).toBe(true);

    const last = await listAttachments({
      conversationId: seeded.conversationId,
      limit: "1",
      offset: "4",
    });
    expect(last.attachments.map((a) => a.id)).toEqual([seeded.photoA]);
    expect(last.hasMore).toBe(false);
  });

  test("pages deterministically when two carriers share a millisecond", async () => {
    const conversation = await createConversation("Same tick");

    const firstPhoto = await newAttachment("tie-first.png");
    const firstCarrier = await addMessage(conversation.id, "user", "first", {
      skipIndexing: true,
    });
    await linkAttachmentToMessage(firstCarrier.id, firstPhoto, 0);
    await setCreatedAt(firstCarrier.id, 7000);

    const secondPhoto = await newAttachment("tie-second.png");
    const secondCarrier = await addMessage(conversation.id, "user", "second", {
      skipIndexing: true,
    });
    await linkAttachmentToMessage(secondCarrier.id, secondPhoto, 0);
    await setCreatedAt(secondCarrier.id, 7000);

    const fullOrder = (
      await listAttachments({
        conversationId: conversation.id,
      })
    ).attachments.map((a) => a.id);
    expect([...fullOrder].sort()).toEqual([firstPhoto, secondPhoto].sort());

    for (let run = 0; run < 3; run += 1) {
      const head = await listAttachments({
        conversationId: conversation.id,
        limit: "1",
      });
      const tail = await listAttachments({
        conversationId: conversation.id,
        limit: "1",
        offset: "1",
      });
      expect(
        [...head.attachments, ...tail.attachments].map((a) => a.id),
      ).toEqual(fullOrder);
    }
  });

  test("pages deterministically when two links on one carrier share a position", async () => {
    const conversation = await createConversation("Same position");

    const carrier = await addMessage(conversation.id, "user", "both", {
      skipIndexing: true,
    });
    const alpha = await linkAttachmentToMessage(
      carrier.id,
      await newAttachment("pos-alpha.png"),
      0,
    );
    const beta = await linkAttachmentToMessage(
      carrier.id,
      await newAttachment("pos-beta.png"),
      0,
    );
    await setCreatedAt(carrier.id, 8000);
    // Link ids that invert insertion order, so only the final key can decide.
    await setLinkId(alpha, "link-b-alpha");
    await setLinkId(beta, "link-a-beta");

    const fullOrder = (
      await listAttachments({
        conversationId: conversation.id,
      })
    ).attachments.map((a) => a.id);
    expect(fullOrder).toEqual([beta, alpha]);

    for (let run = 0; run < 3; run += 1) {
      const head = await listAttachments({
        conversationId: conversation.id,
        limit: "1",
      });
      const tail = await listAttachments({
        conversationId: conversation.id,
        limit: "1",
        offset: "1",
      });
      expect(
        [...head.attachments, ...tail.attachments].map((a) => a.id),
      ).toEqual(fullOrder);
    }
  });

  test("rejects a request without a conversation", async () => {
    await expect(listAttachments({})).rejects.toThrow(BadRequestError);
  });

  test("rejects a non-numeric limit", async () => {
    const seeded = await seedConversation();

    await expect(
      listAttachments({ conversationId: seeded.conversationId, limit: "abc" }),
    ).rejects.toThrow(BadRequestError);
  });

  test("rejects a non-numeric offset", async () => {
    const seeded = await seedConversation();

    await expect(
      listAttachments({ conversationId: seeded.conversationId, offset: "abc" }),
    ).rejects.toThrow(BadRequestError);
  });

  test("rejects a fractional limit or offset", async () => {
    const seeded = await seedConversation();

    await expect(
      listAttachments({ conversationId: seeded.conversationId, limit: "1.9" }),
    ).rejects.toThrow(BadRequestError);
    await expect(
      listAttachments({ conversationId: seeded.conversationId, offset: "2.5" }),
    ).rejects.toThrow(BadRequestError);
  });

  test("clamps an out-of-range limit or offset rather than rejecting it", async () => {
    const seeded = await seedConversation();

    const zeroLimit = await listAttachments({
      conversationId: seeded.conversationId,
      limit: "0",
    });
    expect(zeroLimit.attachments.map((a) => a.id)).toEqual([seeded.photoC]);
    expect(zeroLimit.total).toBe(5);
    expect(zeroLimit.hasMore).toBe(true);

    const overMaxLimit = await listAttachments({
      conversationId: seeded.conversationId,
      limit: "5000",
    });
    expect(overMaxLimit.attachments).toHaveLength(5);
    expect(overMaxLimit.hasMore).toBe(false);

    const negativeOffset = await listAttachments({
      conversationId: seeded.conversationId,
      offset: "-1",
    });
    expect(negativeOffset.attachments.map((a) => a.id)).toEqual([
      seeded.photoC,
      seeded.parkedFrame,
      seeded.ambientFrame,
      seeded.photoB,
      seeded.photoA,
    ]);
    expect(negativeOffset.hasMore).toBe(false);
  });

  test("hydrates the thumbnail for the returned page only", async () => {
    const conversation = await createConversation("Clips");

    const olderClip = await newVideoAttachment("older.mp4", "OLDER_THUMB");
    const older = await addMessage(conversation.id, "user", "older clip", {
      skipIndexing: true,
    });
    await linkAttachmentToMessage(older.id, olderClip, 0);
    await setCreatedAt(older.id, 1000);

    const newerClip = await newVideoAttachment("newer.mp4", "NEWER_THUMB");
    const newer = await addMessage(conversation.id, "user", "newer clip", {
      skipIndexing: true,
    });
    await linkAttachmentToMessage(newer.id, newerClip, 0);
    await setCreatedAt(newer.id, 2000);

    const first = await listAttachments({
      conversationId: conversation.id,
      limit: "1",
    });
    expect(first.attachments.map((a) => a.id)).toEqual([newerClip]);
    expect(first.attachments[0]?.thumbnailData).toBe("NEWER_THUMB");
    expect(first.attachments.map((a) => a.thumbnailData)).not.toContain(
      "OLDER_THUMB",
    );

    const second = await listAttachments({
      conversationId: conversation.id,
      limit: "1",
      offset: "1",
    });
    expect(second.attachments.map((a) => a.id)).toEqual([olderClip]);
    expect(second.attachments[0]?.thumbnailData).toBe("OLDER_THUMB");
  });

  test("rejects an unknown sightFrames value", async () => {
    const seeded = await seedConversation();

    await expect(
      listAttachments({
        conversationId: seeded.conversationId,
        sightFrames: "maybe",
      }),
    ).rejects.toThrow(BadRequestError);
  });

  test("treats an empty sightFrames value as no filter", async () => {
    const seeded = await seedConversation();

    const result = await listAttachments({
      conversationId: seeded.conversationId,
      sightFrames: "",
    });

    expect(result.attachments.map((a) => a.id)).toEqual([
      seeded.photoC,
      seeded.parkedFrame,
      seeded.ambientFrame,
      seeded.photoB,
      seeded.photoA,
    ]);
    expect(result.total).toBe(5);
  });

  test("a referential fork lists the attachments it inherited", async () => {
    const seeded = await seedConversation();

    const fork = await forkConversationForRetrospective({
      conversationId: seeded.conversationId,
    });

    const result = await listAttachments({ conversationId: fork.id });

    expect(result.attachments.map((a) => a.id)).toEqual([
      seeded.photoC,
      seeded.parkedFrame,
      seeded.ambientFrame,
      seeded.photoB,
      seeded.photoA,
    ]);
  });
});
