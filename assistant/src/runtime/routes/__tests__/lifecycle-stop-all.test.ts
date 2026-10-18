import { describe, expect, mock, test } from "bun:test";

let lastMode: string | undefined;
const STOP_ALL_RESULT = {
  conversations: 2,
  subagents: 1,
  acpSessions: 0,
  backgroundTools: 1,
  scheduleRuns: 0,
  workflowRuns: 1,
  heartbeatRuns: 0,
  memoryJobs: 0,
  unsupported: ["memoryJobs"],
};

mock.module("../../../daemon/stop-all.js", () => ({
  stopAllWork: async (mode: string) => {
    lastMode = mode;
    return STOP_ALL_RESULT;
  },
}));

const { ROUTES } = await import("../lifecycle-routes.js");
import { routeDefinitionsToHTTPRoutes } from "../http-adapter.js";

const stopAllRoute = ROUTES.find(
  (route) => route.operationId === "stopAllLifecycleWork",
)!;

describe("POST /v1/lifecycle/stop-all", () => {
  test("defaults to hard and returns the per-category counts", async () => {
    lastMode = undefined;

    const result = await stopAllRoute.handler({ body: {}, headers: {} });

    expect(lastMode!).toBe("hard");
    expect(result).toEqual(STOP_ALL_RESULT);
  });

  test("passes an explicit mode through", async () => {
    lastMode = undefined;

    await stopAllRoute.handler({
      body: { mode: "main-only" },
      headers: {},
    });

    expect(lastMode!).toBe("main-only");
  });

  test("rejects an unknown mode with 400", async () => {
    lastMode = undefined;
    const [httpRoute] = routeDefinitionsToHTTPRoutes([stopAllRoute]);
    const url = new URL("http://localhost/v1/lifecycle/stop-all");

    const response = await httpRoute.handler({
      req: new Request(url, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ mode: "eventually" }),
      }),
      url,
      params: {},
      authContext: {} as never,
      server: {} as never,
    });

    expect(response.status).toBe(400);
    expect(lastMode).toBeUndefined();
  });

  test("requires settings.write and an actor principal", () => {
    expect(stopAllRoute.policy?.requiredScopes).toEqual(["settings.write"]);
    expect(stopAllRoute.policy?.allowedPrincipalTypes).toBeDefined();
  });
});
