import type { SkillCapabilities } from "@vellumai/service-contracts/skill-capabilities";

import type { SkillToolEntry } from "../../config/skills.js";
import { RiskLevel } from "../../permissions/types.js";
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
 * `capabilities` is the resolved capability set for this skill version. It
 * gates host execution, first-party input repairs, and the dynamic
 * computer-use target.
 */
export function createSkillTool(
  entry: SkillToolEntry,
  skillDir: string,
  versionHash: string,
  capabilities?: SkillCapabilities,
  pluginOwner?: string,
): Tool {
  const isComputerUse =
    capabilities?.computer_use_target === true && !pluginOwner;
  return {
    name: entry.name,
    description: entry.description,
    category: entry.category,
    defaultRiskLevel: riskMap[entry.risk],
    executionTarget: entry.execution_target as ExecutionTarget,
    ...(isComputerUse
      ? { getExecutionTarget: computerUseExecutionTarget }
      : {}),
    supportedClientOs: entry.supported_client_os,

    input_schema: entry.input_schema as object,

    async execute(
      input: Record<string, unknown>,
      context: ToolContext,
    ): Promise<ToolExecutionResult> {
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
      const repairedInput = capabilities?.input_repairs
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
        const misuse = capabilities?.input_repairs
          ? bundledToolInputMisuseMessage(entry.name, coercedInput)
          : undefined;
        return {
          content:
            misuse ??
            `Invalid input for tool "${entry.name}": ${validation.errors.join("; ")}. If skill_load is available, load the owning skill for its current instructions. Retry with arguments matching this schema.\n\n${formatSkillInputSchema(entry.input_schema)}`,
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
          hostExecAllowed: capabilities?.host_exec === true,
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
