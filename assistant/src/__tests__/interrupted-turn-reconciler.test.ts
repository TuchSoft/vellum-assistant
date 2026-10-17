import { beforeEach, expect, mock, setDefaultTimeout, test } from "bun:test";
setDefaultTimeout(30_000);

import {
  type InterruptedResumeTarget,
  MAX_RESUME_ATTEMPTS,
  reconcileInterruptedConversations,
  resumeInterruptedConversations,
} from "../daemon/interrupted-turn-reconciler.js";
import { INTERNAL_GUARDIAN_TRUST_CONTEXT } from "../daemon/trust-context.js";
import {
  createConversation,
  incrementProcessingResumeAttempts,
  listInterruptedConversations,
  setConversationOriginChannelIfUnset,
  setConversationProcessingStartedAt,
} from "../persistence/conversation-crud.js";
import { requireMainDb } from "../persistence/db-facade.js";
import { describePg } from "./pg-test-db.js";

const actualConversationCrud =
  await import("../persistence/conversation-crud.js");

async function readRow(id: string): Promise<{
  processing_started_at: number | null;
  processing_resume_attempts: number;
}> {
  const row = await requireMainDb().get<{
    processing_started_at: number | null;
    processing_resume_attempts: number;
  }>(
    `SELECT processing_started_at, processing_resume_attempts
       FROM conversations WHERE id = ?`,
    [id],
  );
  if (!row) {
    throw new Error(`conversation row missing: ${id}`);
  }
  return row;
}

/** A local conversation (no origin channel) resumes under guardian trust. */
function guardianTarget(conversationId: string): InterruptedResumeTarget {
  return { conversationId, trustContext: INTERNAL_GUARDIAN_TRUST_CONTEXT };
}

async function seedInterrupted(id: string, resumeAttempts = 0): Promise<void> {
  await createConversation({ id });
  await setConversationProcessingStartedAt(id, Date.now());
  for (let i = 0; i < resumeAttempts; i++) {
    await incrementProcessingResumeAttempts(id);
  }
}

describePg("interrupted-turn reconciler", () => {
  beforeEach(async () => {
    await requireMainDb().run("DELETE FROM messages");
    await requireMainDb().run("DELETE FROM conversations");
  });

  test("resume disabled: resumes nothing and leaves flags for the monitor to clear", async () => {
    await seedInterrupted("conv-a");
    await seedInterrupted("conv-b");
    await createConversation({ id: "conv-idle" });

    const result = await reconcileInterruptedConversations(false);

    expect(result.resume).toEqual([]);
    expect(result.capped).toEqual([]);
    expect(result.trustUnrecoverable).toEqual([]);
    // The reconciler no longer clears — the monitor's recovery pass does.
    expect((await readRow("conv-a")).processing_started_at).not.toBeNull();
    expect((await readRow("conv-b")).processing_started_at).not.toBeNull();
  });

  test("resume enabled: selects local conversations under guardian trust and leaves flags set", async () => {
    await seedInterrupted("conv-a");
    await createConversation({ id: "conv-idle" });

    const result = await reconcileInterruptedConversations(true);

    expect(result.resume).toEqual([guardianTarget("conv-a")]);
    expect(result.capped).toEqual([]);
    expect(result.trustUnrecoverable).toEqual([]);
    // Selection reads the flag but leaves it set for the monitor to clear.
    expect((await readRow("conv-a")).processing_started_at).not.toBeNull();
    // Selection no longer charges the attempt — that happens as each wake
    // starts, so a crash mid-resume can't burn un-attempted budgets.
    expect((await readRow("conv-a")).processing_resume_attempts).toBe(0);
    expect((await readRow("conv-idle")).processing_resume_attempts).toBe(0);
  });

  test("the internal vellum channel is treated as a guardian-owned local conversation", async () => {
    await seedInterrupted("conv-vellum");
    await setConversationOriginChannelIfUnset("conv-vellum", "vellum");

    const result = await reconcileInterruptedConversations(true);

    expect(result.resume).toEqual([guardianTarget("conv-vellum")]);
    expect(result.trustUnrecoverable).toEqual([]);
  });

  test("remote-channel conversations are skipped when trust can't be recovered", async () => {
    await seedInterrupted("conv-remote");
    await setConversationOriginChannelIfUnset("conv-remote", "telegram");
    await seedInterrupted("conv-local");

    const result = await reconcileInterruptedConversations(true);

    expect(result.resume).toEqual([guardianTarget("conv-local")]);
    expect(result.capped).toEqual([]);
    expect(result.trustUnrecoverable).toEqual(["conv-remote"]);
    expect((await readRow("conv-remote")).processing_started_at).not.toBeNull();
    // A skipped conversation is never charged an attempt.
    expect((await readRow("conv-remote")).processing_resume_attempts).toBe(0);
  });

  test("conversations at the attempt cap are not resumed", async () => {
    await seedInterrupted("conv-fresh");
    await seedInterrupted("conv-capped", MAX_RESUME_ATTEMPTS);

    const result = await reconcileInterruptedConversations(true);

    expect(result.resume).toEqual([guardianTarget("conv-fresh")]);
    expect(result.capped).toEqual(["conv-capped"]);
    expect(result.trustUnrecoverable).toEqual([]);
    expect((await readRow("conv-capped")).processing_started_at).not.toBeNull();
    expect((await readRow("conv-capped")).processing_resume_attempts).toBe(
      MAX_RESUME_ATTEMPTS,
    );
  });

  test("attempts charged at wake start make the cap hold across boots", async () => {
    await seedInterrupted("conv-a");

    // Boot 1: selected for resume; the wake charges the attempt, then the
    // resumed turn dies mid-flight and re-sets the processing flag.
    expect((await reconcileInterruptedConversations(true)).resume).toEqual([
      guardianTarget("conv-a"),
    ]);
    await incrementProcessingResumeAttempts("conv-a");
    await setConversationProcessingStartedAt("conv-a", Date.now());

    // Boot 2: same again.
    expect((await reconcileInterruptedConversations(true)).resume).toEqual([
      guardianTarget("conv-a"),
    ]);
    await incrementProcessingResumeAttempts("conv-a");
    await setConversationProcessingStartedAt("conv-a", Date.now());

    // Boot 3: the counter reached the cap, so the flag is cleared but no
    // resume is selected.
    const third = await reconcileInterruptedConversations(true);
    expect(third.resume).toEqual([]);
    expect(third.capped).toEqual(["conv-a"]);
  });

  test("a clean turn end resets the attempt counter", async () => {
    await seedInterrupted("conv-a", 1);

    await setConversationProcessingStartedAt("conv-a", null);

    expect((await readRow("conv-a")).processing_resume_attempts).toBe(0);
    expect(await listInterruptedConversations()).toEqual([]);
  });

  test("listInterruptedConversations reports only flagged conversations with their attempts", async () => {
    await seedInterrupted("conv-a", 1);
    await createConversation({ id: "conv-idle" });

    expect(await listInterruptedConversations()).toEqual([
      { id: "conv-a", resumeAttempts: 1 },
    ]);
  });
});

describePg("resumeInterruptedConversations", () => {
  beforeEach(async () => {
    await requireMainDb().run("DELETE FROM messages");
    await requireMainDb().run("DELETE FROM conversations");
  });

  test("charges each attempt only as its own wake begins and threads trust", async () => {
    await createConversation({ id: "conv-a" });
    await createConversation({ id: "conv-b" });

    // Snapshot both counters at the instant each conversation's wake runs, so
    // we can prove a conversation still queued behind another has not been
    // charged yet — a crash mid-resume must not burn its budget.
    const attemptsWhenWoken: Record<string, { a: number; b: number }> = {};
    const wakeCalls: Array<Record<string, unknown>> = [];
    const wakeMock = mock(async (opts: Record<string, unknown>) => {
      const conversationId = opts.conversationId as string;
      attemptsWhenWoken[conversationId] = {
        a: (await readRow("conv-a")).processing_resume_attempts,
        b: (await readRow("conv-b")).processing_resume_attempts,
      };
      wakeCalls.push(opts);
      return { invoked: true, producedToolCalls: false };
    });
    mock.module("../runtime/agent-wake.js", () => ({
      wakeAgentForOpportunity: wakeMock,
    }));

    await resumeInterruptedConversations([
      guardianTarget("conv-a"),
      guardianTarget("conv-b"),
    ]);

    // conv-a is charged before its own wake; conv-b is still at 0 while conv-a
    // runs, and is charged only when its own wake begins.
    expect(attemptsWhenWoken["conv-a"]).toEqual({ a: 1, b: 0 });
    expect(attemptsWhenWoken["conv-b"]).toEqual({ a: 1, b: 1 });
    expect((await readRow("conv-a")).processing_resume_attempts).toBe(1);
    expect((await readRow("conv-b")).processing_resume_attempts).toBe(1);

    expect(wakeCalls).toHaveLength(2);
    expect(wakeCalls[0]).toMatchObject({
      conversationId: "conv-a",
      source: "interrupted-turn-resume",
      trustContext: INTERNAL_GUARDIAN_TRUST_CONTEXT,
      clientless: true,
      persistTriggerAsEvent: true,
    });
  });

  test("a failing wake still charges its own attempt and continues to the next", async () => {
    await createConversation({ id: "conv-bad" });
    await createConversation({ id: "conv-good" });

    const wakeCalls: string[] = [];
    const wakeMock = mock(async (opts: Record<string, unknown>) => {
      const conversationId = opts.conversationId as string;
      wakeCalls.push(conversationId);
      if (conversationId === "conv-bad") {
        throw new Error("wake blew up");
      }
      return { invoked: true, producedToolCalls: false };
    });
    mock.module("../runtime/agent-wake.js", () => ({
      wakeAgentForOpportunity: wakeMock,
    }));

    await resumeInterruptedConversations([
      guardianTarget("conv-bad"),
      guardianTarget("conv-good"),
    ]);

    // The bad conversation was attempted (so it was charged), and the failure
    // did not block the remaining conversation.
    expect(wakeCalls).toEqual(["conv-bad", "conv-good"]);
    expect((await readRow("conv-bad")).processing_resume_attempts).toBe(1);
    expect((await readRow("conv-good")).processing_resume_attempts).toBe(1);
  });

  test("a failing counter write is isolated to its conversation and does not abort the rest", async () => {
    await createConversation({ id: "conv-bad" });
    await createConversation({ id: "conv-good" });

    // A transient counter-write failure (e.g. a locked SQLite db during
    // startup) must be logged and skipped for that conversation, exactly like a
    // failing wake — never rejected out of the loop, which would strand every
    // conversation queued behind it.
    // Captured before mock.module: the namespace binding is live post-mock, so
    // delegating through it would recurse into this override.
    const realIncrement =
      actualConversationCrud.incrementProcessingResumeAttempts;
    mock.module("../persistence/conversation-crud.js", () => ({
      ...actualConversationCrud,
      incrementProcessingResumeAttempts: (id: string) => {
        if (id === "conv-bad") {
          throw new Error("counter write failed");
        }
        return realIncrement(id);
      },
    }));

    const wakeCalls: string[] = [];
    const wakeMock = mock(async (opts: Record<string, unknown>) => {
      wakeCalls.push(opts.conversationId as string);
      return { invoked: true, producedToolCalls: false };
    });
    mock.module("../runtime/agent-wake.js", () => ({
      wakeAgentForOpportunity: wakeMock,
    }));

    await resumeInterruptedConversations([
      guardianTarget("conv-bad"),
      guardianTarget("conv-good"),
    ]);

    // conv-bad's counter threw before its wake ran, so it was skipped and never
    // charged; conv-good still resumed and charged its own attempt.
    expect(wakeCalls).toEqual(["conv-good"]);
    expect((await readRow("conv-bad")).processing_resume_attempts).toBe(0);
    expect((await readRow("conv-good")).processing_resume_attempts).toBe(1);
  });
});
