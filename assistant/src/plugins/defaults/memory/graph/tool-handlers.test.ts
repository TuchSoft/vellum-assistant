/**
 * Unit tests for handleDeleteMemory, handleUpdateMemory, handleListMemory.
 *
 * All DB/store calls are mocked so the tests run without a real workspace.
 */

import {
  beforeEach,
  describe,
  expect,
  mock,
  setDefaultTimeout,
  test,
} from "bun:test";

setDefaultTimeout(30_000);

// ── Controllable store mock ────────────────────────────────────────────────────
let mockNodes: Array<{
  id: string;
  content: string;
  type: string;
  fidelity: string;
  created: number;
}> = [];

const mockDeleteNode = mock(() => {});
const mockUpdateNode = mock(() => {});
const mockRecordNodeEdit = mock(() => {});

mock.module("./store.js", () => ({
  queryNodes: () => mockNodes,
  deleteNode: mockDeleteNode,
  updateNode: mockUpdateNode,
  recordNodeEdit: mockRecordNodeEdit,
}));

// ── Stub jobs-store ────────────────────────────────────────────────────────────
const mockEnqueueMemoryJob = mock(() => {});

mock.module("../../../../persistence/jobs-store.js", () => ({
  enqueueMemoryJob: mockEnqueueMemoryJob,
}));

// ── Stub fs / platform (used by remember handler, not our handlers) ────────────
mock.module("node:fs", () => ({
  appendFileSync: () => {},
  existsSync: () => false,
  mkdirSync: () => {},
}));

mock.module("../../../../util/platform.js", () => ({
  getWorkspaceDir: () => "/tmp/test-workspace",
}));

mock.module("../v1/jobs/embed-pkb-file.js", () => ({
  enqueuePkbIndexJob: () => {},
}));

// ── Import handlers after mocks are set up ─────────────────────────────────────
import type { AssistantConfig } from "../../../../config/types.js";
import {
  handleDeleteMemory,
  handleListMemory,
  handleUpdateMemory,
} from "./tool-handlers.js";

// ── Config helpers ─────────────────────────────────────────────────────────────
const configV2On = {
  memory: { v2: { enabled: true } },
} as unknown as AssistantConfig;

const configV2Off = {
  memory: { v2: { enabled: false } },
} as unknown as AssistantConfig;

// v3-live with the v2 flag off — the concept-page substrate is active, so the
// handlers must work exactly as they do under v2.
const configV3Only = {
  memory: { v2: { enabled: false }, v3: { live: true } },
} as unknown as AssistantConfig;

function node(
  id: string,
  content: string,
  overrides: Partial<(typeof mockNodes)[0]> = {},
) {
  return {
    id,
    content,
    type: "semantic",
    fidelity: "vivid",
    created: Date.now(),
    ...overrides,
  };
}

// ── Tests ──────────────────────────────────────────────────────────────────────

describe("handleDeleteMemory", () => {
  beforeEach(() => {
    mockNodes = [];
    mockDeleteNode.mockClear();
  });

  test("returns error when content is empty", async () => {
    const result = await handleDeleteMemory({ content: "  " }, configV2On);
    expect(result.success).toBe(false);
    expect(result.message).toMatch(/required/);
  });

  test("returns error when concept-page memory is inactive", async () => {
    const result = await handleDeleteMemory({ content: "foo" }, configV2Off);
    expect(result.success).toBe(false);
    expect(result.message).toMatch(/concept-page memory/);
  });

  test("passes the gate when v3 is live with the v2 flag off", async () => {
    mockNodes = [node("1", "User prefers TypeScript")];
    const result = await handleDeleteMemory(
      { content: "User prefers TypeScript" },
      configV3Only,
    );
    expect(result.success).toBe(true);
    expect(mockDeleteNode).toHaveBeenCalledWith("1");
  });

  test("returns error when no node matches", async () => {
    mockNodes = [node("1", "Something else entirely")];
    const result = await handleDeleteMemory(
      { content: "TypeScript" },
      configV2On,
    );
    expect(result.success).toBe(false);
    expect(result.message).toMatch(/No memory found/);
  });

  test("deletes exact-match node", async () => {
    mockNodes = [node("1", "User prefers TypeScript")];
    const result = await handleDeleteMemory(
      { content: "User prefers TypeScript" },
      configV2On,
    );
    expect(result.success).toBe(true);
    expect(mockDeleteNode).toHaveBeenCalledWith("1");
    expect(result.message).toMatch(/Deleted/);
  });

  test("exact match takes priority over substring match", async () => {
    mockNodes = [
      node("1", "User prefers TypeScript"),
      node("2", "User prefers TypeScript over JavaScript"),
    ];
    const result = await handleDeleteMemory(
      { content: "User prefers TypeScript" },
      configV2On,
    );
    expect(result.success).toBe(true);
    expect(mockDeleteNode).toHaveBeenCalledWith("1");
  });

  test("returns error when multiple nodes match", async () => {
    mockNodes = [
      node("1", "User likes TypeScript"),
      node("2", "User uses TypeScript at work"),
    ];
    const result = await handleDeleteMemory(
      { content: "TypeScript" },
      configV2On,
    );
    expect(result.success).toBe(false);
    expect(result.message).toMatch(/Multiple memories match/);
    expect(mockDeleteNode).not.toHaveBeenCalled();
  });
});

describe("handleUpdateMemory", () => {
  beforeEach(() => {
    mockNodes = [];
    mockUpdateNode.mockClear();
    mockRecordNodeEdit.mockClear();
    mockEnqueueMemoryJob.mockClear();
  });

  test("returns error when inputs are missing", async () => {
    const result = await handleUpdateMemory(
      { old_content: "", new_content: "new" },
      "cli",
      configV2On,
    );
    expect(result.success).toBe(false);
    expect(result.message).toMatch(/required/);
  });

  test("returns error when concept-page memory is inactive", async () => {
    const result = await handleUpdateMemory(
      { old_content: "old", new_content: "new" },
      "cli",
      configV2Off,
    );
    expect(result.success).toBe(false);
    expect(result.message).toMatch(/concept-page memory/);
  });

  test("returns error when no node matches old_content", async () => {
    mockNodes = [node("1", "Something else")];
    const result = await handleUpdateMemory(
      { old_content: "TypeScript", new_content: "JavaScript" },
      "cli",
      configV2On,
    );
    expect(result.success).toBe(false);
    expect(result.message).toMatch(/No memory found/);
  });

  test("updates matching node and re-embeds", async () => {
    mockNodes = [node("1", "User prefers TypeScript")];
    const result = await handleUpdateMemory(
      {
        old_content: "User prefers TypeScript",
        new_content: "User prefers TypeScript and Bun",
      },
      "cli",
      configV2On,
    );
    expect(result.success).toBe(true);
    expect(mockRecordNodeEdit).toHaveBeenCalledTimes(1);
    expect(mockUpdateNode).toHaveBeenCalledWith("1", {
      content: "User prefers TypeScript and Bun",
    });
    expect(mockEnqueueMemoryJob).toHaveBeenCalledWith("embed_graph_node", {
      nodeId: "1",
    });
  });

  test("returns error when multiple nodes match", async () => {
    mockNodes = [
      node("1", "User likes TypeScript"),
      node("2", "User uses TypeScript daily"),
    ];
    const result = await handleUpdateMemory(
      { old_content: "TypeScript", new_content: "Rust" },
      "cli",
      configV2On,
    );
    expect(result.success).toBe(false);
    expect(result.message).toMatch(/Multiple memories match/);
    expect(mockUpdateNode).not.toHaveBeenCalled();
  });

  test("returns error when new_content already exists on another node", async () => {
    mockNodes = [
      node("1", "User prefers TypeScript"),
      node("2", "User prefers Rust"),
    ];
    const result = await handleUpdateMemory(
      {
        old_content: "User prefers TypeScript",
        new_content: "User prefers Rust",
      },
      "cli",
      configV2On,
    );
    expect(result.success).toBe(false);
    expect(result.message).toMatch(/already exists/);
    expect(mockUpdateNode).not.toHaveBeenCalled();
  });
});

describe("handleListMemory", () => {
  beforeEach(() => {
    mockNodes = [];
  });

  test("returns empty when concept-page memory is inactive", async () => {
    const result = await handleListMemory({}, configV2Off);
    expect(result.success).toBe(false);
    expect(result.nodes).toHaveLength(0);
    expect(result.total).toBe(0);
  });

  test("passes the gate when v3 is live with the v2 flag off", async () => {
    mockNodes = [node("1", "User prefers TypeScript")];
    const result = await handleListMemory({}, configV3Only);
    expect(result.success).toBe(true);
    expect(result.nodes).toHaveLength(1);
  });

  test("returns all active nodes", async () => {
    mockNodes = [
      node("1", "User prefers TypeScript"),
      node("2", "User works at Acme Corp"),
    ];
    const result = await handleListMemory({}, configV2On);
    expect(result.success).toBe(true);
    expect(result.nodes).toHaveLength(2);
    expect(result.total).toBe(2);
    expect(result.nodes[0]!.id).toBe("1");
  });

  test("filters by search substring (case-insensitive)", async () => {
    mockNodes = [
      node("1", "User prefers TypeScript"),
      node("2", "User works at Acme Corp"),
      node("3", "The sky is typescript-blue"),
    ];
    const result = await handleListMemory({ search: "typescript" }, configV2On);
    expect(result.success).toBe(true);
    expect(result.nodes).toHaveLength(2);
    expect(result.nodes.map((n) => n.id)).toEqual(["1", "3"]);
  });

  test("returns no results when search matches nothing", async () => {
    mockNodes = [node("1", "User prefers TypeScript")];
    const result = await handleListMemory({ search: "Python" }, configV2On);
    expect(result.success).toBe(true);
    expect(result.nodes).toHaveLength(0);
    expect(result.total).toBe(0);
  });

  test("respects limit", async () => {
    mockNodes = Array.from({ length: 10 }, (_, i) =>
      node(String(i), `Memory ${i}`),
    );
    const result = await handleListMemory({ limit: 3 }, configV2On);
    expect(result.nodes).toHaveLength(3);
    expect(result.total).toBe(3);
  });

  test("search is exhaustive — finds matches beyond position 500 in the full set", async () => {
    // Simulate 502 nodes where the matching one is at position 501 (would be
    // missed if we capped the DB fetch at 500 before filtering in memory).
    const bulk = Array.from({ length: 501 }, (_, i) =>
      node(String(i), `Bulk memory ${i}`),
    );
    const late = node("late", "User speaks Kinyarwanda");
    mockNodes = [...bulk, late];
    const result = await handleListMemory(
      { search: "kinyarwanda" },
      configV2On,
    );
    expect(result.success).toBe(true);
    expect(result.nodes).toHaveLength(1);
    expect(result.nodes[0]!.id).toBe("late");
  });

  test("includes required fields on each node", async () => {
    mockNodes = [
      node("42", "Test content", { type: "episodic", fidelity: "clear" }),
    ];
    const result = await handleListMemory({}, configV2On);
    const n = result.nodes[0]!;
    expect(n.id).toBe("42");
    expect(n.content).toBe("Test content");
    expect(n.type).toBe("episodic");
    expect(n.fidelity).toBe("clear");
    expect(typeof n.created).toBe("number");
  });
});
