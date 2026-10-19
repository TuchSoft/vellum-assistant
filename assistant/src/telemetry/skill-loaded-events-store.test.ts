import { beforeEach, describe, expect, test } from "bun:test";

import { getTelemetryAsyncDb } from "../persistence/db-facade.js";
import { APP_VERSION } from "../version.js";
import {
  resetOutboxTable,
  setShareAnalytics,
} from "./__tests__/outbox-test-harness.js";
import { recordSkillLoadedEvent } from "./skill-loaded-events-store.js";

/** Read rows through the facade so the assertions are backend-portable. */
async function pendingRows(): Promise<
  Array<{
    id: string;
    name: string;
    createdAt: number;
    conversationId: string | null;
    payload: Record<string, unknown>;
  }>
> {
  const db = getTelemetryAsyncDb();
  if (!db) {
    throw new Error("telemetry DB unavailable in test");
  }
  const rows = await db.all<{
    id: string;
    name: string;
    createdAt: number;
    conversationId: string | null;
    payload: string;
  }>(
    `SELECT id, name, created_at AS "createdAt", conversation_id AS "conversationId", payload
     FROM telemetry_events ORDER BY created_at, id`,
  );
  return rows.map((row) => ({
    ...row,
    payload: JSON.parse(row.payload) as Record<string, unknown>,
  }));
}

describe("skill-loaded-events-store", () => {
  beforeEach(async () => {
    setShareAnalytics(true);
    await resetOutboxTable();
  });

  test("honors the share_analytics opt-out (records nothing)", async () => {
    setShareAnalytics(false);
    await recordSkillLoadedEvent({ skillName: "web-research" });
    expect(await pendingRows()).toHaveLength(0);
  });

  test("record writes the full wire payload into the outbox", async () => {
    await recordSkillLoadedEvent({
      conversationId: "conv-xyz",
      skillName: "web-research",
      skillUpdatedAt: "2026-06-01T00:00:00.000Z",
      provider: "anthropic",
      model: "model-a",
      modelSource: "chat",
    });

    const rows = await pendingRows();
    expect(rows).toHaveLength(1);
    const row = rows[0]!;
    expect(row.name).toBe("skill_loaded");
    expect(row.id).toBeString();
    expect(row.createdAt).toBeGreaterThan(0);
    // Dedicated column, so conversation deletion redacts pending rows via an
    // indexed delete.
    expect(row.conversationId).toBe("conv-xyz");
    expect(row.payload).toEqual({
      type: "skill_loaded",
      daemon_event_id: row.id,
      recorded_at: row.createdAt,
      skill_name: "web-research",
      skill_updated_at: "2026-06-01T00:00:00.000Z",
      conversation_id: "conv-xyz",
      provider: "anthropic",
      model: "model-a",
      inference_profile: "balanced",
      inference_profile_source: "active-profile",
      assistant_version: APP_VERSION,
    });
  });

  test("optional fields ship as null and leave the conversation column null", async () => {
    await recordSkillLoadedEvent({ skillName: "tasks" });

    const rows = await pendingRows();
    expect(rows).toHaveLength(1);
    expect(rows[0]!.conversationId).toBeNull();
    expect(rows[0]!.payload).toMatchObject({
      type: "skill_loaded",
      skill_name: "tasks",
      skill_updated_at: null,
      conversation_id: null,
      provider: null,
      model: null,
      inference_profile: null,
      inference_profile_source: null,
    });
  });
});
