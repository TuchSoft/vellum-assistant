import { basename, join, resolve } from "node:path";

import { computeSkillVersionHash } from "../../skills/version-hash.js";
import { isAbortLikeError } from "../shared/abort.js";
import type { ExecutionTarget } from "../tool-types.js";
import type { ToolContext, ToolExecutionResult } from "../types.js";
import { runSkillToolScriptSandbox } from "./sandbox-runner.js";
import type { SkillToolScript } from "./script-contract.js";

export interface RunSkillToolScriptOptions {
  /** Where to execute: 'host' runs in-process, 'sandbox' runs in an isolated subprocess. */
  target?: ExecutionTarget;
  /** Timeout in ms for sandbox execution. Ignored for host execution. */
  timeoutMs?: number;
  /** The skill version hash that was valid at approval time. When set, the runner
   *  verifies the skill hasn't changed since the user approved it and blocks
   *  execution on mismatch. */
  expectedSkillVersionHash?: string;
  /** Function to compute the current version hash for a skill directory. Defaults
   *  to `computeSkillVersionHash` from the version-hash module. Provided as an
   *  option to support testing and custom resolution strategies. */
  skillDirHashResolver?: (skillDir: string) => string;
  /** Whether this skill version is granted `host_exec`. Only a granted skill may
   *  run with `execution_target: host` (in-process); every other skill is forced
   *  to execute in the sandbox. */
  hostExecAllowed?: boolean;
  /**
   * Catalog owner id when this skill is plugin-resident. The sandbox runner
   * sets VELLUM_PLUGIN_NAME so the child can resolve credentials under
   * that plugin's service.
   */
  pluginOwner?: string;
}

/**
 * Execute a skill tool script on the host backend.
 * Dynamically imports the script file and calls its exported `run()` function.
 */
export async function runSkillToolScript(
  skillDir: string,
  executorPath: string,
  input: Record<string, unknown>,
  context: ToolContext,
  options?: RunSkillToolScriptOptions,
): Promise<ToolExecutionResult> {
  if (options?.target === "sandbox") {
    return runSkillToolScriptSandbox(skillDir, executorPath, input, context, {
      timeoutMs: options.timeoutMs,
      expectedSkillVersionHash: options.expectedSkillVersionHash,
      skillDirHashResolver: options.skillDirHashResolver,
      pluginOwner: options.pluginOwner,
    });
  }

  // Host execution dynamically imports the executor into the daemon process —
  // full host code execution with no sandbox boundary. The capability is a
  // grant the gateway holds for this exact skill content version
  // (`host_exec`): declaring `execution_target: host` in the manifest is a
  // request, not a permission, and `bundled` is provenance rather than trust.
  // Every skill without the grant is refused, whatever its origin.
  if (options?.target === "host" && !options?.hostExecAllowed) {
    const skillId = basename(resolve(skillDir));
    const version = options?.expectedSkillVersionHash ?? "this version";
    return {
      content: `Skill tool "${executorPath}" requests host execution, but this skill version has no host_exec grant. Capabilities are granted per skill version in the gateway: grant host_exec to "${skillId}" at version ${version} (PUT /v1/permissions/skill-grants/${skillId}), or declare execution_target: "sandbox".`,
      isError: true,
    };
  }

  const scriptPath = resolve(join(skillDir, executorPath));
  const resolvedSkillDir = resolve(skillDir) + "/";
  if (!scriptPath.startsWith(resolvedSkillDir)) {
    return {
      content: `Skill tool script path "${executorPath}" escapes the skill directory`,
      isError: true,
    };
  }

  // Block execution if the skill has been modified since approval.
  if (options?.expectedSkillVersionHash) {
    const resolver = options.skillDirHashResolver ?? computeSkillVersionHash;
    let currentHash: string;
    try {
      currentHash = resolver(resolvedSkillDir);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      return {
        content: `Failed to compute skill version hash for "${resolvedSkillDir}": ${message}`,
        isError: true,
      };
    }
    if (currentHash !== options.expectedSkillVersionHash) {
      return {
        content: `Skill version mismatch: expected ${options.expectedSkillVersionHash} but current is ${currentHash}. The skill has been modified since it was approved. Please reload the skill to re-approve.`,
        isError: true,
      };
    }
  }

  let module: SkillToolScript;
  try {
    module = await import(scriptPath);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return {
      content: `Failed to load skill tool script "${executorPath}": ${message}`,
      isError: true,
    };
  }

  if (typeof module.run !== "function") {
    return {
      content: `Skill tool script "${executorPath}" does not export a "run" function`,
      isError: true,
    };
  }

  try {
    return await module.run(input, context);
  } catch (err) {
    // A cancellation is not a script failure. Re-throw it so the tool executor
    // classifies the call as cancelled instead of reporting the abort reason
    // as an opaque script error.
    if (isAbortLikeError(err)) {
      throw err;
    }
    const message = err instanceof Error ? err.message : String(err);
    return {
      content: `Skill tool script "${executorPath}" threw an error: ${message}`,
      isError: true,
    };
  }
}
