/**
 * The `checkpoints` slice on Postgres.
 *
 * `checkpoints.ts` reads and writes only `memory_checkpoints`, which lives on
 * the `main` slot, so the async `AsyncDb` facade is what lets the same code run
 * on SQLite and Postgres. This suite runs one scenario body against both
 * backends, mirroring `schedule-store-postgres.test.ts`.
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

import {
  clearLexicalBackfillComplete,
  deleteMemoryCheckpoint,
  getMemoryCheckpoint,
  isLexicalBackfillComplete,
  LEXICAL_BACKFILL_COMPLETE_KEY,
  readMessageCursorCheckpoint,
  resetMessageCursorCheckpoint,
  setMemoryCheckpoint,
  writeMessageCursorCheckpoint,
} from "../checkpoints.js";
import { requireMainDb } from "../db-facade.js";
import { initializeDb } from "../db-init.js";
import { getPostgresAsyncDb } from "../db-postgres-facade.js";
import { PG_STEPS } from "../pg-migrations/pg-steps.js";
import { runPgMigrations } from "../pg-migrations/run-pg-migrations.js";

await initializeDb();

const PG_URL = process.env.VELLUM_PG_TEST_URL;

async function clearCheckpoints(): Promise<void> {
  await requireMainDb().run("DELETE FROM memory_checkpoints");
}

/** One scenario body, run verbatim against each backend. */
function defineStoreScenarios(): void {
  beforeEach(async () => {
    await clearCheckpoints();
  });

  test("round-trips a value and deletes it", async () => {
    expect(await getMemoryCheckpoint("test:missing")).toBeNull();

    await setMemoryCheckpoint("test:value", "hello");
    expect(await getMemoryCheckpoint("test:value")).toBe("hello");

    await setMemoryCheckpoint("test:value", "updated");
    expect(await getMemoryCheckpoint("test:value")).toBe("updated");

    await deleteMemoryCheckpoint("test:value");
    expect(await getMemoryCheckpoint("test:value")).toBeNull();
  });

  test("round-trips the message cursor checkpoint", async () => {
    await writeMessageCursorCheckpoint(
      "test:cursor:created",
      "test:cursor:id",
      {
        createdAt: 1_700_000_000_000,
        messageId: "msg-42",
      },
    );

    const cursor = await readMessageCursorCheckpoint(
      "test:cursor:created",
      "test:cursor:id",
    );
    expect(cursor).toEqual({
      createdAt: 1_700_000_000_000,
      messageId: "msg-42",
    });

    await resetMessageCursorCheckpoint("test:cursor:created", "test:cursor:id");
    expect(
      await readMessageCursorCheckpoint(
        "test:cursor:created",
        "test:cursor:id",
      ),
    ).toEqual({ createdAt: 0, messageId: "" });
  });

  test("tracks the lexical backfill sentinel", async () => {
    expect(await isLexicalBackfillComplete()).toBe(false);

    await setMemoryCheckpoint(LEXICAL_BACKFILL_COMPLETE_KEY, "1");
    expect(await isLexicalBackfillComplete()).toBe(true);

    await clearLexicalBackfillComplete();
    expect(await isLexicalBackfillComplete()).toBe(false);
  });
}

describe("checkpoints (sqlite)", () => {
  beforeAll(() => {
    delete process.env.VELLUM_MAIN_DB_BACKEND;
    delete process.env.VELLUM_MAIN_DATABASE_URL;
  });

  defineStoreScenarios();
});

const pgDescribe = PG_URL ? describe : describe.skip;

pgDescribe("checkpoints (postgres)", () => {
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
