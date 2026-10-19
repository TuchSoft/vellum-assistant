import {
  afterEach,
  beforeEach,
  describe,
  expect,
  jest,
  mock,
  test,
} from "bun:test";

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

// The scheduler test drives the real reloadMcpServers() through its module
// mocks, the same pattern as plugin-mcp-reconcile.test.ts. Mocking the
// reload service itself here would leak into other test files in the same
// process (Bun shares mock.module registrations by resolved path).
const managerReconcile = jest.fn(async () => ({
  connected: [],
  kept: [],
  failed: [],
  removed: [],
}));

mock.module("../../mcp/effective-config.js", () => ({
  buildEffectiveMcpConfig: () => ({ servers: {}, globalMaxTools: 50 }),
  pluginMcpServersChangedSinceLastBuild: () => false,
}));

mock.module("../../mcp/manager.js", () => ({
  getMcpServerManager: () => ({ reconcile: managerReconcile }),
}));

mock.module("../../mcp/mcp-header-store.js", () => ({
  migrateLegacyMcpHeaders: async () => {},
}));

mock.module("../../mcp/workspace-mcp-config.js", () => ({
  loadWorkspaceMcpConfig: () => ({ servers: {} }),
}));

mock.module("../../config/loader.js", () => ({
  getConfig: () => ({}),
  invalidateConfigCache: () => {},
}));

mock.module("../../tools/registry.js", () => ({
  registerMcpTools: () => [],
  unregisterAllMcpTools: () => {},
  getMcpToolNamesForServer: () => [],
  unregisterMcpToolsForServer: () => [],
  replaceMcpToolsForServer: () => [],
}));

const { startMcpHealthScheduler, stopMcpHealthScheduler } =
  await import("../mcp-health-scheduler.js");

const ORIGINAL_ENV = process.env.VELLUM_MCP_HEALTH_INTERVAL_MS;

describe("mcp-health-scheduler", () => {
  beforeEach(() => {
    process.env.VELLUM_MCP_HEALTH_INTERVAL_MS = "30";
    managerReconcile.mockClear();
  });

  afterEach(() => {
    stopMcpHealthScheduler();
    if (ORIGINAL_ENV === undefined) {
      delete process.env.VELLUM_MCP_HEALTH_INTERVAL_MS;
    } else {
      process.env.VELLUM_MCP_HEALTH_INTERVAL_MS = ORIGINAL_ENV;
    }
  });

  test("fires the MCP reconcile on the configured interval", async () => {
    startMcpHealthScheduler();
    await sleep(120);
    expect(managerReconcile).toHaveBeenCalled();
  });

  test("start is idempotent and stop halts the timer", async () => {
    startMcpHealthScheduler();
    startMcpHealthScheduler();
    stopMcpHealthScheduler();
    await sleep(120);
    expect(managerReconcile).not.toHaveBeenCalled();
  });
});
