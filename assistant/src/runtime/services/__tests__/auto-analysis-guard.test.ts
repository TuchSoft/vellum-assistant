import { beforeEach, describe, expect, test } from "bun:test";

import { describePg } from "../../../__tests__/pg-test-db.js";
import { AUTO_ANALYSIS_SOURCE } from "../../../persistence/auto-analysis-constants.js";
import { createConversation } from "../../../persistence/conversation-crud.js";
import { requireMainDb } from "../../../persistence/db-facade.js";
import { isAutoAnalysisConversation } from "../auto-analysis-guard.js";

async function resetTables(): Promise<void> {
  const db = requireMainDb();
  await db.run(`DELETE FROM messages`);
  await db.run(`DELETE FROM conversations`);
}

describe("auto-analysis constants", () => {
  test("AUTO_ANALYSIS_SOURCE is the canonical 'auto-analysis' string", () => {
    expect(AUTO_ANALYSIS_SOURCE).toBe("auto-analysis");
  });
});

describePg("isAutoAnalysisConversation", () => {
  beforeEach(async () => {
    await resetTables();
  });

  test("returns true for a conversation with source = 'auto-analysis'", async () => {
    const conv = await createConversation({
      title: "analysis",
      source: AUTO_ANALYSIS_SOURCE,
    });
    expect(await isAutoAnalysisConversation(conv.id)).toBe(true);
  });

  test("returns false for a conversation with source = 'user'", async () => {
    const conv = await createConversation("regular user conversation");
    expect(await isAutoAnalysisConversation(conv.id)).toBe(false);
  });

  test("returns false for a non-existent conversation", async () => {
    expect(await isAutoAnalysisConversation("does-not-exist")).toBe(false);
  });
});
