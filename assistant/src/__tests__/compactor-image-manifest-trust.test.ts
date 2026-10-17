/**
 * Compaction must not surface guardian-only images to untrusted actors.
 *
 * `loadFromDb` hides guardian-provenance messages (and their images) from
 * untrusted actors. The compaction image manifest reads the DB directly, so
 * without the same provenance filter an untrusted actor's compaction turn
 * could list a guardian image, retain it, and re-attach its bytes — leaking
 * content the actor was never allowed to see. `collectImageManifest` applies
 * the identical trust filter so this cannot happen.
 */
import { beforeEach, expect, setDefaultTimeout, test } from "bun:test";

import { collectImageManifest } from "../context/compactor.js";
import { attachInlineAttachmentToMessage } from "../persistence/attachments-store.js";
import {
  addMessage,
  createConversation,
} from "../persistence/conversation-crud.js";
import { requireMainDb } from "../persistence/db-facade.js";
import { describePg } from "./pg-test-db.js";

// 1x1 transparent PNG.
const PNG_1X1_BASE64 =
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==";

async function resetTables(): Promise<void> {
  const db = requireMainDb();
  await db.run("DELETE FROM message_attachments");
  await db.run("DELETE FROM attachments");
  await db.run("DELETE FROM messages");
  await db.run("DELETE FROM conversations");
}

async function addImageMessage(
  conversationId: string,
  provenanceTrustClass:
    | "guardian"
    | "trusted_contact"
    | "unverified_contact"
    | "unknown",
  filename: string,
): Promise<void> {
  const inserted = await addMessage(
    conversationId,
    "user",
    JSON.stringify([{ type: "text", text: filename }]),
    {
      metadata: { provenanceTrustClass },
      skipIndexing: true,
    },
  );
  await attachInlineAttachmentToMessage(
    inserted.id,
    0,
    filename,
    "image/png",
    PNG_1X1_BASE64,
  );
}

describePg("collectImageManifest trust filtering", () => {
  beforeEach(resetTables);

  test("untrusted actor manifest excludes guardian images", async () => {
    // GIVEN a conversation with a guardian image and an unknown-actor image
    const conv = await createConversation();
    await addImageMessage(conv.id, "guardian", "guardian-secret.png");
    await addImageMessage(conv.id, "unknown", "visitor.png");

    // WHEN the manifest is built for an untrusted ("unknown") actor
    const manifest = await collectImageManifest(conv.id, "unknown");

    // THEN only the untrusted actor's own image is listed
    const filenames = manifest.map((e) => e.filename);
    expect(filenames).toContain("visitor.png");
    expect(filenames).not.toContain("guardian-secret.png");
  });

  test("guardian actor manifest includes all images", async () => {
    // GIVEN a conversation with a guardian image and an unknown-actor image
    const conv = await createConversation();
    await addImageMessage(conv.id, "guardian", "guardian-secret.png");
    await addImageMessage(conv.id, "unknown", "visitor.png");

    // WHEN the manifest is built for the guardian
    const manifest = await collectImageManifest(conv.id, "guardian");

    // THEN every image is listed
    const filenames = manifest.map((e) => e.filename);
    expect(filenames).toContain("guardian-secret.png");
    expect(filenames).toContain("visitor.png");
  });

  test("omitted trust class defaults to the untrusted filter", async () => {
    // GIVEN a conversation containing a guardian image
    const conv = await createConversation();
    await addImageMessage(conv.id, "guardian", "guardian-secret.png");
    await addImageMessage(conv.id, "trusted_contact", "contact.png");

    // WHEN the manifest is built without an explicit trust class
    const manifest = await collectImageManifest(conv.id);

    // THEN the guardian image is excluded (fail-closed, mirroring loadFromDb)
    const filenames = manifest.map((e) => e.filename);
    expect(filenames).toContain("contact.png");
    expect(filenames).not.toContain("guardian-secret.png");
  });

  test("unverified_contact actor manifest excludes guardian images but keeps unverified-provenance images", async () => {
    // GIVEN a conversation with a guardian image and an unverified-contact image
    const conv = await createConversation();
    await addImageMessage(conv.id, "guardian", "guardian-secret.png");
    await addImageMessage(conv.id, "unverified_contact", "unverified.png");

    // WHEN the manifest is built for an unverified_contact actor
    const manifest = await collectImageManifest(conv.id, "unverified_contact");

    // THEN the unverified-provenance image is listed and the guardian image
    // is excluded — unverified_contact is treated as untrusted downstream.
    const filenames = manifest.map((e) => e.filename);
    expect(filenames).toContain("unverified.png");
    expect(filenames).not.toContain("guardian-secret.png");
  });
});

describePg("collectImageManifest fixed-boundary row bound", () => {
  beforeEach(resetTables);

  test("endRowIndex excludes images at and after the boundary row", async () => {
    // GIVEN three image messages (rows 0, 1, 2)
    const conv = await createConversation();
    await addImageMessage(conv.id, "guardian", "head-1.png");
    await addImageMessage(conv.id, "guardian", "head-2.png");
    await addImageMessage(conv.id, "guardian", "tail.png");

    // WHEN the manifest is bounded to rows before index 2
    const manifest = await collectImageManifest(conv.id, "guardian", 2);

    // THEN only head images are offered for retention
    const filenames = manifest.map((e) => e.filename);
    expect(filenames).toEqual(["head-1.png", "head-2.png"]);
  });

  test("omitted endRowIndex keeps the whole-conversation manifest", async () => {
    // GIVEN two image messages
    const conv = await createConversation();
    await addImageMessage(conv.id, "guardian", "first.png");
    await addImageMessage(conv.id, "guardian", "second.png");

    // WHEN the manifest is built without a boundary (auto-compaction path)
    const manifest = await collectImageManifest(conv.id, "guardian");

    // THEN every image is listed
    expect(manifest.map((e) => e.filename)).toEqual([
      "first.png",
      "second.png",
    ]);
  });

  test("boundary slices the full row list before the trust filter", async () => {
    // GIVEN guardian and unknown images interleaved across rows 0-2
    const conv = await createConversation();
    await addImageMessage(conv.id, "guardian", "guardian-head.png");
    await addImageMessage(conv.id, "unknown", "visitor-head.png");
    await addImageMessage(conv.id, "unknown", "visitor-tail.png");

    // WHEN an untrusted manifest is bounded to rows before index 2
    const manifest = await collectImageManifest(conv.id, "unknown", 2);

    // THEN the boundary indexes the unfiltered row list (row 2 sliced away)
    // and trust filtering still hides the guardian image from row 0
    expect(manifest.map((e) => e.filename)).toEqual(["visitor-head.png"]);
  });
});

setDefaultTimeout(30_000);
