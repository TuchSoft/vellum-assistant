/**
 * The `followups` slice on Postgres.
 *
 * `followup-store.ts` reads and writes only the `followups` table, which lives
 * on the `main` slot, so the async `AsyncDb` facade is what lets the same store
 * code run on SQLite and Postgres. This suite runs one scenario body against
 * both backends, mirroring `schedule-store-postgres.test.ts`.
 *
 * The Postgres leg is gated on `VELLUM_PG_TEST_URL` (throwaway instance); with
 * it unset only the SQLite leg runs.
 */

import {
  afterAll,
  beforeAll,
  beforeEach,
  describe,
  expect,
  test,
} from "bun:test";

import { requireMainDb } from "../../persistence/db-facade.js";
import { initializeDb } from "../../persistence/db-init.js";
import { getPostgresAsyncDb } from "../../persistence/db-postgres-facade.js";
import { PG_STEPS } from "../../persistence/pg-migrations/pg-steps.js";
import { runPgMigrations } from "../../persistence/pg-migrations/run-pg-migrations.js";
import {
  createFollowUp,
  getOverdueFollowUps,
  listFollowUps,
  resolveByConversation,
  resolveFollowUp,
} from "../followup-store.js";

await initializeDb();

const PG_URL = process.env.VELLUM_PG_TEST_URL;

async function clearFollowUps(): Promise<void> {
  await requireMainDb().run("DELETE FROM followups");
}

/** One scenario body, run verbatim against each backend. */
function defineStoreScenarios(): void {
  beforeEach(async () => {
    await clearFollowUps();
  });

  test("creates, lists, and reads back a follow-up", async () => {
    const created = await createFollowUp({
      channel: "email",
      conversationId: "conv-1",
    });
    expect(created.status).toBe("pending");
    expect(created.reminderScheduleId).toBeNull();
    expect(typeof created.sentAt).toBe("number");

    const listed = await listFollowUps({ channel: "email" });
    expect(listed.map((f) => f.id)).toContain(created.id);
  });

  test("surfaces and then clears an overdue follow-up", async () => {
    const created = await createFollowUp({
      channel: "email",
      conversationId: "conv-2",
      expectedResponseBy: Date.now() - 1_000,
    });

    const overdue = await getOverdueFollowUps();
    expect(overdue.map((f) => f.id)).toContain(created.id);

    const resolved = await resolveFollowUp(created.id);
    expect(resolved.status).toBe("resolved");

    const after = await getOverdueFollowUps();
    expect(after.map((f) => f.id)).not.toContain(created.id);
  });

  test("resolves every pending follow-up for a conversation", async () => {
    const a = await createFollowUp({
      channel: "sms",
      conversationId: "conv-3",
    });
    const b = await createFollowUp({
      channel: "sms",
      conversationId: "conv-3",
    });
    await createFollowUp({ channel: "sms", conversationId: "conv-other" });

    const resolved = await resolveByConversation("sms", "conv-3");
    expect(resolved.map((f) => f.id).sort()).toEqual([a.id, b.id].sort());
    expect(resolved.every((f) => f.status === "resolved")).toBe(true);
  });
}

describe("followup store (sqlite)", () => {
  beforeAll(() => {
    delete process.env.VELLUM_MAIN_DB_BACKEND;
    delete process.env.VELLUM_MAIN_DATABASE_URL;
  });

  defineStoreScenarios();
});

const pgDescribe = PG_URL ? describe : describe.skip;

pgDescribe("followup store (postgres)", () => {
  let savedBackend: string | undefined;
  let savedUrl: string | undefined;

  beforeAll(async () => {
    savedBackend = process.env.VELLUM_MAIN_DB_BACKEND;
    savedUrl = process.env.VELLUM_MAIN_DATABASE_URL;
    process.env.VELLUM_MAIN_DB_BACKEND = "postgres";
    process.env.VELLUM_MAIN_DATABASE_URL = PG_URL!;

    const pg = getPostgresAsyncDb("main", PG_URL!);
    await pg.exec("DROP SCHEMA IF EXISTS public CASCADE");
    await pg.exec("CREATE SCHEMA public");
    await runPgMigrations(pg, PG_STEPS);
  });

  afterAll(async () => {
    if (savedBackend === undefined) {
      delete process.env.VELLUM_MAIN_DB_BACKEND;
    } else {
      process.env.VELLUM_MAIN_DB_BACKEND = savedBackend;
    }
    if (savedUrl === undefined) {
      delete process.env.VELLUM_MAIN_DATABASE_URL;
    } else {
      process.env.VELLUM_MAIN_DATABASE_URL = savedUrl;
    }
    if (PG_URL) {
      await getPostgresAsyncDb("main", PG_URL)
        .exec("DROP SCHEMA IF EXISTS public CASCADE")
        .catch(() => {
          /* best-effort */
        });
    }
  });

  defineStoreScenarios();
});
