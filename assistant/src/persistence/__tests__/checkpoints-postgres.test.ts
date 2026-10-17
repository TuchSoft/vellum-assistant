/**
 * Conformance suite for the `checkpoints` slice on Postgres.
 *
 * `checkpoints.ts` reads and writes only `memory_checkpoints`, which lives on
 * the `main` slot, so the async `AsyncDb` facade is what lets the store run
 * unchanged. The suite runs against the process's Postgres test schema,
 * bootstrapped with the generated baseline by `src/__tests__/pg-test-db.ts`.
 *
 * Gated on `VELLUM_PG_TEST_URL` (throwaway instance); with it unset the suite
 * skips.
 */

import { beforeEach, expect, test } from "bun:test";

import { describePg } from "../../__tests__/pg-test-db.js";
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

await initializeDb();

async function clearCheckpoints(): Promise<void> {
  await requireMainDb().run("DELETE FROM memory_checkpoints");
}

describePg("checkpoints (postgres)", () => {
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
});
