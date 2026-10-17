/**
 * A Done conversation comes back to the list when a message the user reads
 * lands in it.
 *
 * Two seams enforce the rule: `insertMessageCore`, where every durable append
 * lands, and the turn's finalize effect, where a streamed reply becomes
 * readable. These tests drive the insert seam the way each ingest path does,
 * with `addMessage` and that path's row shape, and drive the finalize seam
 * through `resurfaceArchivedConversation` itself, which is all the finalize
 * effect adds to the reserved row.
 */

import { beforeEach, expect, mock, test } from "bun:test";

mock.module("../persistence/embeddings/qdrant-client.js", () => ({
  getQdrantClient: () => ({
    searchWithFilter: async () => [],
    hybridSearch: async () => [],
    upsertPoints: async () => {},
    deletePoints: async () => {},
  }),
  initQdrantClient: () => {},
  resolveQdrantUrl: () => "http://127.0.0.1:6333",
}));

let sidebarDoneEnabled = true;
mock.module("../config/sidebar-done-gate.js", () => ({
  SIDEBAR_DONE_FLAG_KEY: "sidebar-done",
  isSidebarDoneEnabled: () => sidebarDoneEnabled,
}));

const listInvalidations: Array<{ reason: string; conversationIds: unknown }> =
  [];
const actualSyncEvents =
  await import("../runtime/sync/resource-sync-events.js");
mock.module("../runtime/sync/resource-sync-events.js", () => ({
  ...actualSyncEvents,
  publishConversationListAndMetadataChanged: (
    reason: string,
    conversationIds: unknown,
  ) => {
    listInvalidations.push({ reason, conversationIds });
  },
}));

import {
  addMessage,
  archiveConversation,
  getConversation,
  reserveMessage,
  resurfaceArchivedConversation,
} from "../persistence/conversation-crud.js";
import { requireMainDb } from "../persistence/db-facade.js";
import {
  MEMORY_RETROSPECTIVE_INSTRUCTION_KIND,
  SKILL_CARD_MESSAGE_KIND,
} from "../plugins/defaults/memory/memory-retrospective-constants.js";
import { setConfig } from "./helpers/set-config.js";
import { describePg } from "./pg-test-db.js";

setConfig("memory", { extraction: { useLLM: false } });

const DONE_CONVERSATION_ID = "conv-done";
const RETRO_FORK_ID = "conv-done-retro-fork";

async function insertConversation(id: string): Promise<void> {
  const now = Date.now();
  await requireMainDb().run(
    "INSERT INTO conversations (id, created_at, updated_at) VALUES (?, ?, ?)",
    [id, now, now],
  );
}

async function resetTables(): Promise<void> {
  const db = requireMainDb();
  await db.run("DELETE FROM messages");
  await db.run("DELETE FROM conversations");
  await insertConversation(DONE_CONVERSATION_ID);
  await insertConversation(RETRO_FORK_ID);
  await archiveConversation(DONE_CONVERSATION_ID);
  listInvalidations.length = 0;
}

async function archivedAtOf(id: string): Promise<number | null | undefined> {
  return (await getConversation(id))?.archivedAt;
}

function blocks(text: string): string {
  return JSON.stringify([{ type: "text", text }]);
}

describePg("Done conversations and new activity", () => {
  beforeEach(async () => {
    sidebarDoneEnabled = true;
    await resetTables();
  });

  test("assistant output from a scheduled run brings the conversation back", async () => {
    // The wake persists its `<background_event>` trigger first. That row is
    // dropped from the transcript, so it must not resurface anything on its
    // own: the run has produced nothing the user can read yet.
    await addMessage(
      DONE_CONVERSATION_ID,
      "user",
      blocks(
        '<background_event source="schedule">Daily digest</background_event>',
      ),
      {
        metadata: {
          kind: "background-event",
          backgroundEventSource: "schedule",
          automated: true,
        },
        skipIndexing: true,
      },
    );

    expect(await archivedAtOf(DONE_CONVERSATION_ID)).not.toBeNull();
    expect(listInvalidations).toHaveLength(0);

    // The run's own output is what the user reads.
    await addMessage(
      DONE_CONVERSATION_ID,
      "assistant",
      blocks("Here is today's digest."),
      { metadata: { automated: true }, skipIndexing: true },
    );

    expect(await archivedAtOf(DONE_CONVERSATION_ID)).toBeNull();
    expect(listInvalidations).toEqual([
      { reason: "reordered", conversationIds: DONE_CONVERSATION_ID },
    ]);
  });

  test("the empty row an LLM call reserves leaves the conversation Done", async () => {
    const reserved = await reserveMessage(
      DONE_CONVERSATION_ID,
      "assistant",
      undefined,
      "inflight/ref.jsonl",
    );

    expect(await archivedAtOf(DONE_CONVERSATION_ID)).not.toBeNull();
    expect(listInvalidations).toHaveLength(0);

    // The finalize seam is what resurfaces it, once the row holds content.
    expect(
      await resurfaceArchivedConversation(
        DONE_CONVERSATION_ID,
        reserved.createdAt,
      ),
    ).toBe(true);
    expect(await archivedAtOf(DONE_CONVERSATION_ID)).toBeNull();
    expect(listInvalidations).toHaveLength(1);
  });

  test("a Done mark made after the activity wins over the resurface", async () => {
    const activityAt = Date.now() - 60_000;

    expect(
      await resurfaceArchivedConversation(DONE_CONVERSATION_ID, activityAt),
    ).toBe(false);
    expect(await archivedAtOf(DONE_CONVERSATION_ID)).not.toBeNull();
    expect(listInvalidations).toHaveLength(0);
  });

  test("an inbound channel message from a person brings the conversation back", async () => {
    await addMessage(DONE_CONVERSATION_ID, "user", "any updates?", {
      metadata: {
        userMessageChannel: "slack",
        provenanceSourceChannel: "slack",
      },
      skipIndexing: true,
    });

    expect(await archivedAtOf(DONE_CONVERSATION_ID)).toBeNull();
    expect(listInvalidations).toHaveLength(1);
  });

  test("rows that never render leave the conversation Done", async () => {
    await addMessage(DONE_CONVERSATION_ID, "user", "internal signal", {
      metadata: { hidden: true },
      skipIndexing: true,
    });
    await addMessage(DONE_CONVERSATION_ID, "user", "subagent finished", {
      metadata: { subagentNotification: { subagentId: "sub-1" } },
      skipIndexing: true,
    });
    await addMessage(DONE_CONVERSATION_ID, "user", "acp session update", {
      metadata: { acpNotification: { sessionId: "acp-1" } },
      skipIndexing: true,
    });

    expect(await archivedAtOf(DONE_CONVERSATION_ID)).not.toBeNull();
    expect(listInvalidations).toHaveLength(0);
  });

  test("a memory retrospective leaves the conversation it reviews Done", async () => {
    // A retrospective runs in a fork: its instruction and its whole pass are
    // appended to the fork, never to the conversation under review.
    await addMessage(RETRO_FORK_ID, "user", "Review the transcript.", {
      metadata: { kind: MEMORY_RETROSPECTIVE_INSTRUCTION_KIND, hidden: true },
      skipIndexing: true,
    });
    await addMessage(RETRO_FORK_ID, "assistant", blocks("Saved one fact."), {
      metadata: { automated: true },
      skipIndexing: true,
    });

    expect(await archivedAtOf(DONE_CONVERSATION_ID)).not.toBeNull();
    expect(listInvalidations).toHaveLength(0);
  });

  test("a row its producer marked as bookkeeping leaves the conversation Done", async () => {
    // The retrospective skill card, written the way
    // `memory-retrospective-skill-card.ts` writes it. Persistence cannot
    // import the memory plugin (`persistence-layering-guard`), so the producer
    // declares the row instead of the seam recognising its kind.
    await addMessage(
      DONE_CONVERSATION_ID,
      "assistant",
      JSON.stringify([
        {
          type: "ui_surface",
          surfaceId: "surface-1",
          surfaceType: "skill_card",
          title: "I just learned how to do expense filing",
          display: "inline",
          data: { skills: [] },
        },
        {
          type: "text",
          text: "I just learned how to do expense filing",
          _surfaceFallback: true,
        },
      ]),
      {
        metadata: { kind: SKILL_CARD_MESSAGE_KIND, automated: true },
        skipIndexing: true,
        clientMessageId: "surface-1",
        skipResurface: true,
      },
    );

    expect(await archivedAtOf(DONE_CONVERSATION_ID)).not.toBeNull();
    expect(listInvalidations).toHaveLength(0);
  });

  test("the flag off keeps every append from clearing archived_at", async () => {
    sidebarDoneEnabled = false;

    await addMessage(DONE_CONVERSATION_ID, "user", "any updates?", {
      metadata: {
        userMessageChannel: "slack",
        provenanceSourceChannel: "slack",
      },
      skipIndexing: true,
    });
    await addMessage(
      DONE_CONVERSATION_ID,
      "assistant",
      blocks("Here is today's digest."),
      { metadata: { automated: true }, skipIndexing: true },
    );

    expect(await archivedAtOf(DONE_CONVERSATION_ID)).not.toBeNull();
    expect(listInvalidations).toHaveLength(0);
    expect(
      await requireMainDb().all(
        "SELECT * FROM messages WHERE conversation_id = ?",
        [DONE_CONVERSATION_ID],
      ),
    ).toHaveLength(2);
  });
});
