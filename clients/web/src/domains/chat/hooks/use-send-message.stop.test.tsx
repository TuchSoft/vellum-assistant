/**
 * Stop wiring for `useSendMessage`.
 *
 * Drives the hook against a spied daemon client so the assertions are on the
 * actual request the generated SDK sends: the stop mode in the body, the
 * global stop's fixed `hard` mode, the toast counts, and the authoritative
 * refetch after a cancel the daemon did not apply.
 */
import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import { act, cleanup, renderHook } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { MemoryRouter } from "react-router";
import type { ReactNode } from "react";

import { client as daemonClient } from "@/generated/daemon/client.gen";
import { useConversationStore } from "@/stores/conversation-store";
import { useTurnStore, INITIAL_TURN_STATE } from "@/domains/chat/turn-store";
import { useChatSessionStore } from "@/domains/chat/chat-session-store";

const toastSuccess = mock((_message: string) => {});
const toastWarning = mock((_message: string) => {});
const toastError = mock((_message: string) => {});

const realToast = await import("@vellumai/design-library/components/toast");
mock.module("@vellumai/design-library/components/toast", () => ({
  ...realToast,
  toast: {
    success: toastSuccess,
    warning: toastWarning,
    error: toastError,
  },
}));

const { useSendMessage } =
  await import("@/domains/chat/hooks/use-send-message");

const ASSISTANT_ID = "assistant-1";
const CONVERSATION_ID = "conv-1";

interface PostCall {
  url: string;
  body?: unknown;
}

let postCalls: PostCall[] = [];
let postResponse: (call: PostCall) => unknown;
let refreshConversations: ReturnType<typeof mock>;
const originalPost = daemonClient.post;
const originalGet = daemonClient.get;

const queryClient = new QueryClient();

function Wrapper({ children }: { children: ReactNode }) {
  return (
    <MemoryRouter>
      <QueryClientProvider client={queryClient}>{children}</QueryClientProvider>
    </MemoryRouter>
  );
}

function baseProps() {
  return {
    assistantId: ASSISTANT_ID,
    activeConversationId: CONVERSATION_ID,
    diskPressureChatBlockReason: null,
    uiContextRef: { current: null },
    pendingOnboardingContextRef: { current: null },
    onboardingDraftConversationIdRef: { current: null },
    startReconciliationLoop: () => {},
    cancelReconciliation: () => {},
    refreshConversations,
  };
}

function renderStopHook() {
  return renderHook(() => useSendMessage(baseProps()), { wrapper: Wrapper });
}

beforeEach(() => {
  postCalls = [];
  toastSuccess.mockClear();
  toastWarning.mockClear();
  toastError.mockClear();
  refreshConversations = mock(async () => {});
  queryClient.clear();
  useConversationStore.getState().reset();
  useTurnStore.setState(INITIAL_TURN_STATE);
  useChatSessionStore.getState().setOptimisticSends([]);
  useChatSessionStore.getState().setError(null);

  postResponse = () => ({
    data: { ok: true, cancelled: true, conversationId: CONVERSATION_ID },
    error: null,
    response: new Response(null, { status: 202 }),
  });

  daemonClient.post = mock(async (options: { url: string; body?: unknown }) => {
    const call = { url: options.url, body: options.body };
    postCalls.push(call);
    return postResponse(call);
  }) as typeof daemonClient.post;

  // The authoritative refetch after `cancelled: false` is allowed to fail:
  // the list refetch is what this test asserts, and the detail read is
  // best-effort by design.
  daemonClient.get = mock(async () => ({
    data: null,
    error: new Error("no detail"),
    response: new Response(null, { status: 500 }),
  })) as typeof daemonClient.get;
});

afterEach(() => {
  daemonClient.post = originalPost;
  daemonClient.get = originalGet;
  cleanup();
});

describe("useSendMessage stop modes", () => {
  test("the primary stop sends hard", async () => {
    const { result } = renderStopHook();

    await act(async () => {
      await result.current.handleStopGenerating();
    });

    expect(postCalls).toHaveLength(1);
    expect(postCalls[0]?.url).toContain(
      "/v1/assistants/{assistant_id}/conversations/{id}/cancel",
    );
    expect(postCalls[0]?.body).toEqual({ mode: "hard" });
  });

  test("graceful and main-only ride in the request body", async () => {
    const { result } = renderStopHook();

    for (const mode of ["graceful", "main-only"] as const) {
      postCalls = [];
      await act(async () => {
        await result.current.handleStopGenerating(mode);
      });
      expect(postCalls[0]?.body).toEqual({ mode });
    }
  });

  test("cancelled: false restores the authoritative conversation state", async () => {
    postResponse = () => ({
      data: { ok: true, cancelled: false, conversationId: CONVERSATION_ID },
      error: null,
      response: new Response(null, { status: 202 }),
    });
    const { result } = renderStopHook();

    await act(async () => {
      await result.current.handleStopGenerating("hard");
    });

    expect(refreshConversations).toHaveBeenCalledTimes(1);
  });

  test("cancelled: true does not refetch", async () => {
    const { result } = renderStopHook();

    await act(async () => {
      await result.current.handleStopGenerating("hard");
    });

    expect(refreshConversations).not.toHaveBeenCalled();
  });

  test("stop-all sends hard and toasts the per-category counts", async () => {
    postResponse = () => ({
      data: {
        conversations: 2,
        subagents: 1,
        acpSessions: 1,
        backgroundTools: 1,
        scheduleRuns: 1,
        workflowRuns: 1,
        heartbeatRuns: 1,
        memoryJobs: 0,
        unsupported: [],
      },
      error: null,
      response: new Response(null, { status: 200 }),
    });
    const { result } = renderStopHook();

    await act(async () => {
      await result.current.handleStopAll();
    });

    expect(postCalls[0]?.url).toContain(
      "/v1/assistants/{assistant_id}/lifecycle/stop-all",
    );
    expect(postCalls[0]?.body).toEqual({ mode: "hard" });
    expect(toastSuccess).toHaveBeenCalledTimes(1);
    expect(toastSuccess.mock.calls[0]?.[0]).toContain("2 conversations");
    expect(toastWarning).not.toHaveBeenCalled();
    expect(refreshConversations).toHaveBeenCalledTimes(1);
  });

  test("stop-all warns when memory jobs were left running", async () => {
    postResponse = () => ({
      data: {
        conversations: 0,
        subagents: 0,
        acpSessions: 0,
        backgroundTools: 0,
        scheduleRuns: 0,
        workflowRuns: 0,
        heartbeatRuns: 0,
        memoryJobs: 0,
        unsupported: ["memoryJobs"],
      },
      error: null,
      response: new Response(null, { status: 200 }),
    });
    const { result } = renderStopHook();

    await act(async () => {
      await result.current.handleStopAll();
    });

    expect(toastWarning).toHaveBeenCalledWith("Memory jobs were not stopped.");
  });

  test("a failed stop-all reports an error and leaves the UI alone", async () => {
    postResponse = () => {
      throw new Error("network down");
    };
    const { result } = renderStopHook();

    await act(async () => {
      await result.current.handleStopAll();
    });

    expect(toastError).toHaveBeenCalledWith(
      "Couldn't stop all work. Try again.",
    );
    expect(toastSuccess).not.toHaveBeenCalled();
    expect(refreshConversations).not.toHaveBeenCalled();
  });
});
