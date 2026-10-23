/**
 * Tests for the unified credential tag substitution (patch 09) and its
 * executor wiring. Run per-file only; the mock.module registrations below
 * poison any other test file run in the same process.
 *
 * Policy note: v1 is permissive — the tag path does NOT enforce a
 * per-credential tool gate. There is intentionally no denied-by-policy test.
 */

import { randomBytes } from "node:crypto";
import { existsSync, mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeEach, describe, expect, mock, test } from "bun:test";

// ---------------------------------------------------------------------------
// Mocks shared by every describe block in this file.
// ---------------------------------------------------------------------------

mock.module("../registry.js", () => ({
  registerTool: () => {},
  getTool: (name: string) => tools.get(name),
  resolveTool: (name: string) => tools.get(name),
  getAllTools: () => [...tools.values()],
  getToolOwner: () => undefined,
}));

mock.module("../security/secret-scanner.js", () => ({
  redactSecrets: (s: string) => s,
}));

mock.module("../terminal/safe-env.js", () => ({
  buildSanitizedEnv: () => ({ PATH: "/usr/bin" }),
}));

mock.module("../network/script-proxy/index.js", () => ({
  getOrStartSession: mock(() =>
    Promise.resolve({
      session: { id: "test-session-id", port: 8080, status: "active" },
      created: true,
    }),
  ),
  getSessionEnv: mock(() => ({
    HTTP_PROXY: "http://127.0.0.1:8080",
    HTTPS_PROXY: "http://127.0.0.1:8080",
    NO_PROXY: "localhost",
  })),
}));

// Inline substitution reads plaintext from secure storage; the backend
// resolution is irrelevant here, so serve fixed values.
const STORED_VALUES = new Map<string, string>([
  ["credential/openproject/api_key", "opapi_testvalue1234567890"],
  ["credential/github/token", "ghp_testtokenabcdef123456"],
]);

mock.module("../../security/secure-keys.js", () => ({
  getSecureKeyResultAsync: async (account: string) => {
    const value = STORED_VALUES.get(account);
    return { value, unreachable: value === undefined };
  },
}));

// Executor-level mocks (scaffold mirrors src/__tests__/tool-executor.test.ts).
mock.module("../../permissions/checker.js", () => ({
  isDynamicSkillLoadInvocation: () => false,
  classifyRisk: async () => ({
    level: "low",
    reason: undefined,
    scopeOptions: [],
    matchType: "unknown",
  }),
  check: async () => ({ decision: "allow", reason: "allowed" }),
  generateScopeOptions: () => [{ label: "/tmp", scope: "/tmp" }],
}));

mock.module("../../telemetry/tool-usage-store.js", () => ({
  recordToolInvocation: () => {},
  getRecentInvocations: () => [],
  rotateToolInvocations: async () => 0,
}));

const recordedInputs: { toolName: string; input: Record<string, unknown> }[] =
  [];
mock.module("../../telemetry/tool-audit.js", () => ({
  recordToolExecuted: (args: {
    toolName: string;
    input: Record<string, unknown>;
  }) => {
    recordedInputs.push({ toolName: args.toolName, input: args.input });
  },
  recordToolError: () => {},
  recordToolDenied: () => {},
}));

mock.module("../shared/filesystem/path-policy.js", () => ({
  sandboxPolicy: () => ({ ok: false }),
  sandboxPolicyWithHostFallback: () => ({ ok: false }),
  hostPolicy: () => ({ ok: false }),
}));

// ---------------------------------------------------------------------------
// Imports after mocks.
// ---------------------------------------------------------------------------

import type { PermissionPrompter } from "../../permissions/prompter.js";
import {
  hasCredentialTag,
  substituteCredentialTags,
} from "../credential-tag-substitution.js";
import {
  _setMetadataPath,
  upsertCredentialMetadata,
} from "../credentials/metadata-store.js";
import { ToolExecutor } from "../executor.js";
import { shellTool } from "../terminal/shell.js";
import { RiskLevel } from "../tool-types.js";
import type { Tool, ToolExecutionResult } from "../types.js";
import type { ToolContext } from "../types.js";

const TEST_DIR = join(
  tmpdir(),
  `vellum-credtag-test-${randomBytes(4).toString("hex")}`,
);
const META_PATH = join(TEST_DIR, "metadata.json");

beforeEach(() => {
  if (existsSync(TEST_DIR)) {
    rmSync(TEST_DIR, { recursive: true });
  }
  mkdirSync(TEST_DIR, { recursive: true });
  _setMetadataPath(META_PATH);
  upsertCredentialMetadata("openproject", "api_key");
  upsertCredentialMetadata("github", "token");
  recordedInputs.length = 0;
  toolSeenInput = undefined;
  tools.clear();
});

afterAll(() => {
  _setMetadataPath(null);
  if (existsSync(TEST_DIR)) {
    rmSync(TEST_DIR, { recursive: true });
  }
});

// ---------------------------------------------------------------------------
// Unit: tag parsing and substitution.
// ---------------------------------------------------------------------------

describe("credential tag substitution (unit)", () => {
  test("detects tags in nested records and arrays", () => {
    const input = {
      a: {
        b: ["x", { c: '<vellum-credential service="github" field="token" />' }],
      },
      n: 42,
    };
    expect(hasCredentialTag(input)).toBe(true);
    expect(hasCredentialTag({ plain: "no tags here" })).toBe(false);
    expect(hasCredentialTag(null)).toBe(false);
  });

  test("substitutes a whitespace variant without a space before the slash", async () => {
    const result = await substituteCredentialTags(
      "demo",
      { text: '<vellum-credential  service="github"   field="token"/>' },
      "inline",
    );
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.input.text).toBe("ghp_testtokenabcdef123456");
    }
  });

  test("leaves malformed tags untouched", async () => {
    const input = { text: '<vellum-credential service="github">' };
    expect(hasCredentialTag(input)).toBe(false);
    const result = await substituteCredentialTags("demo", input, "inline");
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.input).toBe(input);
    }
  });

  test("bash-rewrite mode emits the wrapper reveal call", async () => {
    const result = await substituteCredentialTags(
      "bash",
      {
        command:
          'curl -H "Authorization: Bearer <vellum-credential service="openproject" field="api_key" />" https://example.com',
      },
      "bash-rewrite",
    );
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.input.command).toBe(
        'curl -H "Authorization: Bearer $(assistant credentials reveal --headless --service openproject --field api_key)" https://example.com',
      );
      expect(result.substitutions).toEqual([
        { service: "openproject", field: "api_key", mode: "bash-rewrite" },
      ]);
    }
  });

  test("inline mode substitutes the plaintext in nested input without mutating the original", async () => {
    const input = {
      content: {
        args: [
          "--token",
          '<vellum-credential service="github" field="token" />',
        ],
        meta: {
          note: 'uses <vellum-credential service="openproject" field="api_key" />',
        },
      },
    };
    const result = await substituteCredentialTags("mcp__demo", input, "inline");
    expect(result.ok).toBe(true);
    if (result.ok) {
      const content = result.input.content as {
        args: string[];
        meta: { note: string };
      };
      expect(content.args[1]).toBe("ghp_testtokenabcdef123456");
      expect(content.meta.note).toBe("uses opapi_testvalue1234567890");
    }
    // Original untouched: still tag form everywhere.
    expect(input.content.args[1]).toBe(
      '<vellum-credential service="github" field="token" />',
    );
    expect(hasCredentialTag(input)).toBe(true);
  });

  test("reports an unknown credential ref in the collected error", async () => {
    const result = await substituteCredentialTags(
      "demo",
      { text: '<vellum-credential service="nope" field="missing" />' },
      "inline",
    );
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error).toContain("nope/missing");
      expect(result.error).toContain("unknown credential");
    }
  });

  test("rejects names that are unsafe to embed in a shell substitution", async () => {
    const result = await substituteCredentialTags(
      "demo",
      { text: '<vellum-credential service="a&quot;$(evil)" field="x" />' },
      "inline",
    );
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error).toContain(
        "letters, digits, dot, underscore, and hyphen",
      );
    }
  });

  test("fails closed when a substituted value carries a tag", async () => {
    STORED_VALUES.set(
      "credential/evil/chain",
      'prefix <vellum-credential service="github" field="token" />',
    );
    upsertCredentialMetadata("evil", "chain");
    const result = await substituteCredentialTags(
      "demo",
      { text: '<vellum-credential service="evil" field="chain" />' },
      "inline",
    );
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error).toContain("contains a credential tag");
    }
    STORED_VALUES.delete("credential/evil/chain");
  });
});

// ---------------------------------------------------------------------------
// bash tool: credential_ids is disabled.
// ---------------------------------------------------------------------------

describe("bash tool credential_ids rejection", () => {
  const ctx: ToolContext = {
    workingDir: "/tmp",
    conversationId: "test-conv",
    trustClass: "guardian",
  };

  test("passing credential_ids returns a hard error pointing at the tag", async () => {
    const result = await shellTool.execute(
      {
        command: "curl https://example.com",
        activity: "to test a request",
        credential_ids: ["openproject/api_key"],
      },
      ctx,
    );
    expect(result.isError).toBe(true);
    expect(result.content).toContain("credential_ids");
    expect(result.content).toContain("<vellum-credential");
  });

  test("a command with a tag and no credential_ids passes the guard", async () => {
    const result = await shellTool.execute(
      {
        command:
          'echo "tag: <vellum-credential service=\"openproject\" field=\"api_key\" />"',
        activity: "to test the guard",
      },
      ctx,
    );
    expect(result.content).not.toContain("credential_ids");
  });
});

// ---------------------------------------------------------------------------
// Executor wiring: substitution runs on the copy the tool sees; audit and
// transcript keep the tag form.
// ---------------------------------------------------------------------------

const tools = new Map<string, Tool>();
let toolSeenInput: Record<string, unknown> | undefined;

function registerCapturingTool(name: string): void {
  tools.set(name, {
    name,
    description: "test tool",
    category: "test",
    defaultRiskLevel: RiskLevel.Low,
    input_schema: {},
    executionTarget: "host",
    execute: async (input: Record<string, unknown>) => {
      toolSeenInput = input;
      return { content: "ok", isError: false } satisfies ToolExecutionResult;
    },
  });
}

function makePrompter(): PermissionPrompter {
  return {
    prompt: async () => ({ decision: "allow" as const }),
    resolveConfirmation: () => {},
    updateSender: () => {},
    dispose: () => {},
  } as unknown as PermissionPrompter;
}

function makeContext(): ToolContext {
  return {
    workingDir: "/tmp/project",
    conversationId: "conversation-1",
    trustClass: "guardian",
  };
}

describe("executor credential tag wiring", () => {
  test("non-bash tool receives the substituted copy; recordToolExecuted keeps the tag", async () => {
    registerCapturingTool("mcp__demo");
    const executor = new ToolExecutor(makePrompter());
    const tag = '<vellum-credential service="github" field="token" />';
    const result = await executor.execute(
      "mcp__demo",
      { token: tag },
      makeContext(),
    );
    expect(result.isError).toBe(false);
    // The tool saw the plaintext.
    expect(toolSeenInput).toEqual({ token: "ghp_testtokenabcdef123456" });
    // The audit record kept the tag form.
    expect(recordedInputs).toHaveLength(1);
    expect(recordedInputs[0].input).toEqual({ token: tag });
  });

  test("bash-family tool receives the wrapper reveal call", async () => {
    registerCapturingTool("bash");
    const executor = new ToolExecutor(makePrompter());
    await executor.execute(
      "bash",
      {
        command:
          'curl -H "Authorization: Bearer <vellum-credential service="openproject" field="api_key" />"',
      },
      makeContext(),
    );
    expect(toolSeenInput).toEqual({
      command:
        'curl -H "Authorization: Bearer $(assistant credentials reveal --headless --service openproject --field api_key)"',
    });
  });

  test("an unresolvable tag returns an error result without executing", async () => {
    let executed = false;
    tools.set("mcp__demo2", {
      name: "mcp__demo2",
      description: "test tool",
      category: "test",
      defaultRiskLevel: RiskLevel.Low,
      input_schema: {},
      executionTarget: "host",
      execute: async () => {
        executed = true;
        return { content: "ok", isError: false };
      },
    });
    const executor = new ToolExecutor(makePrompter());
    const result = await executor.execute(
      "mcp__demo2",
      { token: '<vellum-credential service="ghost" field="none" />' },
      makeContext(),
    );
    expect(result.isError).toBe(true);
    expect(result.content).toContain("ghost/none");
    expect(executed).toBe(false);
  });

  test("consent key composes with a tag: tool gets neither the key nor the tag", async () => {
    registerCapturingTool("mcp__demo3");
    const executor = new ToolExecutor(makePrompter());
    await executor.execute(
      "mcp__demo3",
      {
        token: '<vellum-credential service="github" field="token" />',
        i_have_explicit_user_consent_to_show_secrets_unredacted: true,
      },
      makeContext(),
    );
    expect(toolSeenInput).toEqual({ token: "ghp_testtokenabcdef123456" });
  });
});
