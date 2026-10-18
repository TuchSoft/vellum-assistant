import { describe, expect, test } from "bun:test";

import type { ModeSessionSummary } from "../api/mode-session.js";
import type { ModeSessionWriteResult } from "../persistence/conversation-mode-sessions.js";
import { BrowserModeSessionProducer } from "./browser-mode-session.js";
import {
  ConversationModeSessionCoordinator,
  type ConversationModeSessionCoordinatorDependencies,
} from "./conversation-mode-session.js";

function activeSession(
  overrides: Partial<ModeSessionSummary> = {},
): ModeSessionSummary {
  return {
    id: "session-123",
    conversationId: "conv-123",
    mode: "computer_use",
    status: "active",
    sourceStartedAt: 100,
    firstIncludedAt: null,
    firstIncludedMessageId: null,
    lastActivityAt: 100,
    lastOwnedMessageId: null,
    endedAt: null,
    endReason: null,
    revision: 1,
    ...overrides,
  } as ModeSessionSummary;
}

function createDependencies(initial = activeSession()) {
  let session: ModeSessionSummary = initial;
  const stamps: Array<{ messageId: string; sessionId: string }> = [];
  let publications = 0;
  let forceStaleOnce = false;
  let creations = 0;
  let generatedIds = 0;
  const stampFailures = new Set<string>();

  const staleOrMutate = (
    expectedRevision: number,
    mutate: (current: ModeSessionSummary) => ModeSessionSummary,
  ): ModeSessionWriteResult => {
    if (forceStaleOnce) {
      forceStaleOnce = false;
      session = { ...session, revision: session.revision + 1 };
      return { ok: false, reason: "stale_revision", session };
    }
    if (session.status !== "active") {
      return { ok: false, reason: "terminal", session };
    }
    if (session.revision !== expectedRevision) {
      return { ok: false, reason: "stale_revision", session };
    }
    session = mutate(session);
    return { ok: true, session };
  };

  const dependencies: ConversationModeSessionCoordinatorDependencies = {
    createId: () => (generatedIds++ === 0 ? initial.id : "session-created"),
    beginSession: async (input) => {
      session = activeSession({
        ...(creations++ === 0 ? initial : {}),
        id: input.id,
        conversationId: input.conversationId,
        mode: input.mode,
        sourceStartedAt: input.sourceStartedAt,
        lastActivityAt: input.sourceStartedAt,
      });
      return { ok: true, session };
    },
    getSession: async (conversationId, id) =>
      conversationId === session.conversationId && id === session.id
        ? session
        : null,
    updateActivity: async (input) =>
      staleOrMutate(input.expectedRevision, (current) => ({
        ...current,
        revision: current.revision + 1,
        lastActivityAt: Math.max(current.lastActivityAt, input.lastActivityAt),
        ...(input.lastOwnedMessageId !== undefined
          ? { lastOwnedMessageId: input.lastOwnedMessageId }
          : {}),
      })),
    updateBoundaries: async (input) =>
      staleOrMutate(input.expectedRevision, (current) => ({
        ...current,
        revision: current.revision + 1,
        firstIncludedAt: input.firstIncluded?.at ?? null,
        firstIncludedMessageId: input.firstIncluded?.messageId ?? null,
        lastActivityAt: Math.max(current.lastActivityAt, input.lastActivityAt),
        lastOwnedMessageId: input.lastOwnedMessageId,
      })),
    advanceRevision: async (input) =>
      staleOrMutate(input.expectedRevision, (current) => ({
        ...current,
        revision: current.revision + 1,
      })),
    finalize: async (input) =>
      staleOrMutate(
        input.expectedRevision,
        (current) =>
          ({
            ...current,
            revision: current.revision + 1,
            status: input.status,
            endedAt: input.endedAt,
            endReason: input.endReason,
            lastActivityAt: Math.max(
              current.lastActivityAt,
              input.lastActivityAt ?? current.lastActivityAt,
            ),
            ...(input.lastOwnedMessageId !== undefined
              ? { lastOwnedMessageId: input.lastOwnedMessageId }
              : {}),
          }) as ModeSessionSummary,
      ),
    stampMessage: async (messageId, owner) => {
      if (stampFailures.has(messageId)) {
        throw new Error("metadata write failed");
      }
      stamps.push({ messageId, sessionId: owner.id });
    },
    publishMessagesChanged: () => {
      publications += 1;
    },
  };

  return {
    dependencies,
    stamps,
    session: () => session,
    publications: () => publications,
    forceStale: () => {
      forceStaleOnce = true;
    },
    replaceSession: (next: ModeSessionSummary) => {
      session = next;
    },
    failStamp: (messageId: string) => {
      stampFailures.add(messageId);
    },
    allowStamp: (messageId: string) => {
      stampFailures.delete(messageId);
    },
  };
}

async function activateSource(
  coordinator: ConversationModeSessionCoordinator,
  session: ModeSessionSummary,
  sourceId = "computer-source",
  generation = 1,
) {
  const handle = await coordinator.activateSource({
    sourceId,
    generation,
    mode: session.mode,
    sourceStartedAt: session.sourceStartedAt,
  });
  expect(handle).toBeDefined();
  return handle!;
}

describe("ConversationModeSessionCoordinator", () => {
  test("does not retain unowned or terminal bookkeeping", async () => {
    const store = createDependencies();
    const coordinator = new ConversationModeSessionCoordinator(
      "conv-123",
      store.dependencies,
    );

    expect(coordinator.hasResidentWork()).toBe(false);
    await coordinator.acceptTurn("turn-unowned");
    expect(coordinator.hasResidentWork()).toBe(false);
    coordinator.describeSummary(
      activeSession({
        status: "completed",
        endedAt: 120,
        endReason: "settled",
      }),
    );
    expect(coordinator.hasResidentWork()).toBe(false);
  });

  test("activates a durable source once per generation", async () => {
    const store = createDependencies();
    const coordinator = new ConversationModeSessionCoordinator(
      "conv-123",
      store.dependencies,
    );
    expect(
      await coordinator.activateSource({
        sourceId: "computer-source",
        generation: 1,
        mode: "computer_use",
        sourceStartedAt: 200,
      }),
    ).toMatchObject({
      id: "session-123",
      mode: "computer_use",
      sourceId: "computer-source",
      generation: 1,
      activation: 1,
    });
    expect(
      await coordinator.activateSource({
        sourceId: "computer-source",
        generation: 1,
        mode: "computer_use",
        sourceStartedAt: 300,
      }),
    ).toMatchObject({
      id: "session-123",
      mode: "computer_use",
      activation: 1,
    });
    expect(
      await coordinator.activateSource({
        sourceId: "computer-source",
        generation: 0,
        mode: "computer_use",
        sourceStartedAt: 400,
      }),
    ).toBeUndefined();
    expect(store.session()).toMatchObject({
      sourceStartedAt: 200,
      lastActivityAt: 200,
    });
  });

  test("mints a new run after a successful turn without resetting the source", async () => {
    const store = createDependencies();
    const ids = ["session-first", "session-second"];
    store.dependencies.createId = () => ids.shift()!;
    const coordinator = new ConversationModeSessionCoordinator(
      "conv-123",
      store.dependencies,
    );
    const first = await coordinator.activateSource({
      sourceId: "browser-source",
      generation: 1,
      mode: "browser",
      sourceStartedAt: 100,
    });
    expect(first?.id).toBe("session-first");
    await coordinator.claimTurn("turn-first", first!, 110);
    await coordinator.trackPersistedRow("turn-first", "assistant-first", 120);
    expect(
      await coordinator.finalizeTurn({
        turnId: "turn-first",
        status: "completed",
        endedAt: 130,
        endReason: "turn_settled",
      }),
    ).toBe(true);

    expect(
      await coordinator.activateSource({
        sourceId: "browser-source",
        generation: 1,
        mode: "browser",
        sourceStartedAt: 140,
      }),
    ).toMatchObject({
      id: "session-second",
      generation: 1,
      activation: 2,
    });
  });

  test.each([
    ["completed", "turn_settled"],
    ["interrupted", "error"],
  ] as const)(
    "uses the turn outcome after a browser command error (%s)",
    async (status, endReason) => {
      const store = createDependencies();
      const coordinator = new ConversationModeSessionCoordinator(
        "conv-123",
        store.dependencies,
      );
      const producer = new BrowserModeSessionProducer(coordinator);
      const first = await producer.beginOperation({
        turnId: "turn-123",
        lifecycle: "action",
        at: 100,
      });
      await coordinator.trackPersistedRow("turn-123", "assistant-123", 110);
      await producer.finishOperation(first, {
        at: 120,
        isError: true,
        cancelled: false,
      });
      expect(coordinator.getTerminalDisposition("turn-123")).toBeUndefined();
      expect(store.session()).toMatchObject({
        mode: "browser",
        status: "active",
        lastActivityAt: 120,
      });

      const retry = await producer.beginOperation({
        turnId: "turn-123",
        lifecycle: "action",
        at: 130,
      });
      expect(retry?.handle).toEqual(first?.handle);
      await producer.finishOperation(retry, {
        at: 140,
        isError: false,
        cancelled: false,
      });
      expect(store.session().lastActivityAt).toBe(140);
      await coordinator.releaseTurn("turn-123", { status, endReason });
      expect(store.session()).toMatchObject({ status, endReason });
      expect(coordinator.hasResidentWork()).toBe(false);
    },
  );

  test("claims once and backfills only successfully tracked rows", async () => {
    const store = createDependencies();
    const coordinator = new ConversationModeSessionCoordinator(
      "conv-123",
      store.dependencies,
    );
    const handle = await activateSource(coordinator, store.session());

    await coordinator.acceptTurn("turn-123");
    await coordinator.trackPersistedRow("turn-123", "assistant-123", 90);
    expect(await coordinator.claimTurn("turn-123", handle, 120)).toEqual({
      id: "session-123",
      mode: "computer_use",
    });
    expect(store.stamps).toEqual([
      { messageId: "assistant-123", sessionId: "session-123" },
    ]);
    expect(store.session()).toMatchObject({
      firstIncludedAt: 90,
      firstIncludedMessageId: "assistant-123",
      lastOwnedMessageId: "assistant-123",
      lastActivityAt: 120,
    });

    await coordinator.trackPersistedRow("turn-123", "tool-result-123", 125);
    expect(store.stamps.at(-1)).toEqual({
      messageId: "tool-result-123",
      sessionId: "session-123",
    });
    expect(
      await coordinator.claimTurn(
        "turn-123",
        { sourceId: "other-source", generation: 99, activation: 1 },
        130,
      ),
    ).toEqual({ id: "session-123", mode: "computer_use" });
    expect(await coordinator.retireSource({ ...handle, generation: 2 })).toBe(
      false,
    );
    expect(await coordinator.retireSource(handle)).toBe(true);
    expect(coordinator.getTurnOwner("turn-123")?.id).toBe("session-123");
  });

  test("starts non-Live display timing at the first assistant row", async () => {
    const store = createDependencies();
    const coordinator = new ConversationModeSessionCoordinator(
      "conv-123",
      store.dependencies,
    );
    const handle = await activateSource(coordinator, store.session());

    await coordinator.trackPersistedRow("turn-123", "user-123", 80, {
      startsDisplayBoundary: false,
    });
    await coordinator.trackPersistedRow("turn-123", "assistant-123", 90);
    await coordinator.claimTurn("turn-123", handle, 120);

    expect(store.stamps).toEqual([
      { messageId: "user-123", sessionId: "session-123" },
      { messageId: "assistant-123", sessionId: "session-123" },
    ]);
    expect(store.session()).toMatchObject({
      firstIncludedAt: 90,
      firstIncludedMessageId: "assistant-123",
      lastOwnedMessageId: "assistant-123",
    });
  });

  test("allows Live display timing to include its leading row", async () => {
    const liveSession = activeSession({ mode: "live_vision" });
    const store = createDependencies(liveSession);
    const coordinator = new ConversationModeSessionCoordinator(
      "conv-123",
      store.dependencies,
    );
    const handle = await activateSource(
      coordinator,
      liveSession,
      "camera-source",
    );

    await coordinator.trackPersistedRow("turn-123", "camera-123", 80, {
      startsDisplayBoundary: false,
    });
    await coordinator.claimTurn("turn-123", handle, 120);

    expect(store.session()).toMatchObject({
      firstIncludedAt: 80,
      firstIncludedMessageId: "camera-123",
      lastOwnedMessageId: "camera-123",
    });
  });

  test("starts Ambient display timing at its first assistant row", async () => {
    const ambientSession = activeSession({ mode: "ambient" });
    const store = createDependencies(ambientSession);
    const coordinator = new ConversationModeSessionCoordinator(
      "conv-123",
      store.dependencies,
    );
    const handle = await activateSource(
      coordinator,
      ambientSession,
      "camera-source",
    );

    await coordinator.trackPersistedRow("turn-123", "camera-123", 80, {
      startsDisplayBoundary: false,
    });
    await coordinator.trackPersistedRow("turn-123", "assistant-123", 90);
    await coordinator.claimTurn("turn-123", handle, 120);

    expect(store.session()).toMatchObject({
      firstIncludedAt: 90,
      firstIncludedMessageId: "assistant-123",
      lastOwnedMessageId: "assistant-123",
    });
  });

  test("inherits only an exact unconsumed structural response", async () => {
    const store = createDependencies();
    const coordinator = new ConversationModeSessionCoordinator(
      "conv-123",
      store.dependencies,
    );
    const handle = await activateSource(coordinator, store.session());
    expect(coordinator.hasResidentWork()).toBe(true);
    await coordinator.acceptTurn("turn-origin");
    await coordinator.claimTurn("turn-origin", handle, 110);
    expect(
      await coordinator.recordStructuralWait("turn-origin", {
        kind: "question",
        responseId: "interaction-123",
      }),
    ).toBe(true);
    expect(coordinator.describeSummary(store.session())?.runtimeState).toBe(
      "waiting",
    );
    await coordinator.releaseTurn("turn-origin", {
      status: "completed",
      endReason: "turn_settled",
    });
    expect(coordinator.hasResidentWork()).toBe(true);
    expect(coordinator.describeSummary(store.session())?.runtimeState).toBe(
      "waiting",
    );

    expect(
      await coordinator.acceptTurn("turn-wrong-kind", {
        kind: "confirmation",
        responseId: "interaction-123",
      }),
    ).toBeUndefined();
    expect(
      await coordinator.acceptTurn("turn-wrong-id", {
        kind: "question",
        responseId: "interaction-456",
      }),
    ).toBeUndefined();
    expect(coordinator.describeSummary(store.session())?.runtimeState).toBe(
      "waiting",
    );
    await coordinator.acceptTurn("turn-independent");
    expect(
      await coordinator.claimTurn("turn-independent", handle, 120),
    ).toEqual({
      id: "session-123",
      mode: "computer_use",
    });
    expect(coordinator.describeSummary(store.session())?.runtimeState).toBe(
      undefined,
    );
    await coordinator.releaseTurn("turn-independent");
    expect(coordinator.describeSummary(store.session())?.runtimeState).toBe(
      "waiting",
    );
    expect(
      await coordinator.acceptTurn("turn-resumed", {
        kind: "question",
        responseId: "interaction-123",
      }),
    ).toEqual({ id: "session-123", mode: "computer_use" });
    expect(coordinator.describeSummary(store.session())?.runtimeState).toBe(
      undefined,
    );
    expect(
      await coordinator.acceptTurn("turn-replayed", {
        kind: "question",
        responseId: "interaction-123",
      }),
    ).toBeUndefined();

    const otherConversation = new ConversationModeSessionCoordinator(
      "conv-456",
      store.dependencies,
    );
    expect(
      await otherConversation.acceptTurn("turn-cross-conversation", {
        kind: "question",
        responseId: "interaction-123",
      }),
    ).toBeUndefined();
  });

  test("preserves a structural response after a failed session lookup for retry and settlement", async () => {
    const store = createDependencies();
    let failLookup = false;
    const coordinator = new ConversationModeSessionCoordinator("conv-123", {
      ...store.dependencies,
      getSession: async (conversationId, sessionId) => {
        if (failLookup) {
          failLookup = false;
          throw new Error("session lookup unavailable");
        }
        return store.dependencies.getSession(conversationId, sessionId);
      },
    });
    const handle = await activateSource(coordinator, store.session());
    await coordinator.claimTurn("turn-origin", handle, 110);
    const response = { kind: "surface", responseId: "surface-123" } as const;
    await coordinator.recordStructuralWait("turn-origin", response);
    await coordinator.releaseTurn("turn-origin", {
      status: "completed",
      endReason: "turn_settled",
    });

    failLookup = true;
    await expect(
      coordinator.acceptTurn("turn-response", response),
    ).rejects.toThrow("session lookup unavailable");
    expect(coordinator.getTurnOwner("turn-response")).toBeUndefined();
    expect(coordinator.describeSummary(store.session())?.runtimeState).toBe(
      "waiting",
    );

    expect(await coordinator.acceptTurn("turn-response", response)).toEqual({
      id: handle.id,
      mode: handle.mode,
    });
    await coordinator.trackPersistedRow("turn-response", "user-response", 120);
    expect(store.stamps).toEqual([
      { messageId: "user-response", sessionId: handle.id },
    ]);
    expect(
      await coordinator.acceptTurn("turn-replayed", response),
    ).toBeUndefined();
    await coordinator.releaseTurn("turn-response", {
      status: "completed",
      endReason: "turn_settled",
    });
    expect(store.session()).toMatchObject({
      status: "completed",
      endReason: "turn_settled",
    });
    expect(coordinator.hasResidentWork()).toBe(false);
  });

  test("normal ask_question answers resume the same owned turn", async () => {
    const { askQuestionTool } =
      await import("../tools/ask-question/ask-question-tool.js");
    const { resolvePendingQuestion } =
      await import("../runtime/question-resolution.js");
    const pendingInteractions =
      await import("../runtime/pending-interactions.js");
    const { setConversation, deleteConversation } =
      await import("./conversation-registry.js");
    const store = createDependencies();
    const coordinator = new ConversationModeSessionCoordinator(
      "conv-123",
      store.dependencies,
    );
    const handle = await activateSource(coordinator, store.session());
    await coordinator.claimTurn("turn-origin", handle, 110);
    const signal = new AbortController();
    setConversation("conv-123", {
      modeSessions: coordinator,
      getTurnOrRestingTrust: () => undefined,
    } as unknown as import("./conversation.js").Conversation);
    try {
      const result = askQuestionTool.execute(
        {
          questions: [
            {
              question: "Which option?",
              options: [
                { id: "a", label: "A" },
                { id: "b", label: "B" },
              ],
            },
          ],
        },
        {
          conversationId: "conv-123",
          toolUseId: "tool-question",
          signal: signal.signal,
          isInteractive: true,
        } as import("../tools/types.js").ToolContext,
      );
      const [question] = pendingInteractions.getByConversation("conv-123");
      expect(question?.kind).toBe("question");
      expect(coordinator.getTurnOwner("turn-origin")?.id).toBe(handle.id);
      expect(
        resolvePendingQuestion(question!.requestId, {
          kind: "submit",
          submissions: [{ questionId: "q1", kind: "option", optionId: "a" }],
        }).status,
      ).toBe("resolved");
      expect((await result).isError).toBe(false);
      expect(pendingInteractions.getByConversation("conv-123")).toEqual([]);
      expect(coordinator.getTurnOwner("turn-origin")?.id).toBe(handle.id);
      expect(coordinator.getTerminalDisposition("turn-origin")).toBeUndefined();
      await coordinator.trackPersistedRow(
        "turn-origin",
        "assistant-answer",
        130,
      );
      expect(
        await coordinator.finalizeTurn({
          turnId: "turn-origin",
          status: "completed",
          endedAt: 140,
          endReason: "turn_settled",
        }),
      ).toBe(true);
      expect(store.stamps).toContainEqual({
        messageId: "assistant-answer",
        sessionId: handle.id,
      });
      expect(coordinator.hasResidentWork()).toBe(false);
    } finally {
      signal.abort();
      deleteConversation("conv-123");
    }
  });

  test("invalidates structural continuation when transcript history changes", async () => {
    const store = createDependencies();
    const coordinator = new ConversationModeSessionCoordinator(
      "conv-123",
      store.dependencies,
    );
    const handle = await activateSource(coordinator, store.session());
    await coordinator.claimTurn("turn-origin", handle, 110);
    await coordinator.recordStructuralWait("turn-origin", {
      kind: "surface",
      responseId: "surface-123",
    });
    await coordinator.releaseTurn("turn-origin");
    expect(coordinator.describeSummary(store.session())?.runtimeState).toBe(
      "waiting",
    );

    expect(await coordinator.invalidateAllStructuralWaits()).toBe(1);
    expect(coordinator.describeSummary(store.session())?.runtimeState).toBe(
      undefined,
    );
    expect(
      await coordinator.acceptTurn("turn-resumed", {
        kind: "surface",
        responseId: "surface-123",
      }),
    ).toBeUndefined();
    expect(await coordinator.invalidateAllStructuralWaits()).toBe(0);
  });

  test.each(["single", "all"] as const)(
    "%s wait invalidation retires abandoned ownership at its last activity",
    async (invalidation) => {
      const store = createDependencies();
      const coordinator = new ConversationModeSessionCoordinator(
        "conv-123",
        store.dependencies,
      );
      const handle = await activateSource(coordinator, store.session());
      await coordinator.claimTurn("turn-origin", handle, 110);
      await coordinator.trackPersistedRow(
        "turn-origin",
        "assistant-final",
        125,
      );
      await coordinator.recordStructuralWait("turn-origin", {
        kind: "surface",
        responseId: "surface-123",
      });
      await coordinator.releaseTurn("turn-origin");

      if (invalidation === "single") {
        expect(
          await coordinator.invalidateStructuralWait({
            kind: "surface",
            responseId: "surface-123",
          }),
        ).toBe(true);
      } else {
        expect(await coordinator.invalidateAllStructuralWaits()).toBe(1);
      }

      expect(store.session()).toMatchObject({
        status: "completed",
        endReason: "structural_wait_abandoned",
        endedAt: 125,
        lastActivityAt: 125,
      });
      expect(coordinator.hasResidentWork()).toBe(false);
      expect(
        await coordinator.claimTurn("turn-late", handle, 140),
      ).toBeUndefined();
      const next = await coordinator.activateSource({
        sourceId: "computer-source",
        generation: 1,
        mode: "computer_use",
        sourceStartedAt: 150,
      });
      expect(next).toMatchObject({ id: "session-created", activation: 2 });
      expect(store.session()).toMatchObject({
        sourceStartedAt: 150,
        lastActivityAt: 150,
        status: "active",
      });
    },
  );

  test("invalidating the final association drains every accepted turn", async () => {
    const store = createDependencies();
    const coordinator = new ConversationModeSessionCoordinator(
      "conv-123",
      store.dependencies,
    );
    const handle = await activateSource(coordinator, store.session());
    await coordinator.claimTurn("turn-origin", handle, 110);
    await coordinator.recordStructuralWait("turn-origin", {
      kind: "surface",
      responseId: "surface-first",
    });
    await coordinator.recordStructuralWait("turn-origin", {
      kind: "surface",
      responseId: "surface-second",
    });
    await coordinator.claimTurn("turn-output", handle, 120);

    await coordinator.invalidateStructuralWait({
      kind: "surface",
      responseId: "surface-first",
    });
    expect(coordinator.describeSummary(store.session())?.runtimeState).toBe(
      "waiting",
    );
    expect(store.session().status).toBe("active");
    await coordinator.invalidateStructuralWait({
      kind: "surface",
      responseId: "surface-second",
    });
    expect(coordinator.describeSummary(store.session())?.runtimeState).toBe(
      "finishing",
    );
    expect(
      await coordinator.claimTurn("turn-late", handle, 130),
    ).toBeUndefined();
    await coordinator.releaseTurn("turn-origin");
    expect(coordinator.hasResidentWork()).toBe(true);
    expect(store.session().status).toBe("active");
    await coordinator.trackPersistedRow(
      "turn-output",
      "assistant-drained",
      140,
    );
    await coordinator.releaseTurn("turn-output");

    expect(store.session()).toMatchObject({
      status: "completed",
      endReason: "structural_wait_abandoned",
      endedAt: 140,
      lastActivityAt: 140,
      lastOwnedMessageId: "assistant-drained",
    });
    expect(store.stamps).toContainEqual({
      messageId: "assistant-drained",
      sessionId: handle.id,
    });
    expect(coordinator.hasResidentWork()).toBe(false);
  });

  test("invalidation preserves a live camera source", async () => {
    const store = createDependencies();
    const coordinator = new ConversationModeSessionCoordinator(
      "conv-123",
      store.dependencies,
    );
    const handle = (await coordinator.activateSource({
      sourceId: "camera-source",
      generation: 1,
      mode: "live_vision",
      sourceStartedAt: 100,
      lifetime: "source",
    }))!;
    await coordinator.claimTurn("camera-run", handle, 110);
    await coordinator.recordStructuralWait("camera-run", {
      kind: "surface",
      responseId: "surface-123",
    });
    await coordinator.invalidateAllStructuralWaits();
    expect(
      coordinator.describeSummary(store.session())?.runtimeState,
    ).toBeUndefined();
    await coordinator.releaseTurn("camera-run");
    expect(store.session().status).toBe("active");
    expect(coordinator.hasResidentWork()).toBe(true);
    expect((await coordinator.claimTurn("camera-frame", handle, 130))?.id).toBe(
      handle.id,
    );
  });

  test("an interruption disposition survives structural cleanup and uses drain completion time", async () => {
    const store = createDependencies();
    const coordinator = new ConversationModeSessionCoordinator(
      "conv-123",
      store.dependencies,
    );
    const handle = await activateSource(coordinator, store.session());
    await coordinator.claimTurn("turn-output", handle, 110);
    await coordinator.recordStructuralWait("turn-output", {
      kind: "surface",
      responseId: "surface-123",
    });
    await coordinator.retireSource(handle, {
      status: "interrupted",
      endReason: "computer_use_stopped",
    });
    await coordinator.invalidateAllStructuralWaits();
    await coordinator.trackPersistedRow(
      "turn-output",
      "assistant-drained",
      140,
    );
    const beforeDrain = Date.now();
    await coordinator.releaseTurn("turn-output");
    expect(store.session()).toMatchObject({
      status: "interrupted",
      endReason: "computer_use_stopped",
    });
    expect(store.session().endedAt).toBeGreaterThanOrEqual(beforeDrain);
    expect(store.session().lastActivityAt).toBe(store.session().endedAt!);
    expect(coordinator.hasResidentWork()).toBe(false);
  });

  test("cancellation while abandoned output drains preserves interruption", async () => {
    const store = createDependencies();
    const coordinator = new ConversationModeSessionCoordinator(
      "conv-123",
      store.dependencies,
    );
    const handle = await activateSource(coordinator, store.session());
    await coordinator.claimTurn("turn-origin", handle, 110);
    await coordinator.recordStructuralWait("turn-origin", {
      kind: "surface",
      responseId: "surface-123",
    });
    await coordinator.claimTurn("turn-output", handle, 120);
    await coordinator.invalidateAllStructuralWaits();
    await coordinator.releaseTurn("turn-origin", {
      status: "interrupted",
      endReason: "turn_cancelled",
    });
    expect(coordinator.getTerminalDisposition("turn-output")).toEqual({
      status: "interrupted",
      endReason: "turn_cancelled",
    });
    await coordinator.releaseTurn("turn-output", {
      status: "completed",
      endReason: "turn_settled",
    });
    expect(store.session()).toMatchObject({
      status: "interrupted",
      endReason: "turn_cancelled",
    });
    expect(coordinator.hasResidentWork()).toBe(false);
  });

  test.each(["stale_revision", "terminal", "not_found"] as const)(
    "releases retired residency after %s without announcing a successful write",
    async (reason) => {
      const store = createDependencies();
      let finalizations = 0;
      const coordinator = new ConversationModeSessionCoordinator("conv-123", {
        ...store.dependencies,
        finalize: async () => {
          finalizations += 1;
          if (reason === "not_found") {
            return { ok: false, reason };
          }
          const session =
            reason === "terminal"
              ? activeSession({
                  status: "interrupted",
                  endedAt: null,
                  endReason: "assistant_restarted",
                  revision: store.session().revision + 1,
                })
              : { ...store.session(), revision: store.session().revision + 1 };
          store.replaceSession(session);
          return { ok: false, reason, session };
        },
      });
      const handle = await activateSource(coordinator, store.session());
      await coordinator.claimTurn("turn-output", handle, 110);
      await coordinator.recordStructuralWait("turn-output", {
        kind: "surface",
        responseId: "surface-123",
      });
      await coordinator.invalidateAllStructuralWaits();
      expect(coordinator.hasResidentWork()).toBe(true);
      const publications = store.publications();
      await coordinator.releaseTurn("turn-output");

      expect(finalizations).toBe(reason === "stale_revision" ? 2 : 1);
      expect(coordinator.hasResidentWork()).toBe(false);
      expect(store.publications()).toBe(publications + 1);
      expect(
        await coordinator.claimTurn("turn-late", handle, 130),
      ).toBeUndefined();
      if (reason === "terminal") {
        expect(coordinator.describeSummary(store.session())).toEqual({
          summary: store.session(),
        });
        expect(store.session().status).toBe("interrupted");
      } else {
        expect(coordinator.describeSummary(store.session())).toBeUndefined();
        if (reason === "stale_revision") {
          expect(store.session().status).toBe("active");
          expect(coordinator.describeSummary(store.session())).toBeUndefined();
        }
      }
    },
  );

  test.each([false, true])(
    "failed retirement invalidates a mounted descriptor (notification throws=%s)",
    async (notificationThrows) => {
      const store = createDependencies();
      const dependencies = {
        ...store.dependencies,
        finalize: async () => {
          throw new Error("session store unavailable");
        },
      };
      const coordinator = new ConversationModeSessionCoordinator(
        "conv-123",
        dependencies,
      );
      const handle = await activateSource(coordinator, store.session());
      await coordinator.claimTurn("turn-output", handle, 110);
      await coordinator.recordStructuralWait("turn-output", {
        kind: "surface",
        responseId: "surface-123",
      });
      await coordinator.invalidateAllStructuralWaits();
      expect(coordinator.describeSummary(store.session())?.runtimeState).toBe(
        "finishing",
      );
      let invalidations = 0;
      let refreshedDescriptor = coordinator.describeSummary(store.session());
      dependencies.publishMessagesChanged = () => {
        invalidations += 1;
        refreshedDescriptor = coordinator.describeSummary(store.session());
        if (notificationThrows) {
          throw new Error("notification unavailable");
        }
      };
      await expect(coordinator.releaseTurn("turn-output")).rejects.toThrow(
        "session store unavailable",
      );
      expect(invalidations).toBe(1);
      expect(refreshedDescriptor).toBeUndefined();
      expect(coordinator.hasResidentWork()).toBe(false);
      expect(store.session()).toMatchObject({
        status: "active",
        endedAt: null,
        endReason: null,
      });
    },
  );

  test("completes a released structural owner when its response has no follow-up turn", async () => {
    const store = createDependencies();
    const coordinator = new ConversationModeSessionCoordinator(
      "conv-123",
      store.dependencies,
    );
    const handle = await activateSource(coordinator, store.session());
    await coordinator.claimTurn("turn-origin", handle, 110);
    await coordinator.recordStructuralWait("turn-origin", {
      kind: "surface",
      responseId: "surface-launcher",
    });
    await coordinator.releaseTurn("turn-origin");

    expect(
      await coordinator.settleStructuralWait(
        { kind: "surface", responseId: "surface-launcher" },
        { status: "completed", endReason: "surface_launch_settled" },
      ),
    ).toBe(true);

    expect(coordinator.describeSummary(store.session())).toEqual({
      summary: expect.objectContaining({
        status: "completed",
        endReason: "surface_launch_settled",
      }),
    });
    expect(coordinator.hasResidentWork()).toBe(false);
    expect(
      await coordinator.claimTurn("turn-late", handle, 120),
    ).toBeUndefined();
  });

  test("drains accepted work before completing a structural owner", async () => {
    const store = createDependencies();
    const coordinator = new ConversationModeSessionCoordinator(
      "conv-123",
      store.dependencies,
    );
    const handle = await activateSource(coordinator, store.session());
    await coordinator.claimTurn("turn-origin", handle, 110);
    await coordinator.recordStructuralWait("turn-origin", {
      kind: "surface",
      responseId: "surface-launcher",
    });
    await coordinator.releaseTurn("turn-origin");
    await coordinator.claimTurn("turn-accepted", handle, 120);

    await coordinator.settleStructuralWait(
      { kind: "surface", responseId: "surface-launcher" },
      { status: "completed", endReason: "surface_launch_settled" },
    );

    expect(coordinator.getTerminalDisposition("turn-accepted")).toEqual({
      status: "completed",
      endReason: "surface_launch_settled",
    });
    expect(coordinator.describeSummary(store.session())).toEqual({
      summary: expect.objectContaining({ status: "active" }),
      runtimeState: "finishing",
    });
    expect(
      await coordinator.claimTurn("turn-late", handle, 130),
    ).toBeUndefined();

    await coordinator.releaseTurn("turn-accepted");
    expect(coordinator.describeSummary(store.session())).toEqual({
      summary: expect.objectContaining({
        status: "completed",
        endReason: "surface_launch_settled",
      }),
    });
    expect(coordinator.hasResidentWork()).toBe(false);
  });

  test("keeps a source-lifetime owner active after settling an incidental surface wait", async () => {
    const ambientSession = activeSession({ mode: "ambient" });
    const store = createDependencies(ambientSession);
    const coordinator = new ConversationModeSessionCoordinator(
      "conv-123",
      store.dependencies,
    );
    const handle = await coordinator.activateSource({
      sourceId: "camera-source",
      generation: 1,
      mode: "ambient",
      sourceStartedAt: 100,
      lifetime: "source",
    });
    expect(handle).toBeDefined();
    await coordinator.claimTurn("turn-origin", handle!, 110);
    await coordinator.recordStructuralWait("turn-origin", {
      kind: "surface",
      responseId: "surface-launcher",
    });
    await coordinator.releaseTurn("turn-origin");

    await coordinator.settleStructuralWait(
      { kind: "surface", responseId: "surface-launcher" },
      { status: "completed", endReason: "surface_launch_settled" },
    );

    expect(coordinator.describeSummary(store.session())).toEqual({
      summary: expect.objectContaining({ status: "active", mode: "ambient" }),
    });
    expect(coordinator.hasResidentWork()).toBe(true);
    expect(await coordinator.claimTurn("turn-later", handle!, 120)).toEqual({
      id: handle!.id,
      mode: "ambient",
    });
    await coordinator.releaseTurn("turn-later", {
      status: "completed",
      endReason: "turn_settled",
    });
    expect(coordinator.describeSummary(store.session())).toEqual({
      summary: expect.objectContaining({ status: "active", mode: "ambient" }),
    });
    expect(coordinator.hasResidentWork()).toBe(true);
  });

  test("drops turn-scoped residency when fallback finalization throws", async () => {
    const store = createDependencies();
    const coordinator = new ConversationModeSessionCoordinator("conv-123", {
      ...store.dependencies,
      finalize: async () => {
        throw new Error("session store unavailable");
      },
    });
    const handle = await activateSource(coordinator, store.session());
    await coordinator.claimTurn("turn-123", handle, 110);

    await expect(
      coordinator.releaseTurn("turn-123", {
        status: "completed",
        endReason: "turn_settled",
      }),
    ).rejects.toThrow("session store unavailable");

    expect(coordinator.hasResidentWork()).toBe(false);
    expect(
      await coordinator.claimTurn("turn-late", handle, 120),
    ).toBeUndefined();
  });

  test("drops launcher residency when structural settlement persistence throws", async () => {
    const store = createDependencies();
    const coordinator = new ConversationModeSessionCoordinator("conv-123", {
      ...store.dependencies,
      finalize: async () => {
        throw new Error("session store unavailable");
      },
    });
    const handle = await activateSource(coordinator, store.session());
    await coordinator.claimTurn("turn-origin", handle, 110);
    await coordinator.recordStructuralWait("turn-origin", {
      kind: "surface",
      responseId: "surface-launcher",
    });
    await coordinator.releaseTurn("turn-origin");

    await expect(
      coordinator.settleStructuralWait(
        { kind: "surface", responseId: "surface-launcher" },
        { status: "completed", endReason: "surface_launch_settled" },
      ),
    ).rejects.toThrow("session store unavailable");

    expect(coordinator.hasResidentWork()).toBe(false);
    expect(
      await coordinator.claimTurn("turn-late", handle, 120),
    ).toBeUndefined();
  });

  test("does not inherit recovered terminal state", async () => {
    const store = createDependencies();
    const coordinator = new ConversationModeSessionCoordinator(
      "conv-123",
      store.dependencies,
    );
    const handle = await activateSource(coordinator, store.session());
    await coordinator.acceptTurn("turn-origin");
    await coordinator.claimTurn("turn-origin", handle, 110);
    await coordinator.recordStructuralWait("turn-origin", {
      kind: "question",
      responseId: "interaction-123",
    });
    await coordinator.releaseTurn("turn-origin");
    expect(coordinator.describeSummary(store.session())?.runtimeState).toBe(
      "waiting",
    );
    store.replaceSession(
      activeSession({
        status: "interrupted",
        endedAt: null,
        endReason: "assistant_restarted",
        revision: 4,
      }),
    );

    expect(
      await coordinator.acceptTurn("turn-after-restart", {
        kind: "question",
        responseId: "interaction-123",
      }),
    ).toBeUndefined();
    expect(coordinator.describeSummary(store.session())).toEqual({
      summary: store.session(),
    });
  });

  test("clears a released structural wait when its source retires", async () => {
    const store = createDependencies();
    const coordinator = new ConversationModeSessionCoordinator(
      "conv-123",
      store.dependencies,
    );
    const handle = await activateSource(coordinator, store.session());
    await coordinator.claimTurn("turn-origin", handle, 110);
    await coordinator.recordStructuralWait("turn-origin", {
      kind: "confirmation",
      responseId: "confirmation-123",
    });
    await coordinator.releaseTurn("turn-origin");
    expect(coordinator.describeSummary(store.session())?.runtimeState).toBe(
      "waiting",
    );

    expect(
      await coordinator.retireSource(handle, {
        status: "interrupted",
        endReason: "computer_use_stopped",
      }),
    ).toBe(true);
    expect(coordinator.describeSummary(store.session())).toEqual({
      summary: expect.objectContaining({
        status: "interrupted",
        endReason: "computer_use_stopped",
      }),
    });
  });

  test("reconciles one stale revision without moving the first boundary", async () => {
    const store = createDependencies(
      activeSession({
        firstIncludedAt: 80,
        firstIncludedMessageId: "assistant-earliest",
        lastOwnedMessageId: "assistant-earliest",
        revision: 3,
      }),
    );
    const coordinator = new ConversationModeSessionCoordinator(
      "conv-123",
      store.dependencies,
    );
    const handle = await activateSource(
      coordinator,
      store.session(),
      "browser-source",
      7,
    );
    await coordinator.acceptTurn("turn-123");
    await coordinator.trackPersistedRow("turn-123", "assistant-later", 90);
    store.forceStale();
    expect(await coordinator.claimTurn("turn-123", handle, 120)).toEqual({
      id: "session-123",
      mode: "computer_use",
    });
    expect(store.session()).toMatchObject({
      firstIncludedAt: 80,
      firstIncludedMessageId: "assistant-earliest",
      lastOwnedMessageId: "assistant-later",
      lastActivityAt: 120,
    });
  });

  test("keeps ownership while draining and removes runtime hints at terminal", async () => {
    const store = createDependencies();
    const coordinator = new ConversationModeSessionCoordinator(
      "conv-123",
      store.dependencies,
    );
    const handle = await activateSource(coordinator, store.session());
    await coordinator.acceptTurn("turn-123");
    await coordinator.trackPersistedRow("turn-123", "assistant-123", 110);
    await coordinator.claimTurn("turn-123", handle, 120);
    await coordinator.retireSource(handle);
    expect(await coordinator.beginDraining("turn-123")).toBe(true);
    expect(coordinator.describeSummary(store.session())?.runtimeState).toBe(
      "finishing",
    );
    await coordinator.trackPersistedRow("turn-123", "assistant-final", 130);
    expect(coordinator.getTurnOwner("turn-123")?.id).toBe("session-123");

    expect(
      await coordinator.finalizeTurn({
        turnId: "turn-123",
        status: "completed",
        endedAt: 140,
        endReason: "settled",
        lastActivityAt: 130,
      }),
    ).toBe(true);
    expect(coordinator.hasResidentWork()).toBe(false);
    expect(coordinator.getTurnOwner("turn-123")).toBeUndefined();
    expect(coordinator.describeSummary(store.session())).toEqual({
      summary: expect.objectContaining({
        status: "completed",
        endedAt: 140,
        lastOwnedMessageId: "assistant-final",
      }),
    });
    const nextHandle = await coordinator.activateSource({
      sourceId: "computer-source",
      generation: 1,
      mode: "computer_use",
      sourceStartedAt: 150,
    });
    expect(nextHandle).toMatchObject({
      id: "session-created",
      generation: 1,
      activation: 2,
    });
    await coordinator.acceptTurn("turn-stale-callback");
    expect(
      await coordinator.claimTurn("turn-stale-callback", handle, 160),
    ).toBeUndefined();
    await coordinator.acceptTurn("turn-next");
    expect(
      await coordinator.claimTurn("turn-next", nextHandle!, 160),
    ).toMatchObject({
      id: "session-created",
    });
    expect(store.publications()).toBeGreaterThan(0);
  });

  test("retries an earlier failed metadata stamp when a later row persists", async () => {
    const store = createDependencies();
    const coordinator = new ConversationModeSessionCoordinator(
      "conv-123",
      store.dependencies,
    );
    const handle = await activateSource(coordinator, store.session());
    await coordinator.acceptTurn("turn-123");
    await coordinator.trackPersistedRow("turn-123", "assistant-123", 90);
    store.failStamp("tool-result-123");
    await coordinator.claimTurn("turn-123", handle, 110);
    await coordinator.trackPersistedRow("turn-123", "tool-result-123", 120);

    expect(store.session()).toMatchObject({
      firstIncludedMessageId: "assistant-123",
      lastActivityAt: 110,
      lastOwnedMessageId: "assistant-123",
    });
    store.allowStamp("tool-result-123");
    await coordinator.trackPersistedRow("turn-123", "assistant-456", 130);
    expect(store.session()).toMatchObject({
      firstIncludedMessageId: "assistant-123",
      lastOwnedMessageId: "assistant-456",
    });
    expect(store.stamps).toEqual([
      { messageId: "assistant-123", sessionId: "session-123" },
      { messageId: "tool-result-123", sessionId: "session-123" },
      { messageId: "assistant-456", sessionId: "session-123" },
    ]);
  });

  test("retries a failed metadata stamp before releasing turn state", async () => {
    const store = createDependencies();
    const coordinator = new ConversationModeSessionCoordinator(
      "conv-123",
      store.dependencies,
    );
    const handle = await activateSource(coordinator, store.session());
    await coordinator.claimTurn("turn-123", handle, 110);
    store.failStamp("assistant-123");
    await coordinator.trackPersistedRow("turn-123", "assistant-123", 120);

    store.allowStamp("assistant-123");
    await coordinator.releaseTurn("turn-123");

    expect(store.stamps).toEqual([
      { messageId: "assistant-123", sessionId: "session-123" },
    ]);
    expect(store.session()).toMatchObject({
      firstIncludedMessageId: "assistant-123",
      lastActivityAt: 120,
      lastOwnedMessageId: "assistant-123",
    });
  });

  test("retries a failed final row before terminal persistence", async () => {
    const store = createDependencies();
    const coordinator = new ConversationModeSessionCoordinator(
      "conv-123",
      store.dependencies,
    );
    const handle = await activateSource(coordinator, store.session());
    await coordinator.claimTurn("turn-123", handle, 110);
    store.failStamp("assistant-123");
    await coordinator.trackPersistedRow("turn-123", "assistant-123", 120);

    store.allowStamp("assistant-123");
    expect(
      await coordinator.finalizeTurn({
        turnId: "turn-123",
        status: "completed",
        endedAt: 130,
        endReason: "completed",
      }),
    ).toBe(true);

    expect(store.stamps).toEqual([
      { messageId: "assistant-123", sessionId: "session-123" },
    ]);
    expect(store.session()).toMatchObject({
      status: "completed",
      lastActivityAt: 120,
      lastOwnedMessageId: "assistant-123",
    });
  });

  test("waits for every source-lifetime turn before terminal persistence", async () => {
    const store = createDependencies();
    const coordinator = new ConversationModeSessionCoordinator(
      "conv-123",
      store.dependencies,
    );
    const handle = await coordinator.activateSource({
      sourceId: "camera-source",
      generation: 1,
      mode: "live_vision",
      sourceStartedAt: 100,
      lifetime: "source",
    });
    expect(handle).toBeDefined();
    await coordinator.acceptTurn("camera-run");
    await coordinator.claimTurn("camera-run", handle!, 100);
    await coordinator.acceptTurn("voice-turn");
    await coordinator.claimTurn("voice-turn", handle!, 110);
    await coordinator.trackPersistedRow("voice-turn", "assistant-123", 120);
    expect(coordinator.keepsSessionOpenAfterTurn("voice-turn")).toBe(true);

    expect(
      await coordinator.retireSource(handle!, {
        status: "interrupted",
        endReason: "camera_lost",
      }),
    ).toBe(true);
    expect(coordinator.getTerminalDisposition("voice-turn")).toEqual({
      status: "interrupted",
      endReason: "camera_lost",
    });
    await coordinator.releaseTurn("voice-turn");
    expect(store.session().status).toBe("active");

    await coordinator.releaseTurn("camera-run");
    expect(store.session()).toMatchObject({
      status: "interrupted",
      endReason: "camera_lost",
      lastOwnedMessageId: "assistant-123",
    });
  });

  test("transfers a handoff owner without reopening source eligibility", async () => {
    const store = createDependencies();
    const coordinator = new ConversationModeSessionCoordinator(
      "conv-123",
      store.dependencies,
    );
    const handle = await activateSource(coordinator, store.session());
    await coordinator.acceptTurn("turn-123");
    await coordinator.claimTurn("turn-123", handle, 110);
    await coordinator.trackPersistedRow("turn-123", "assistant-123", 120);

    expect(await coordinator.transferTurn("turn-123", "turn-456")).toEqual({
      id: "session-123",
      mode: "computer_use",
    });
    expect(coordinator.getTurnOwner("turn-123")).toBeUndefined();
    expect(coordinator.getTurnOwner("turn-456")).toEqual({
      id: "session-123",
      mode: "computer_use",
    });
    await coordinator.trackPersistedRow("turn-456", "assistant-456", 130);
    expect(store.session()).toMatchObject({
      firstIncludedMessageId: "assistant-123",
      lastOwnedMessageId: "assistant-456",
    });
  });

  test("repairs tracked rows before a handoff discards their turn state", async () => {
    const store = createDependencies();
    const coordinator = new ConversationModeSessionCoordinator(
      "conv-123",
      store.dependencies,
    );
    const handle = await activateSource(coordinator, store.session());
    await coordinator.claimTurn("turn-123", handle, 110);
    store.failStamp("assistant-123");
    await coordinator.trackPersistedRow("turn-123", "assistant-123", 120);

    store.allowStamp("assistant-123");
    await coordinator.transferTurn("turn-123", "turn-456");

    expect(store.stamps).toEqual([
      { messageId: "assistant-123", sessionId: "session-123" },
    ]);
    expect(store.session()).toMatchObject({
      firstIncludedMessageId: "assistant-123",
      lastOwnedMessageId: "assistant-123",
    });
  });

  test.each([false, true])(
    "hands ownership to an accepted destination without losing rows (matched wait=%s)",
    async (matchedWait) => {
      const store = createDependencies();
      const coordinator = new ConversationModeSessionCoordinator(
        "conv-123",
        store.dependencies,
      );
      const handle = await activateSource(coordinator, store.session());
      await coordinator.claimTurn("turn-origin", handle, 110);
      await coordinator.trackPersistedRow(
        "turn-origin",
        "assistant-origin",
        120,
      );
      if (matchedWait) {
        await coordinator.recordStructuralWait("turn-origin", {
          kind: "surface",
          responseId: "surface-123",
        });
      }
      await coordinator.acceptTurn("turn-queued", {
        kind: "surface",
        responseId: "surface-123",
      });
      await coordinator.trackPersistedRow("turn-queued", "user-queued", 130, {
        startsDisplayBoundary: false,
      });

      expect(
        await coordinator.transferTurn("turn-origin", "turn-queued"),
      ).toEqual({
        id: "session-123",
        mode: "computer_use",
      });
      expect(coordinator.getTurnOwner("turn-origin")).toBeUndefined();
      await coordinator.trackPersistedRow(
        "turn-queued",
        "assistant-queued",
        140,
      );
      await coordinator.releaseTurn("turn-queued", {
        status: "completed",
        endReason: "turn_settled",
      });

      expect(store.stamps).toEqual([
        { messageId: "assistant-origin", sessionId: "session-123" },
        { messageId: "user-queued", sessionId: "session-123" },
        { messageId: "assistant-queued", sessionId: "session-123" },
      ]);
      expect(store.session()).toMatchObject({
        status: "completed",
        firstIncludedMessageId: "assistant-origin",
        lastOwnedMessageId: "assistant-queued",
      });
      expect(coordinator.hasResidentWork()).toBe(false);
    },
  );

  test("preserves a retired source disposition through an accepted destination", async () => {
    const store = createDependencies();
    const coordinator = new ConversationModeSessionCoordinator(
      "conv-123",
      store.dependencies,
    );
    const source = await activateSource(coordinator, store.session());
    await coordinator.claimTurn("turn-origin", source, 110);
    await coordinator.acceptTurn("turn-queued");
    await coordinator.retireSource(source, {
      status: "interrupted",
      endReason: "browser_cancelled",
    });

    await coordinator.transferTurn("turn-origin", "turn-queued");

    expect(coordinator.getTurnOwner("turn-origin")).toBeUndefined();
    expect(coordinator.getTerminalDisposition("turn-queued")).toEqual({
      status: "interrupted",
      endReason: "browser_cancelled",
    });
    expect(coordinator.describeSummary(store.session())?.runtimeState).toBe(
      "finishing",
    );
    expect(
      await coordinator.claimTurn("turn-late", source, 120),
    ).toBeUndefined();
    await coordinator.releaseTurn("turn-queued");
    expect(store.session()).toMatchObject({
      status: "interrupted",
      endReason: "browser_cancelled",
    });
    expect(coordinator.hasResidentWork()).toBe(false);
  });

  test.each(["origin", "destination"] as const)(
    "completes a handoff when %s row boundary repair throws",
    async (failedRepair) => {
      const store = createDependencies();
      const coordinator = new ConversationModeSessionCoordinator(
        "conv-123",
        store.dependencies,
      );
      const source = await activateSource(coordinator, store.session());
      await coordinator.claimTurn("turn-origin", source, 110);
      store.failStamp("assistant-origin");
      await coordinator.trackPersistedRow(
        "turn-origin",
        "assistant-origin",
        120,
      );
      await coordinator.acceptTurn("turn-queued");
      await coordinator.trackPersistedRow(
        "turn-queued",
        "assistant-destination",
        130,
      );
      store.allowStamp("assistant-origin");
      const updateBoundaries = store.dependencies.updateBoundaries;
      let failures = 0;
      store.dependencies.updateBoundaries = (input) => {
        if (input.lastOwnedMessageId === `assistant-${failedRepair}`) {
          failures += 1;
          throw new Error("session boundaries unavailable");
        }
        return updateBoundaries(input);
      };

      expect(
        await coordinator.transferTurn("turn-origin", "turn-queued"),
      ).toEqual({
        id: "session-123",
        mode: "computer_use",
      });

      expect(failures).toBe(1);
      expect(coordinator.getTurnOwner("turn-origin")).toBeUndefined();
      expect(store.stamps).toEqual([
        { messageId: "assistant-origin", sessionId: "session-123" },
        { messageId: "assistant-destination", sessionId: "session-123" },
      ]);
      store.dependencies.updateBoundaries = updateBoundaries;
      await coordinator.releaseTurn("turn-queued", {
        status: "completed",
        endReason: "turn_settled",
      });
      expect(store.session().status).toBe("completed");
      expect(coordinator.hasResidentWork()).toBe(false);
    },
  );

  test("preserves a distinct destination owner and settles the origin", async () => {
    const origin = createDependencies(activeSession({ id: "session-origin" }));
    const destination = createDependencies(
      activeSession({ id: "session-destination", mode: "browser" }),
    );
    const stores = [origin, destination];
    let nextId = 0;
    const dependenciesFor = (id: string) =>
      stores.find((store) => store.session().id === id)!.dependencies;
    const coordinator = new ConversationModeSessionCoordinator("conv-123", {
      createId: () => stores[nextId++]!.session().id,
      beginSession: async (input) =>
        dependenciesFor(input.id).beginSession(input),
      getSession: async (conversationId, id) =>
        dependenciesFor(id).getSession(conversationId, id),
      updateActivity: async (input) =>
        dependenciesFor(input.id).updateActivity(input),
      updateBoundaries: async (input) =>
        dependenciesFor(input.id).updateBoundaries(input),
      advanceRevision: async (input) =>
        dependenciesFor(input.id).advanceRevision(input),
      finalize: async (input) => dependenciesFor(input.id).finalize(input),
      stampMessage: async (messageId, owner) =>
        dependenciesFor(owner.id).stampMessage(messageId, owner),
      publishMessagesChanged: () => {},
    });
    const originSource = await activateSource(
      coordinator,
      origin.session(),
      "origin-source",
    );
    await coordinator.claimTurn("turn-origin", originSource, 110);
    await coordinator.trackPersistedRow("turn-origin", "assistant-origin", 120);
    const destinationSource = await activateSource(
      coordinator,
      destination.session(),
      "destination-source",
    );
    await coordinator.claimTurn("turn-queued", destinationSource, 130);
    await coordinator.trackPersistedRow("turn-queued", "assistant-queued", 140);
    const destinationBeforeHandoff = destination.session();

    expect(
      await coordinator.transferTurn("turn-origin", "turn-queued"),
    ).toEqual({
      id: "session-destination",
      mode: "browser",
    });

    expect(coordinator.getTurnOwner("turn-origin")).toBeUndefined();
    expect(origin.session()).toMatchObject({
      status: "completed",
      endReason: "handoff_settled",
      lastOwnedMessageId: "assistant-origin",
    });
    expect(destination.session()).toEqual(destinationBeforeHandoff);
    expect(origin.stamps).toEqual([
      { messageId: "assistant-origin", sessionId: "session-origin" },
    ]);
    expect(destination.stamps).toEqual([
      { messageId: "assistant-queued", sessionId: "session-destination" },
    ]);
    await coordinator.releaseTurn("turn-queued", {
      status: "completed",
      endReason: "turn_settled",
    });
    expect(coordinator.hasResidentWork()).toBe(false);
  });
});
