import { afterEach, beforeEach, expect, test } from "bun:test";

import { describePg } from "../../../../__tests__/pg-test-db.js";
import { requireMainDb } from "../../../../persistence/db-facade.js";
import {
  isActivationSession,
  markActivationSession,
} from "../activation-session-store.js";

describePg("activation-session-store", () => {
  beforeEach(async () => {
    await requireMainDb().run("DELETE FROM activation_sessions");
  });

  test("marks a conversation and reports it as an activation session", async () => {
    await markActivationSession("c1");
    expect(await isActivationSession("c1")).toBe(true);
  });

  test("unmarked conversations are not activation sessions", async () => {
    expect(await isActivationSession("nope")).toBe(false);
  });

  test("marking the same conversation twice is idempotent", async () => {
    await markActivationSession("c1");
    await markActivationSession("c1");
    expect(await isActivationSession("c1")).toBe(true);
    const count = await requireMainDb().get<{ n: number }>(
      "SELECT COUNT(*) AS n FROM activation_sessions",
    );
    expect(count?.n).toBe(1);
  });

  test("rows land in the memory database, not main", async () => {
    await markActivationSession("c-placement");
    const inMemory = await requireMainDb().get<{ conversation_id: string }>(
      "SELECT conversation_id FROM activation_sessions WHERE conversation_id = 'c-placement'",
    );
    expect(inMemory?.conversation_id).toBe("c-placement");
  });
});

describePg("activation-session-store — degraded memory database", () => {
  // Shadow the table with a view over a missing relation: every read and write
  // fails, so the store's catch paths must swallow the failure (write no-ops,
  // read reports false) rather than throw into the turn.
  beforeEach(async () => {
    const db = requireMainDb();
    const schema = (await db.get<{ s: string }>(
      "SELECT current_schema() AS s",
    ))!.s;
    await db.exec(`DROP TABLE IF EXISTS "${schema}".activation_sessions`);
    await db.exec(
      `CREATE VIEW "${schema}".activation_sessions AS SELECT DISTINCT ''::text AS conversation_id, 0::bigint AS created_at`,
    );
  });

  afterEach(async () => {
    const db = requireMainDb();
    const schema = (await db.get<{ s: string }>(
      "SELECT current_schema() AS s",
    ))!.s;
    await db.exec(`DROP VIEW IF EXISTS "${schema}".activation_sessions`);
    await db.exec(
      `CREATE TABLE IF NOT EXISTS "${schema}".activation_sessions (conversation_id text PRIMARY KEY, created_at bigint NOT NULL)`,
    );
  });

  test("mark is a no-op and read reports false", async () => {
    await markActivationSession("c1");
    expect(await isActivationSession("c1")).toBe(false);
  });
});
