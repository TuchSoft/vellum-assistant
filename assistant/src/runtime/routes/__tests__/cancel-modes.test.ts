import { describe, expect, mock, test } from "bun:test";

let cancelledMode: string | undefined;
let cancelledId: string | undefined;

mock.module("../../../daemon/handlers/conversations.js", () => ({
  cancelGeneration: (id: string, mode = "hard") => {
    cancelledId = id;
    cancelledMode = mode;
    return true;
  },
  resolveMetaSlashCommand: async () => null,
  switchConversation: async () => null,
  clearAllConversations: async () => 0,
  undoLastMessage: async () => null,
}));

const realKeyStore =
  await import("../../../persistence/conversation-key-store.js");
mock.module("../../../persistence/conversation-key-store.js", () => ({
  ...realKeyStore,
  getOrCreateConversation: async (id: string) => ({ conversationId: id }),
  resolveConversationId: async (id: string) => id,
}));

const { ROUTES } = await import("../conversation-management-routes.js");
import { routeDefinitionsToHTTPRoutes } from "../http-adapter.js";

const cancelRoute = ROUTES.find(
  (route) => route.operationId === "cancelConversationGeneration",
)!;

function lastMode(): string | undefined {
  return cancelledMode;
}

describe("POST /v1/conversations/:id/cancel stop modes", () => {
  test("defaults to hard when the body names no mode", async () => {
    cancelledMode = undefined;

    await cancelRoute.handler({
      pathParams: { id: "conv-1" },
      body: {},
      headers: {},
    });

    expect(lastMode()).toBe("hard");
  });

  test("accepts graceful and main-only", async () => {
    for (const mode of ["graceful", "main-only"] as const) {
      cancelledMode = undefined;
      await cancelRoute.handler({
        pathParams: { id: "conv-1" },
        body: { mode },
        headers: {},
      });
      expect(lastMode()).toBe(mode);
    }
  });

  test("rejects an unknown mode with 400", async () => {
    cancelledId = undefined;
    const [httpRoute] = routeDefinitionsToHTTPRoutes([cancelRoute]);
    const url = new URL("http://localhost/v1/conversations/conv-1/cancel");

    const response = await httpRoute.handler({
      req: new Request(url, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ mode: "eventually" }),
      }),
      url,
      params: { id: "conv-1" },
      authContext: {} as never,
      server: {} as never,
    });

    expect(response.status).toBe(400);
    expect(cancelledId).toBeUndefined();
  });
});
