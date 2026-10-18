import { beforeEach, expect, test } from "bun:test";

import { getDocumentById } from "../documents/document-store.js";
import { requireMainDb } from "../persistence/db-facade.js";
import {
  executeDocumentCreate,
  executeDocumentUpdate,
} from "../tools/document/document-tool.js";
import type { ToolContext, ToolExecutionResult } from "../tools/types.js";
import { describePg } from "./pg-test-db.js";

const CONVERSATION_ID = "conv-current";

/** Long enough to clear the store's minimum-duplicate-length floor. */
const OPENING =
  "Remote work reshaped the office long before anyone had a name for it.";

function makeContext(overrides: Partial<ToolContext> = {}): ToolContext {
  return {
    workingDir: "/tmp/project",
    conversationId: CONVERSATION_ID,
    trustClass: "trusted_contact",
    executionChannel: "slack",
    sendToClient: () => {},
    ...overrides,
  };
}

function parseResult<T>(result: ToolExecutionResult): T {
  return JSON.parse(result.content) as T;
}

async function bootstrapDocumentTables(): Promise<void> {
  const db = requireMainDb();
  await db.run("DELETE FROM document_conversations");
  await db.run("DELETE FROM document_revisions");
  await db.run("DELETE FROM documents");
  await db.run("DELETE FROM conversations");
  const now = Date.now();
  await db.run(
    "INSERT INTO conversations (id, title, created_at, updated_at) VALUES (?, ?, ?, ?)",
    [CONVERSATION_ID, `Conversation ${CONVERSATION_ID}`, now, now],
  );
}

async function seedDocument(surfaceId: string, content: string): Promise<void> {
  const now = Date.now();
  const db = requireMainDb();
  await db.run(
    "INSERT INTO documents (surface_id, conversation_id, title, content, word_count, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)",
    [
      surfaceId,
      CONVERSATION_ID,
      "Draft",
      content,
      content.split(/\s+/).filter(Boolean).length,
      now,
      now,
    ],
  );
  await db.run(
    "INSERT INTO document_conversations (surface_id, conversation_id, created_at) VALUES (?, ?, ?)",
    [surfaceId, CONVERSATION_ID, now],
  );
}

describePg("document append idempotency", () => {
  beforeEach(async () => {
    await bootstrapDocumentTables();
  });

  test("an opening passed to both document_create and the first append lands once", async () => {
    const created = await executeDocumentCreate(
      { title: "Draft", initial_content: `# Draft\n\n${OPENING}` },
      makeContext(),
    );
    const surfaceId = parseResult<{ surface_id: string }>(created).surface_id;

    const result = await executeDocumentUpdate(
      {
        surface_id: surfaceId,
        content: `# Draft\n\n${OPENING}\n\nThe second paragraph carries the argument forward.`,
        mode: "append",
      },
      makeContext(),
    );

    expect(result.isError).toBe(false);
    expect((await getDocumentById(surfaceId))?.content).toBe(
      `# Draft\n\n${OPENING}\n\nThe second paragraph carries the argument forward.`,
    );
  });

  test("an append that only restates the tail writes nothing", async () => {
    await seedDocument("doc-restate", `# Draft\n\n${OPENING}`);

    const result = await executeDocumentUpdate(
      { surface_id: "doc-restate", content: OPENING, mode: "append" },
      makeContext(),
    );

    expect(result.isError).toBe(false);
    const body = parseResult<{ success: boolean; message: string }>(result);
    expect(body.success).toBe(true);
    expect(body.message).toBe(
      "Nothing appended: the content is already at the end of the document",
    );
    expect((await getDocumentById("doc-restate"))?.content).toBe(
      `# Draft\n\n${OPENING}`,
    );
  });

  test("the client is told what landed, not what was submitted", async () => {
    await seedDocument("doc-client", OPENING);
    const sent: { markdown: unknown; mode: unknown }[] = [];

    await executeDocumentUpdate(
      {
        surface_id: "doc-client",
        content: `${OPENING}\n\nAnd then the rest.`,
        mode: "append",
      },
      makeContext({
        sendToClient: (message) => {
          if (message.type === "document_editor_update") {
            sent.push({ markdown: message.markdown, mode: message.mode });
          }
        },
      }),
    );

    expect(sent).toEqual([{ markdown: "And then the rest.", mode: "append" }]);
  });

  // ── Legitimate repetition the guard must not eat ──────────────────

  test("keeps a short repeated line, even back to back", async () => {
    await seedDocument("doc-refrain", "## Checklist\n\nTODO");

    await executeDocumentUpdate(
      { surface_id: "doc-refrain", content: "TODO\n\nTODO", mode: "append" },
      makeContext(),
    );

    expect((await getDocumentById("doc-refrain"))?.content).toBe(
      "## Checklist\n\nTODO\n\nTODO\n\nTODO",
    );
  });

  test("keeps a repeated heading followed by new prose", async () => {
    await seedDocument("doc-heading", "# Weekly Notes\n\n## Monday");

    await executeDocumentUpdate(
      {
        surface_id: "doc-heading",
        content: "## Monday\n\nShipped the importer.",
        mode: "append",
      },
      makeContext(),
    );

    expect((await getDocumentById("doc-heading"))?.content).toBe(
      "# Weekly Notes\n\n## Monday\n\n## Monday\n\nShipped the importer.",
    );
  });

  test("keeps a long paragraph that repeats something other than the tail", async () => {
    await seedDocument(
      "doc-midway",
      `${OPENING}\n\nA later paragraph ends the doc.`,
    );

    await executeDocumentUpdate(
      { surface_id: "doc-midway", content: OPENING, mode: "append" },
      makeContext(),
    );

    expect((await getDocumentById("doc-midway"))?.content).toBe(
      `${OPENING}\n\nA later paragraph ends the doc.\n\n${OPENING}`,
    );
  });

  test("keeps content whose repetition starts partway into the append", async () => {
    await seedDocument("doc-partway", `# Draft\n\n${OPENING}`);

    await executeDocumentUpdate(
      {
        surface_id: "doc-partway",
        content: `A fresh lead-in.\n\n${OPENING}`,
        mode: "append",
      },
      makeContext(),
    );

    expect((await getDocumentById("doc-partway"))?.content).toBe(
      `# Draft\n\n${OPENING}\n\nA fresh lead-in.\n\n${OPENING}`,
    );
  });

  test("replace mode is never deduplicated", async () => {
    await seedDocument("doc-replace", OPENING);

    await executeDocumentUpdate(
      { surface_id: "doc-replace", content: OPENING, mode: "replace" },
      makeContext(),
    );

    expect((await getDocumentById("doc-replace"))?.content).toBe(OPENING);
  });
});
