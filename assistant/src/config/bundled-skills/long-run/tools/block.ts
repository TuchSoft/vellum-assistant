import type {
  ToolContext,
  ToolExecutionResult,
} from "../../../../tools/types.js";
import { longRunBlock } from "./longrun-core.js";

export async function run(
  input: Record<string, unknown>,
  context: ToolContext,
): Promise<ToolExecutionResult> {
  return longRunBlock(input, context);
}
