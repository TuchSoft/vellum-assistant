/**
 * Regression: `recordConversationPersistedSeq` must not throw on transient
 * write contention.
 *
 * The persisted-seq anchor is written from the agent loop as fire-and-forget
 * bookkeeping (`flushAccumulatedContent`, `handleMessageComplete`, tool
 * events). Before this resilience layer the write went through a bare
 * `rawRun`, so a `SQLITE_BUSY` ("database is locked") threw raw: on the
 * debounced partial-flush path it surfaced as an unhandled promise rejection,
 * and on the `message_complete` path it hit `dispatchAgentEvent`'s re-throw
 * allowlist — either one tripped the daemon's fail-fast shutdown and crashed
 * the process.
 *
 * These tests pin the two guarantees:
 *  1. A retryable `SQLITE_BUSY` is swallowed (the anchor simply does not
 *     advance) and self-heals on the next successful record.
 *  2. A non-retryable error (a genuine bug) still propagates.
 */
import { beforeEach, expect, mock, setDefaultTimeout, test } from "bun:test";
setDefaultTimeout(30_000);

// Wrap the real db facade so only the persisted-seq UPDATE can be made to
// throw on demand while every other DB call (createConversation, the read-back
// via `getConversationPersistedSeq`) keeps hitting the real database.
const actualFacade = await import("../persistence/db-facade.js");
// Capture the real accessor before registering the mock: `mock.module` mutates
// the live module namespace in place, so reading it from the factory would
// re-resolve to the mock and recurse forever.
const realRequireMainDb = actualFacade.requireMainDb;

let injectedRecordError: Error | null = null;

mock.module("../persistence/db-facade.js", () => ({
  ...actualFacade,
  requireMainDb: () => {
    const db = realRequireMainDb();
    return new Proxy(db, {
      get(target, prop) {
        if (prop === "run") {
          return (sql: string, params?: readonly unknown[]) => {
            if (
              sql.includes("UPDATE conversations SET seq") &&
              injectedRecordError
            ) {
              return Promise.reject(injectedRecordError);
            }
            return target.run(sql, params as never);
          };
        }
        const value = Reflect.get(target, prop, target);
        return typeof value === "function" ? value.bind(target) : value;
      },
    });
  },
}));

import {
  createConversation,
  getConversationPersistedSeq,
  recordConversationPersistedSeq,
} from "../persistence/conversation-crud.js";
import { describePg } from "./pg-test-db.js";

function sqliteError(code: string): Error {
  return Object.assign(new Error("database is locked"), { code });
}

describePg("recordConversationPersistedSeq write-contention resilience", () => {
  beforeEach(() => {
    injectedRecordError = null;
  });

  test("swallows a transient SQLITE_BUSY and self-heals on the next record", async () => {
    // GIVEN a conversation with a recorded baseline anchor
    const conv = await createConversation();
    await recordConversationPersistedSeq(conv.id, 10);
    expect(await getConversationPersistedSeq(conv.id)).toBe(10);

    // WHEN the anchor-advancing write loses the write-lock race
    injectedRecordError = sqliteError("SQLITE_BUSY");
    await expect(
      recordConversationPersistedSeq(conv.id, 20),
    ).resolves.toBeUndefined();

    // THEN the anchor is simply left un-advanced (no crash, no regression) ...
    expect(await getConversationPersistedSeq(conv.id)).toBe(10);

    // ... and the next contention-free record advances it (self-healing).
    injectedRecordError = null;
    await recordConversationPersistedSeq(conv.id, 20);
    expect(await getConversationPersistedSeq(conv.id)).toBe(20);
  });

  test("swallows the extended-result-code SQLITE_BUSY_SNAPSHOT too", async () => {
    const conv = await createConversation();
    injectedRecordError = sqliteError("SQLITE_BUSY_SNAPSHOT");
    await expect(
      recordConversationPersistedSeq(conv.id, 5),
    ).resolves.toBeUndefined();
    expect(await getConversationPersistedSeq(conv.id)).toBeNull();
  });

  test("rethrows a non-retryable SQLite error (a genuine bug)", async () => {
    const conv = await createConversation();
    injectedRecordError = sqliteError("SQLITE_ERROR");
    await expect(recordConversationPersistedSeq(conv.id, 5)).rejects.toThrow(
      "database is locked",
    );
  });
});
