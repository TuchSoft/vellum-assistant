/**
 * Tests that deleting a conversation with an associated schedule job also
 * deletes the schedule, preventing orphaned scheduled automations.
 */

import { beforeEach, expect, mock, setDefaultTimeout, test } from "bun:test";

mock.module("../config/env.js", () => ({
  isHttpAuthDisabled: () => true,
  hasUngatedHttpAuthDisabled: () => false,
}));

mock.module("../daemon/handlers/conversations.js", () => ({
  cancelGeneration: () => true,
  clearAllConversations: async () => 0,
  switchConversation: async () => null,
  undoLastMessage: async () => null,
}));

import {
  createConversation,
  getConversation,
} from "../persistence/conversation-crud.js";
import {
  getLogsSqlite,
  getMemorySqlite,
} from "../persistence/db-connection.js";
import { requireMainDb } from "../persistence/db-facade.js";
import { initializeDb } from "../persistence/db-init.js";
import { ROUTES } from "../runtime/routes/conversation-management-routes.js";
import { createSchedule, getSchedule } from "../schedule/schedule-store.js";
import { describePg } from "./pg-test-db.js";

await initializeDb();

const deleteRoute = ROUTES.find((r) => r.operationId === "deleteConversation")!;

describePg("DELETE /conversations/:id — schedule cleanup", () => {
  beforeEach(async () => {
    const db = requireMainDb();
    await db.run("DELETE FROM cron_runs");
    await db.run("DELETE FROM cron_jobs");
    getMemorySqlite()!.run("DELETE FROM memory_graph_nodes");
    getMemorySqlite()!.run("DELETE FROM memory_segments");
    getMemorySqlite()!.run("DELETE FROM memory_summaries");
    getMemorySqlite()!.run("DELETE FROM memory_embeddings");
    getMemorySqlite()!.run("DELETE FROM memory_jobs");
    await db.run("DELETE FROM tool_invocations");
    getLogsSqlite()!.run("DELETE FROM llm_request_logs");
    await db.run("DELETE FROM messages");
    await db.run("DELETE FROM conversations");
  });

  test("deleting a conversation with a scheduleJobId removes the schedule", async () => {
    const schedule = await createSchedule({
      name: "Daily standup",
      expression: "0 9 * * 1-5",
      message: "Time for standup!",
    });

    const conv = await createConversation({
      source: "schedule",
      scheduleJobId: schedule.id,
    });

    expect(await getSchedule(schedule.id)).not.toBeNull();

    await deleteRoute.handler({
      pathParams: { id: conv.id },
      body: {},
      headers: {},
    });

    expect(await getSchedule(schedule.id)).toBeNull();
    expect(await getConversation(conv.id)).toBeNull();
  });

  test("deleting a conversation without a scheduleJobId does not affect schedules", async () => {
    const schedule = await createSchedule({
      name: "Unrelated schedule",
      expression: "0 12 * * *",
      message: "Noon check",
    });

    const conv = await createConversation("no-schedule-conv");

    await deleteRoute.handler({
      pathParams: { id: conv.id },
      body: {},
      headers: {},
    });

    expect(await getSchedule(schedule.id)).not.toBeNull();
    expect(await getConversation(conv.id)).toBeNull();
  });

  test("deleting a conversation with a schedule also removes its cron_runs", async () => {
    const schedule = await createSchedule({
      name: "Recurring job",
      expression: "0 9 * * *",
      message: "Daily task",
    });

    const conv = await createConversation({
      source: "schedule",
      scheduleJobId: schedule.id,
    });

    const now = Date.now();
    const db = requireMainDb();
    await db.run(
      `INSERT INTO cron_runs (id, job_id, conversation_id, status, started_at, created_at)
       VALUES ('run-1', ?, ?, 'ok', ?, ?)`,
      [schedule.id, conv.id, now, now],
    );

    const runBefore = await db.get(
      "SELECT * FROM cron_runs WHERE id = 'run-1'",
    );
    expect(runBefore).not.toBeNull();

    await deleteRoute.handler({
      pathParams: { id: conv.id },
      body: {},
      headers: {},
    });

    expect(await getSchedule(schedule.id)).toBeNull();
    const runAfter = await db.get("SELECT * FROM cron_runs WHERE id = 'run-1'");
    expect(runAfter).toBeNull();
  });

  test("deleting one of multiple conversations sharing a schedule preserves the schedule", async () => {
    const schedule = await createSchedule({
      name: "Recurring daily",
      expression: "0 9 * * *",
      message: "Daily task",
    });

    const conv1 = await createConversation({
      source: "schedule",
      scheduleJobId: schedule.id,
    });
    await createConversation({
      source: "schedule",
      scheduleJobId: schedule.id,
    });

    await deleteRoute.handler({
      pathParams: { id: conv1.id },
      body: {},
      headers: {},
    });

    expect(await getSchedule(schedule.id)).not.toBeNull();
  });

  test("deleting one scheduled conversation does not affect other schedules", async () => {
    const scheduleA = await createSchedule({
      name: "Schedule A",
      expression: "0 9 * * *",
      message: "Task A",
    });
    const scheduleB = await createSchedule({
      name: "Schedule B",
      expression: "0 17 * * *",
      message: "Task B",
    });

    const convA = await createConversation({
      source: "schedule",
      scheduleJobId: scheduleA.id,
    });
    await createConversation({
      source: "schedule",
      scheduleJobId: scheduleB.id,
    });

    await deleteRoute.handler({
      pathParams: { id: convA.id },
      body: {},
      headers: {},
    });

    expect(await getSchedule(scheduleA.id)).toBeNull();
    expect(await getSchedule(scheduleB.id)).not.toBeNull();
  });
});

setDefaultTimeout(30_000);
