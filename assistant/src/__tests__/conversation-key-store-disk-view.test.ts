import {
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  rmSync,
} from "node:fs";
import { join } from "node:path";
import { beforeEach, expect, test } from "bun:test";

const testDir = process.env.VELLUM_WORKSPACE_DIR!;
const conversationsDir = join(testDir, "conversations");
mkdirSync(conversationsDir, { recursive: true });

import type { AssistantEventEnvelope } from "../api/index.js";
import { getOrCreateConversation } from "../persistence/conversation-key-store.js";
import { requireMainDb } from "../persistence/db-facade.js";
import {
  _resetStreamStateForTesting,
  _simulateRestartForTesting,
  getCurrentSeq,
  stampAndBuffer,
} from "../runtime/assistant-stream-state.js";
import { describePg } from "./pg-test-db.js";

beforeEach(async () => {
  const db = requireMainDb();
  await db.run("DELETE FROM conversation_keys");
  await db.run("DELETE FROM conversations");

  rmSync(conversationsDir, { recursive: true, force: true });
  mkdirSync(conversationsDir, { recursive: true });
});

describePg("conversation-key-store disk view", () => {
  test("creates disk-view directory on first key use and reuses it on second call", async () => {
    const first = await getOrCreateConversation("client-key");
    expect(first.created).toBe(true);

    const db = requireMainDb();
    const conversation = await db.get<{ id: string; createdAt: number }>(
      'SELECT id, created_at AS "createdAt" FROM conversations WHERE id = ?',
      [first.conversationId],
    );
    expect(conversation).not.toBeNull();

    const expectedDirName = `${new Date(conversation!.createdAt).toISOString().replace(/:/g, "-")}_${first.conversationId}`;
    const metaPath = join(conversationsDir, expectedDirName, "meta.json");
    expect(existsSync(metaPath)).toBe(true);

    const meta = JSON.parse(readFileSync(metaPath, "utf-8"));
    expect(meta.id).toBe(first.conversationId);
    expect(meta.title).toBe("conversation.title.generating");
    expect(meta.type).toBe("standard");
    expect(meta.channel).toBeNull();
    expect(readdirSync(conversationsDir)).toEqual([expectedDirName]);

    const second = await getOrCreateConversation("client-key");
    expect(second.created).toBe(false);
    expect(second.conversationId).toBe(first.conversationId);

    const conversationRows = await db.all("SELECT id FROM conversations");
    const keyRows = await db.all("SELECT id FROM conversation_keys");
    expect(conversationRows).toHaveLength(1);
    expect(keyRows).toHaveLength(1);
    expect(readdirSync(conversationsDir)).toEqual([expectedDirName]);
  });

  test("seeds the seq alignment baseline from the global counter at creation", async () => {
    // Regression: this insert used to omit `seq`, so key-materialized
    // conversations (the web's first-send path) reported `seq: null` on
    // /messages for their entire first turn — the anchor-less snapshot that
    // let mid-turn refetches wipe streamed transcript content on clients.
    _resetStreamStateForTesting();
    const event: AssistantEventEnvelope = {
      id: "seed-evt",
      conversationId: "other-conversation",
      emittedAt: new Date().toISOString(),
      message: {
        type: "assistant_text_delta",
        conversationId: "other-conversation",
        text: "x",
      } as AssistantEventEnvelope["message"],
    };
    stampAndBuffer(event);
    const baseline = getCurrentSeq();
    expect(baseline).toBeGreaterThan(0);

    const created = await getOrCreateConversation("seed-key");
    const row = await requireMainDb().get<{ seq: number | null }>(
      "SELECT seq FROM conversations WHERE id = ?",
      [created.conversationId],
    );
    expect(row?.seq).toBe(baseline);
  });

  test("seeds from the persisted seq ceiling after a daemon restart", async () => {
    // A restarted process with a warm workspace has stamped nothing yet, but
    // the reservation file proves every previously emitted seq is at or below
    // its ceiling — a conversation created before the first stamp must seed
    // from that ceiling, not report NULL as if the assistant were brand new.
    _resetStreamStateForTesting();
    const event: AssistantEventEnvelope = {
      id: "restart-evt",
      conversationId: "other-conversation",
      emittedAt: new Date().toISOString(),
      message: {
        type: "assistant_text_delta",
        conversationId: "other-conversation",
        text: "x",
      } as AssistantEventEnvelope["message"],
    };
    stampAndBuffer(event);
    _simulateRestartForTesting();

    const created = await getOrCreateConversation("restart-key");
    const row = await requireMainDb().get<{ seq: number | null }>(
      "SELECT seq FROM conversations WHERE id = ?",
      [created.conversationId],
    );
    expect(row?.seq).toBe(getCurrentSeq());
    expect(row?.seq).toBeGreaterThan(0);
  });

  test("stores NULL seq when nothing has been stamped yet (cold process)", async () => {
    // getCurrentSeq() === 0 means no event was ever emitted; clients must
    // cold-start rather than align to seq 0, so the column stays NULL.
    _resetStreamStateForTesting();
    expect(getCurrentSeq()).toBe(0);

    const created = await getOrCreateConversation("cold-key");
    const row = await requireMainDb().get<{ seq: number | null }>(
      "SELECT seq FROM conversations WHERE id = ?",
      [created.conversationId],
    );
    expect(row?.seq).toBeNull();
  });
});
