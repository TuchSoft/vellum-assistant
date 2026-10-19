import { knownAliases, resolveEffectiveModel } from "../config/llm-resolver.js";
import { getConfig } from "../config/loader.js";
import {
  type DurableModelFields,
  resolveDurableModel,
} from "../persistence/conversation-crud.js";

/**
 * Validate a schedule's model alias against the gateway catalog. Returns a
 * user-facing error message when the alias is unknown, or `null` when valid.
 *
 * Only create/update paths validate. An alias removed after a schedule was
 * pinned to it surfaces as a resolution error at run time.
 */
export function validateScheduleModel(model: string): string | null {
  const alias = model.trim();
  if (alias.length === 0) {
    return "Model alias must not be empty.";
  }
  const { llm } = getConfig();
  if (knownAliases(llm).includes(alias)) {
    return null;
  }
  return `Model "${alias}" is not in the gateway catalog. Use an alias reported by GET /v1/llm/catalog.`;
}

/**
 * The alias a schedule is pinned to when its creator names none.
 *
 * Snapshotting the resolved default at write time keeps the schedule on the
 * model it was created under, even if the workspace default changes later.
 */
export function resolveDefaultScheduleModel(): string {
  const { llm } = getConfig();
  return resolveEffectiveModel("mainAgent", llm)?.model ?? llm.defaultModel;
}

/**
 * The alias a wake schedule pins when its creator names none.
 *
 * A wake resumes an existing conversation and forces the row's pin as the
 * woken turn's model, so the target conversation's own choice is what the
 * user expects it to fire on. A target with no durable pin falls through to
 * the same default every other schedule snapshots.
 */
export function resolveWakeScheduleModel(
  target: DurableModelFields | null,
): string {
  return resolveDurableModel(target) ?? resolveDefaultScheduleModel();
}

/** Render a schedule's pinned model for CLI and tool output. */
export function formatScheduleModel(model: string | null): string {
  return model ?? "none (default model)";
}
