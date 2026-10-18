/**
 * Regression test: POST /v1/conversations/:id/cancel must resolve the
 * conversation key to the internal conversation ID before calling
 * cancelGeneration(). Without resolveConversationId(), the cancel
 * endpoint receives the client's local conversation key (which differs
 * from the daemon's internal ID), fails to find the conversation, and
 * silently ignores the cancel — leaving the stream running.
 */
import { expect, mock, setDefaultTimeout, test } from "bun:test";

mock.module("../config/env.js", () => ({ isHttpAuthDisabled: () => true }));

let cancelledId: string | undefined;
let cancelledMode: string | undefined;
mock.module("../daemon/handlers/conversations.js", () => ({
  cancelGeneration: (id: string, mode = "hard") => {
    cancelledId = id;
    cancelledMode = mode;
    return true;
  },
  switchConversation: async () => null,
  clearAllConversations: async () => 0,
  undoLastMessage: async () => null,
}));

import { getOrCreateConversation } from "../persistence/conversation-key-store.js";
import { ROUTES } from "../runtime/routes/conversation-management-routes.js";
import { routeDefinitionsToHTTPRoutes } from "../runtime/routes/http-adapter.js";
import { describePg } from "./pg-test-db.js";

describePg("POST /v1/conversations/:id/cancel", () => {
  const cancelRoute = ROUTES.find(
    (r) => r.operationId === "cancelConversationGeneration",
  )!;

  test("defaults to the hard stop mode when no body names one", async () => {
    cancelledId = undefined;
    cancelledMode = undefined;
    const directId = "direct-hard-mode-conversation";

    await cancelRoute.handler({
      pathParams: { id: directId },
      body: {},
      headers: {},
    });

    expect(cancelledMode!).toBe("hard");
  });

  test("passes an explicit mode through to cancelGeneration", async () => {
    cancelledId = undefined;
    cancelledMode = undefined;
    const directId = "direct-graceful-mode-conversation";

    await cancelRoute.handler({
      pathParams: { id: directId },
      body: { mode: "graceful" },
      headers: {},
    });

    expect(cancelledMode!).toBe("graceful");
  });

  test("rejects an unknown mode with 400", async () => {
    cancelledId = undefined;
    const directId = "direct-invalid-mode-conversation";
    const [httpRoute] = routeDefinitionsToHTTPRoutes([cancelRoute]);
    const url = new URL(`http://localhost/v1/conversations/${directId}/cancel`);

    const response = await httpRoute.handler({
      req: new Request(url, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ mode: "eventually" }),
      }),
      url,
      params: { id: directId },
      authContext: {} as never,
      server: {} as never,
    });

    expect(response.status).toBe(400);
    expect(cancelledId).toBeUndefined();
  });

  test("resolves conversation key to internal ID before cancelling", async () => {
    cancelledId = undefined;
    const conversationKey = "client-local-uuid-abc123";
    const mapping = await getOrCreateConversation(conversationKey);
    const internalId = mapping.conversationId;

    expect(internalId).not.toBe(conversationKey);

    const result = await cancelRoute.handler({
      pathParams: { id: conversationKey },
      body: {},
      headers: {},
    });

    expect(cancelledId!).toBe(internalId);
    expect(result).toEqual({
      ok: true,
      cancelled: true,
      conversationId: internalId,
    });
  });

  test("falls back to raw ID when key is not in the mapping", async () => {
    cancelledId = undefined;
    const directId = "direct-conversation-id";

    const result = await cancelRoute.handler({
      pathParams: { id: directId },
      body: {},
      headers: {},
    });

    expect(cancelledId!).toBe(directId);
    expect(result).toEqual({
      ok: true,
      cancelled: true,
      conversationId: directId,
    });
  });

  test("HTTP adapter returns a serializable 202 response", async () => {
    cancelledId = undefined;
    const directId = "direct-http-conversation-id";
    const [httpRoute] = routeDefinitionsToHTTPRoutes([cancelRoute]);
    const url = new URL(`http://localhost/v1/conversations/${directId}/cancel`);

    const response = await httpRoute.handler({
      req: new Request(url, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: "{}",
      }),
      url,
      params: { id: directId },
      authContext: {} as never,
      server: {} as never,
    });

    expect(response.status).toBe(202);
    expect(await response.json()).toEqual({
      ok: true,
      cancelled: true,
      conversationId: directId,
    });
    expect(cancelledId!).toBe(directId);
  });

  test("route definition advertises the cancellation response body", async () => {
    expect(cancelRoute.responseStatus).toBe("202");
    expect(cancelRoute.responseBody).toBeDefined();
  });
});

setDefaultTimeout(30_000);
