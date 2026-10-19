import { describe, expect, test } from "bun:test";

import {
  SALVAGE_ERROR_TOOL_NAME,
  salvageXmlToolCalls,
  shouldSalvageXmlToolCalls,
  splitXmlToolCallHoldback,
} from "../xml-tool-call-salvage.js";

const OFFERED = new Set(["bash", "file_read", "ui_show"]);
const FW = "\uFF5C";

describe("salvageXmlToolCalls", () => {
  test("converts a DeepSeek-style bash invoke into a structured call", () => {
    const text = `Let me actually run the check.

<invoke name="bash">
<parameter name="command">cd /workspace/example && git status</parameter>
<parameter name="activity">Checking live repo state</parameter>
<parameter name="timeout_seconds">60</parameter>
</invoke>`;

    const salvaged = salvageXmlToolCalls(text, OFFERED);
    expect(salvaged).not.toBeNull();
    expect(salvaged!.text).toBe("Let me actually run the check.");
    expect(salvaged!.calls).toEqual([
      {
        name: "bash",
        input: {
          command: "cd /workspace/example && git status",
          activity: "Checking live repo state",
          timeout_seconds: 60,
        },
      },
    ]);
  });

  test("salvages multiple invokes and strips an empty function_calls wrapper", () => {
    const text = `<function_calls>
<invoke name="file_read">
<parameter name="path">/workspace/README.md</parameter>
</invoke>
<invoke name="bash">
<parameter name="command">ls</parameter>
</invoke>
</function_calls>`;

    const salvaged = salvageXmlToolCalls(text, OFFERED);
    expect(salvaged!.text).toBe("");
    expect(salvaged!.calls.map((call) => call.name)).toEqual([
      "file_read",
      "bash",
    ]);
  });

  test("emits a call with the raw name for an unknown tool so the executor errors", () => {
    const text = `<invoke name="not_a_real_tool">
<parameter name="command">rm -rf /</parameter>
</invoke>`;

    const salvaged = salvageXmlToolCalls(text, OFFERED);
    expect(salvaged).not.toBeNull();
    expect(salvaged!.calls).toEqual([
      { name: "not_a_real_tool", input: { command: "rm -rf /" } },
    ]);
    expect(salvaged!.text).toBe("");
  });

  test("salvages every invoke, keeping unresolved names for an error result", () => {
    const text = `<invoke name="bash">
<parameter name="command">pwd</parameter>
</invoke>
<invoke name="not_a_real_tool">
<parameter name="command">nope</parameter>
</invoke>`;

    const salvaged = salvageXmlToolCalls(text, OFFERED);
    expect(salvaged!.calls).toEqual([
      { name: "bash", input: { command: "pwd" } },
      { name: "not_a_real_tool", input: { command: "nope" } },
    ]);
    expect(salvaged!.text).toBe("");
  });

  test("emits an error-named call for a truncated invoke instead of ending silently", () => {
    const text = `<invoke name="bash">
<parameter name="command">git status</parameter>
<parameter name="activity">Checking`;

    const salvaged = salvageXmlToolCalls(text, OFFERED);
    expect(salvaged).not.toBeNull();
    expect(salvaged!.calls).toEqual([
      { name: SALVAGE_ERROR_TOOL_NAME, input: {} },
    ]);
  });

  test("matches offered tool names case-insensitively", () => {
    const salvaged = salvageXmlToolCalls(
      `<invoke name="Bash"><parameter name="command">echo hi</parameter></invoke>`,
      OFFERED,
    );
    expect(salvaged!.calls[0]?.name).toBe("bash");
  });

  test("returns null when no tools were offered", () => {
    const text = `<invoke name="bash"><parameter name="command">ls</parameter></invoke>`;
    expect(salvageXmlToolCalls(text, new Set())).toBeNull();
  });

  test("decodes XML entities in parameter values", () => {
    const salvaged = salvageXmlToolCalls(
      `<invoke name="bash"><parameter name="command">echo &quot;a &amp; b&quot;</parameter></invoke>`,
      OFFERED,
    );
    expect(salvaged!.calls[0]?.input.command).toBe('echo "a & b"');
  });

  test("leaves invokes inside markdown fences as text", () => {
    const text = `Example:

\`\`\`xml
<invoke name="bash">
<parameter name="command">ls</parameter>
</invoke>
\`\`\``;

    expect(salvageXmlToolCalls(text, OFFERED)).toBeNull();
  });

  test("salvages an unfenced invoke next to a fenced example", () => {
    const text = `<invoke name="bash"><parameter name="command">pwd</parameter></invoke>

\`\`\`
<invoke name="file_read"><parameter name="path">/workspace/README.md</parameter></invoke>
\`\`\``;

    const salvaged = salvageXmlToolCalls(text, OFFERED);
    expect(salvaged!.calls).toEqual([
      { name: "bash", input: { command: "pwd" } },
    ]);
    expect(salvaged!.text).toContain('name="file_read"');
  });
});

describe("salvageXmlToolCalls DSML dialects", () => {
  test("parses a DeepSeek V4 double-bar DSML block and honors string typing", () => {
    const text = `On it.
<${FW}DSML${FW}tool_calls>
<${FW}DSML${FW}invoke name="bash">
<${FW}DSML${FW}parameter name="command" string="true">cd /workspace/example && git status</${FW}DSML${FW}parameter>
<${FW}DSML${FW}parameter name="timeout_seconds" string="false">60</${FW}DSML${FW}parameter>
</${FW}DSML${FW}invoke>
</${FW}DSML${FW}tool_calls>`;

    const salvaged = salvageXmlToolCalls(text, OFFERED);
    expect(salvaged).not.toBeNull();
    expect(salvaged!.text).toBe("On it.");
    expect(salvaged!.calls).toEqual([
      {
        name: "bash",
        input: {
          command: "cd /workspace/example && git status",
          timeout_seconds: 60,
        },
      },
    ]);
  });

  test("parses a V3.2 single-bar function_calls block", () => {
    const text = `<${FW}function_calls>
<${FW}invoke name="file_read">
<${FW}parameter name="path" string="true">/workspace/README.md</${FW}parameter>
</${FW}invoke>
</${FW}function_calls>`;

    const salvaged = salvageXmlToolCalls(text, OFFERED);
    expect(salvaged!.text).toBe("");
    expect(salvaged!.calls).toEqual([
      { name: "file_read", input: { path: "/workspace/README.md" } },
    ]);
  });

  test("parses an ASCII-pipe DSML block", () => {
    const text = `<||DSML||tool_calls>
<||DSML||invoke name="bash">
<||DSML||parameter name="command" string="true">pwd</||DSML||parameter>
</||DSML||invoke>
</||DSML||tool_calls>`;

    const salvaged = salvageXmlToolCalls(text, OFFERED);
    expect(salvaged!.calls).toEqual([
      { name: "bash", input: { command: "pwd" } },
    ]);
  });

  test("strips a wrapper-only DSML block and emits an error call", () => {
    const text = `<${FW}DSML${FW}tool_calls>
</${FW}DSML${FW}tool_calls>`;

    const salvaged = salvageXmlToolCalls(text, OFFERED);
    expect(salvaged).not.toBeNull();
    expect(salvaged!.calls).toEqual([
      { name: SALVAGE_ERROR_TOOL_NAME, input: {} },
    ]);
    expect(salvaged!.text).toBe("");
  });

  test("emits an error call for a truncated DSML invoke", () => {
    const text = `<${FW}DSML${FW}tool_calls>
<${FW}DSML${FW}invoke name="bash">
<${FW}DSML${FW}parameter name="command" string="true">git status`;

    const salvaged = salvageXmlToolCalls(text, OFFERED);
    expect(salvaged!.calls).toEqual([
      { name: SALVAGE_ERROR_TOOL_NAME, input: {} },
    ]);
  });
});

describe("shouldSalvageXmlToolCalls", () => {
  test("is true for DeepSeek model ids", () => {
    expect(
      shouldSalvageXmlToolCalls(
        "accounts/fireworks/models/deepseek-v4-flash-0731",
      ),
    ).toBe(true);
    expect(shouldSalvageXmlToolCalls("deepseek/deepseek-v4-flash")).toBe(true);
  });

  test("is false for other models", () => {
    expect(shouldSalvageXmlToolCalls("gpt-5.6")).toBe(false);
    expect(
      shouldSalvageXmlToolCalls("accounts/fireworks/models/minimax-m3"),
    ).toBe(false);
    expect(shouldSalvageXmlToolCalls(undefined)).toBe(false);
  });
});

describe("splitXmlToolCallHoldback", () => {
  test("holds a complete invoke opener and the rest of the buffer", () => {
    expect(splitXmlToolCallHoldback('Sure.\n<invoke name="bash">')).toEqual({
      visible: "Sure.\n",
      held: `<invoke name="bash">`,
    });
  });

  test("holds a partial opener split across chunks", () => {
    expect(splitXmlToolCallHoldback("Okay.<inv")).toEqual({
      visible: "Okay.",
      held: "<inv",
    });
  });

  test("holds a fullwidth DSML opener", () => {
    expect(
      splitXmlToolCallHoldback(`Sure.\n<${FW}DSML${FW}invoke name="bash">`),
    ).toEqual({
      visible: "Sure.\n",
      held: `<${FW}DSML${FW}invoke name="bash">`,
    });
  });

  test("holds a partial fullwidth opener split across chunks", () => {
    expect(splitXmlToolCallHoldback(`Okay.<${FW}`)).toEqual({
      visible: "Okay.",
      held: `<${FW}`,
    });
  });

  test("passes through text with no opener", () => {
    expect(splitXmlToolCallHoldback("Hello there.")).toEqual({
      visible: "Hello there.",
      held: "",
    });
  });
});
