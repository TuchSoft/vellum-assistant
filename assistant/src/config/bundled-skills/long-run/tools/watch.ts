import type {
  ToolContext,
  ToolExecutionResult,
} from "../../../../tools/types.js";
import { longRunWatch } from "./longrun-core.js";

export async function run(
  input: Record<string, unknown>,
  context: ToolContext,
): Promise<ToolExecutionResult> {
  return longRunWatch(input, context);
}
