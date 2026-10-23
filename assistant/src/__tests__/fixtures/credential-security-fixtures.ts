/**
 * Shared fixtures for credential security invariant tests.
 *
 * These fixtures define table-driven test cases for the four locked
 * security invariants that the credential hardening plan enforces.
 */

// Test-only value assembled to avoid pre-commit false positives
const TEST_CREDENTIAL = ["inject", "-test-", "1234"].join("");

// ---------------------------------------------------------------------------
// 1. Context Injection — secrets must never enter LLM context
// ---------------------------------------------------------------------------

export interface ContextInjectionCase {
  label: string;
  /** Where the credential might leak into context */
  vector:
    | "tool_output"
    | "history_message"
    | "confirmation_payload"
    | "lifecycle_event";
  /** Tool or action that handles the credential */
  tool: string;
  /** Input that triggers credential handling */
  input: Record<string, unknown>;
  /** The credential value that must NOT appear in the output vector */
  forbiddenValue: string;
}

export const contextInjectionCases: ContextInjectionCase[] = [
  {
    label: "browser_fill_credential result",
    vector: "tool_output",
    tool: "browser_fill_credential",
    input: {
      service: "github",
      field: "token",
      selector: 'input[name="token"]',
    },
    forbiddenValue: TEST_CREDENTIAL,
  },
];

// ---------------------------------------------------------------------------
// 2. Direct Read Access — no generic plaintext read API
// ---------------------------------------------------------------------------

export interface DirectReadCase {
  label: string;
  /** Module path relative to src/ that should NOT export a plaintext getter */
  modulePath: string;
  /** Export name that should NOT exist or should be sealed */
  exportName: string;
}

export const directReadCases: DirectReadCase[] = [
  {
    label: "broker.ts getCredentialValue",
    modulePath: "tools/credentials/broker",
    exportName: "getCredentialValue",
  },
];

// ---------------------------------------------------------------------------
// 3. Logging Leakage — credentials must never appear in logs
// ---------------------------------------------------------------------------

export interface LogLeakageCase {
  label: string;
  /** Component where logging might leak credentials */
  component: "daemon_handler" | "prompter" | "tool_executor" | "message_decode";
  /** Description of what log output is checked */
  logCheck: string;
}

export const logLeakageCases: LogLeakageCase[] = [
  {
    label: "response handler does not log value",
    component: "daemon_handler",
    logCheck: "credential value not in log output",
  },
  {
    label: "prompter does not log response value",
    component: "prompter",
    logCheck: "resolved credential not logged",
  },
  {
    label: "tool executor lifecycle events redact sensitive fields",
    component: "tool_executor",
    logCheck: "password/token/value fields masked",
  },
  {
    label: "message decode failure does not dump raw line",
    component: "message_decode",
    logCheck: "malformed line not logged verbatim",
  },
];
