import {
  afterAll,
  beforeEach,
  expect,
  mock,
  setSystemTime,
  test,
} from "bun:test";

mock.module("../../config/sidebar-done-gate.js", () => ({
  isSidebarDoneEnabled: () => true,
  SIDEBAR_DONE_FLAG_KEY: "sidebar-done",
}));

import { describePg } from "../../__tests__/pg-test-db.js";
import {
  archiveInactiveConversation,
  listAutoArchiveCandidates,
} from "../conversation-auto-archive.js";
import {
  archiveConversation,
  resurfaceArchivedConversation,
  unarchiveConversation,
} from "../conversation-crud.js";
import { requireMainDb } from "../db-facade.js";
import { upsertSubagentRecord } from "../subagent-store.js";

const NOW = 1_800_000_000_000;
const DAY = 86_400_000;
const CUTOFF = NOW - 7 * DAY;
const ID = "conv-123";

interface ConversationValues {
  createdAt?: number;
  updatedAt?: number;
  lastMessageAt?: number | null;
  archivedAt?: number | null;
  processingStartedAt?: number | null;
  conversationType?: string;
  source?: string;
  parentConversationId?: string | null;
  scheduleJobId?: string | null;
  originChannel?: string | null;
}

const COLUMNS: Record<keyof ConversationValues, string> = {
  createdAt: "created_at",
  updatedAt: "updated_at",
  lastMessageAt: "last_message_at",
  archivedAt: "archived_at",
  processingStartedAt: "processing_started_at",
  conversationType: "conversation_type",
  source: "source",
  parentConversationId: "parent_conversation_id",
  scheduleJobId: "schedule_job_id",
  originChannel: "origin_channel",
};

async function insert(id = ID, values: ConversationValues = {}) {
  const row = {
    createdAt: CUTOFF - DAY,
    updatedAt: NOW,
    lastMessageAt: CUTOFF,
    archivedAt: null,
    processingStartedAt: null,
    conversationType: "standard",
    source: "user",
    parentConversationId: null,
    scheduleJobId: null,
    originChannel: null,
    ...values,
  };
  await requireMainDb().run(
    `INSERT INTO conversations (id, created_at, updated_at, last_message_at, archived_at, processing_started_at, conversation_type, source, parent_conversation_id, schedule_job_id, origin_channel) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      id,
      row.createdAt,
      row.updatedAt,
      row.lastMessageAt,
      row.archivedAt,
      row.processingStartedAt,
      row.conversationType,
      row.source,
      row.parentConversationId,
      row.scheduleJobId,
      row.originChannel,
    ],
  );
}

async function change(values: ConversationValues) {
  for (const key of Object.keys(values) as Array<keyof ConversationValues>) {
    await requireMainDb().run(
      `UPDATE conversations SET ${COLUMNS[key]} = ? WHERE id = ?`,
      [values[key] ?? null, ID],
    );
  }
}

async function candidates(limit = 100) {
  return await listAutoArchiveCandidates({ cutoff: CUTOFF, limit });
}

async function state() {
  const row = await requireMainDb().get<{
    archivedAt: number | null;
    lastReopenedAt: number | null;
  }>(
    'SELECT archived_at AS "archivedAt", last_reopened_at AS "lastReopenedAt" FROM conversations WHERE id = ?',
    [ID],
  );
  return row;
}

beforeEach(async () => {
  setSystemTime(NOW);
  const db = requireMainDb();
  await db.run("DELETE FROM conversation_assistant_attention_state");
  await db.run("DELETE FROM conversation_mode_sessions");
  await db.run("DELETE FROM external_conversation_bindings");
  await db.run("DELETE FROM acp_session_history");
  await db.run("DELETE FROM workflow_runs");
  await db.run("DELETE FROM subagents");
  await db.run("DELETE FROM conversations");
  await insert();
});
afterAll(() => setSystemTime());

test("includes the exact cutoff, excludes newer activity, and ignores title/update timestamps", async () => {
  expect((await candidates()).map((row) => row.id)).toEqual([ID]);
  await change({ lastMessageAt: CUTOFF + 1 });
  expect(await candidates()).toEqual([]);
  await change({ lastMessageAt: null, createdAt: CUTOFF });
  expect(await candidates()).toHaveLength(1);
});

const exclusions: Array<[string, () => void | Promise<void>]> = [
  ["already Done", () => change({ archivedAt: NOW })],
  ["processing", () => change({ processingStartedAt: NOW })],
  ["background", () => change({ conversationType: "background" })],
  ["scheduled", () => change({ conversationType: "scheduled" })],
  ["private", () => change({ conversationType: "private" })],
  ["system", () => change({ source: "system" })],
  ["subagent", () => change({ source: "subagent" })],
  ["spawned child", () => change({ parentConversationId: "conv-parent" })],
  ["memory", () => change({ source: "memory_v2_consolidation" })],
  ["schedule owner", () => change({ scheduleJobId: "schedule-123" })],
  [
    "pin",
    () =>
      requireMainDb().run(
        "UPDATE conversations SET group_id = 'system:pinned' WHERE id = ?",
        [ID],
      ),
  ],
  [
    "background group",
    () =>
      requireMainDb().run(
        "UPDATE conversations SET group_id = 'system:background' WHERE id = ?",
        [ID],
      ),
  ],
  ["external origin", () => change({ originChannel: "slack" })],
  [
    "external binding",
    () =>
      requireMainDb().run(
        "INSERT INTO external_conversation_bindings (conversation_id, source_channel, external_chat_id, created_at, updated_at) VALUES (?, ?, ?, ?, ?)",
        [ID, "telegram", "chat-123", NOW, NOW],
      ),
  ],
  [
    "unread",
    () =>
      requireMainDb().run(
        "INSERT INTO conversation_assistant_attention_state (conversation_id, latest_assistant_message_at, last_seen_assistant_message_at, created_at, updated_at) VALUES (?, ?, ?, ?, ?)",
        [ID, CUTOFF, null, NOW, NOW],
      ),
  ],
  [
    "ACP run",
    () =>
      requireMainDb().run(
        "INSERT INTO acp_session_history (id, agent_id, acp_session_id, parent_conversation_id, status, started_at) VALUES (?, ?, ?, ?, ?, ?)",
        ["acp-123", "agent-123", "session-123", ID, "running", CUTOFF],
      ),
  ],
  [
    "workflow run",
    () =>
      requireMainDb().run(
        "INSERT INTO workflow_runs (id, script_source, script_hash, status, conversation_id) VALUES (?, ?, ?, ?, ?)",
        ["run-123", "", "hash-123", "running", ID],
      ),
  ],
  [
    "mode session",
    () =>
      requireMainDb().run(
        "INSERT INTO conversation_mode_sessions (id, conversation_id, mode, status, source_started_at, last_activity_at) VALUES (?, ?, ?, ?, ?, ?)",
        ["mode-123", ID, "browser", "active", CUTOFF, CUTOFF],
      ),
  ],
  [
    "subagent run",
    () => {
      upsertSubagentRecord({
        id: "task-123",
        parentConversationId: ID,
        conversationId: "conv-child",
        label: "Example task",
        objective: "Example objective",
        role: "builder",
        isFork: false,
        sendResultToUser: true,
        parentToolUseId: null,
        status: "running",
        error: null,
        createdAt: CUTOFF,
        startedAt: CUTOFF,
        completedAt: null,
        inputTokens: 0,
        outputTokens: 0,
        estimatedCost: 0,
      });
    },
  ],
];

describePg.each(exclusions)("%s exclusion", (_name, exclude) => {
  test("is filtered from candidates and rechecked after sampling", async () => {
    const sampled = (await candidates())[0]!;
    await exclude();
    expect(await candidates()).toEqual([]);
    expect(await archiveInactiveConversation(sampled, CUTOFF, NOW)).toBe(false);
  });
});

test("native notification origins and read chats stay eligible", async () => {
  await change({ originChannel: "notification:reminder" });
  await requireMainDb().run(
    "INSERT INTO conversation_assistant_attention_state (conversation_id, latest_assistant_message_at, last_seen_assistant_message_at, created_at, updated_at) VALUES (?, ?, ?, ?, ?)",
    [ID, CUTOFF, CUTOFF, NOW, NOW],
  );
  expect(await candidates()).toHaveLength(1);
});

test("a sampled old message change cannot be overwritten even if it remains below the cutoff", async () => {
  const sampled = (await candidates())[0]!;
  await change({ lastMessageAt: CUTOFF - 1 });
  expect(await archiveInactiveConversation(sampled, CUTOFF, NOW)).toBe(false);
});

test("manual reopen receives a full interval and repeated unarchive does not extend it", async () => {
  await archiveConversation(ID);
  await unarchiveConversation(ID);
  expect(await state()).toEqual({ archivedAt: null, lastReopenedAt: NOW });
  expect(await candidates()).toEqual([]);
  setSystemTime(NOW + DAY);
  await unarchiveConversation(ID);
  expect((await state())?.lastReopenedAt).toBe(NOW);
  expect(
    await listAutoArchiveCandidates({ cutoff: NOW - 1, limit: 100 }),
  ).toEqual([]);
  expect(
    await listAutoArchiveCandidates({ cutoff: NOW, limit: 100 }),
  ).toHaveLength(1);
});

test("reopen after sampling prevents the conditional archive", async () => {
  const sampled = (await candidates())[0]!;
  await archiveConversation(ID);
  await unarchiveConversation(ID);
  expect(await archiveInactiveConversation(sampled, CUTOFF, NOW)).toBe(false);
});

test("archive is idempotent and new visible activity resurfaces it", async () => {
  const sampled = (await candidates())[0]!;
  expect(await archiveInactiveConversation(sampled, CUTOFF, NOW)).toBe(true);
  expect(await archiveInactiveConversation(sampled, CUTOFF, NOW + 1)).toBe(
    false,
  );
  expect(await resurfaceArchivedConversation(ID, NOW + 1)).toBe(true);
  expect(await state()).toEqual({ archivedAt: null, lastReopenedAt: null });
});

test("keyset paging covers all rows while earlier pages are marked Done", async () => {
  for (let i = 0; i < 205; i++) {
    await insert(`conv-page-${String(i).padStart(3, "0")}`);
  }
  const visited: string[] = [];
  let after: Awaited<ReturnType<typeof candidates>>[number] | undefined;
  do {
    const page = await listAutoArchiveCandidates({
      cutoff: CUTOFF,
      limit: 100,
      after,
    });
    if (page.length === 0) {
      break;
    }
    for (const candidate of page) {
      expect(await archiveInactiveConversation(candidate, CUTOFF, NOW)).toBe(
        true,
      );
      visited.push(candidate.id);
    }
    after = page[page.length - 1];
  } while (true);
  expect(new Set(visited).size).toBe(206);
  const doneCount = await requireMainDb().get<{ count: number }>(
    "SELECT count(*) AS count FROM conversations WHERE archived_at IS NOT NULL",
  );
  expect(doneCount?.count).toBe(206);
});
