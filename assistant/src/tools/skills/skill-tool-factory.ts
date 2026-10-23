import { basename } from "node:path";

import type { SkillCapabilities } from "@vellumai/service-contracts/skill-capabilities";

import type { SkillToolEntry } from "../../config/skills.js";
import { RiskLevel } from "../../permissions/types.js";
import {
  getCachedSkillCapabilities,
  getSkillCapabilities,
} from "../../skills/capabilities.js";
import {
  coerceArrayShapes,
  coerceStringBooleans,
  coerceStringNumbers,
  validateInputAgainstSchema,
} from "../../skills/validate-input.js";
import { computerUseExecutionTarget } from "../computer-use/target.js";
import { withActivityProperty } from "../schema-transforms.js";
import { bundledToolInputMisuseMessage } from "../shared/input-misuse.js";
import { bundledToolInputRepairs } from "../shared/input-repairs.js";
import type { ExecutionTarget } from "../tool-types.js";
import type { Tool, ToolContext, ToolExecutionResult } from "../types.js";
import { formatSkillInputSchema } from "./format-input-schema.js";
import { runSkillToolScript } from "./skill-script-runner.js";

const riskMap: Record<SkillToolEntry["risk"], RiskLevel> = {
  low: RiskLevel.Low,
  medium: RiskLevel.Medium,
  high: RiskLevel.High,
};

/**
 * Create a runtime Tool object from a manifest entry.
 * Maps SkillToolEntry metadata to the Tool interface and routes execution
 * through the skill script runner. Ownership (the originating skill id) is
 * recorded by the tool registry at
 * `registerSkillTools(skillId, tools, registration)` time, not stamped on the
 * `Tool` object — see {@link ../../tools/registry.getToolOwner}.
 *
 * Capabilities are never read off the manifest: the skill's own declaration
 * says what it wants, while the gateway grants what it may do for this exact
 * content version. Every gate below (host execution, first-party input
 * repairs, the computer-use target) reads that grant, and an unreadable or
 * absent grant denies.
 *
 * `capabilities` is an already-resolved set supplied by a caller that owns the
 * resolution (tests, and the settings surface that renders a registered tool).
 * Production registration passes nothing, so the grant is read here.
 */
export function createSkillTool(
  entry: SkillToolEntry,
  skillDir: string,
  versionHash: string,
  capabilities?: SkillCapabilities,
  pluginOwner?: string,
): Tool {
  const skillId = basename(skillDir);
  const lookup = { skillId, versionHash };

  // The dynamic computer-use target decides whether a virtual-desktop call is
  // sandbox (a channel cell may lift it) or host (it never is). It needs an
  // answer before execution, so it reads the resolved grant synchronously and
  // keeps the manifest target when the grant is not known yet: that target is
  // the fail-closed side of the routing decision. The same name convention
  // `resolveExecutionTarget` uses for its host fallback identifies the tools.
  const isComputerUseCandidate =
    !pluginOwner && entry.name.startsWith("computer_use_");

  function resolveComputerUseTarget(
    input: Record<string, unknown>,
    context?: ToolContext,
  ): ExecutionTarget {
    const granted =
      capabilities?.computer_use_target === true ||
      getCachedSkillCapabilities(lookup).computer_use_target;
    return granted
      ? computerUseExecutionTarget(input, context)
      : (entry.execution_target as ExecutionTarget);
  }

  return {
    name: entry.name,
    description: entry.description,
    category: entry.category,
    defaultRiskLevel: riskMap[entry.risk],
    executionTarget: entry.execution_target as ExecutionTarget,
    ...(isComputerUseCandidate
      ? { getExecutionTarget: resolveComputerUseTarget }
      : {}),
    supportedClientOs: entry.supported_client_os,

    input_schema: entry.input_schema as object,

    async execute(
      input: Record<string, unknown>,
      context: ToolContext,
    ): Promise<ToolExecutionResult> {
      const granted = capabilities ?? (await getSkillCapabilities(lookup));

      // Validate against the schema the model was actually shown: tool
      // definitions carry an injected `activity` field the manifest does not
      // declare, and a call that fills it must not be rejected as unknown.
      const schema = withActivityProperty(
        entry.input_schema as Record<string, unknown> | undefined,
      );
      // Tool-specific repairs first: they rewrite keys and shapes the schema
      // does not describe, and the generic coercions below then see the
      // declared parameter names. Repairs describe first-party tools, so only
      // skills granted `input_repairs` consult them.
      const repairedInput = granted.input_repairs
        ? bundledToolInputRepairs(entry.name, input)
        : input;
      const withBooleans = coerceStringBooleans(repairedInput, schema);
      const withNumbers = coerceStringNumbers(withBooleans, schema);
      const coercedInput = coerceArrayShapes(withNumbers, schema);
      const validation = validateInputAgainstSchema(
        entry.name,
        coercedInput,
        schema,
      );
      if (!validation.ok) {
        // A parameter shape with its own redirect (e.g. a file path passed to
        // `subagent_read`) answers with that redirect: the generic "Unknown
        // parameter" list names the accepted keys but not the tool the caller
        // is actually reaching for. Redirects describe first-party tools, so
        // only skills granted `input_repairs` consult them. A managed,
        // workspace, extra, or plugin skill that reuses a bundled tool name
        // keeps the generic error, which is the one that matches its own
        // manifest.
        const misuse = granted.input_repairs
          ? bundledToolInputMisuseMessage(entry.name, coercedInput)
          : undefined;
        const repairsNote = granted.input_repairs
          ? ""
          : ` Input repairs are not applied: this skill version (${versionHash}) has no input_repairs grant.`;
        return {
          content:
            misuse ??
            `Invalid input for tool "${entry.name}": ${validation.errors.join("; ")}. If skill_load is available, load the owning skill for its current instructions. Retry with arguments matching this schema.${repairsNote}\n\n${formatSkillInputSchema(entry.input_schema)}`,
          isError: true,
        };
      }

      return runSkillToolScript(
        skillDir,
        entry.executor,
        coercedInput,
        context,
        {
          target: entry.execution_target,
          expectedSkillVersionHash: versionHash,
          hostExecAllowed: granted.host_exec === true,
          pluginOwner,
        },
      );
    },
  };
}

/**
 * Create runtime Tool objects from all entries in a manifest.
 * The caller is responsible for passing the resulting array to
 * `registerSkillTools(skillId, tools, registration)`, which is where
 * ownership and the content version are recorded.
 */
export function createSkillToolsFromManifest(
  entries: SkillToolEntry[],
  skillDir: string,
  versionHash: string,
  capabilities?: SkillCapabilities,
  pluginOwner?: string,
): Tool[] {
  return entries.map((entry) =>
    createSkillTool(entry, skillDir, versionHash, capabilities, pluginOwner),
  );
}
