/**
 * Suggested prompt producer for the Home feed.
 *
 * Permanently disabled by custom patch 06: the Home feed never requests
 * assistant-generated suggestion prompts, so no LLM call happens for this
 * feature and no prompts are ever served.
 */

import type { SuggestedPrompt } from "./feed-types.js";

export async function getSuggestedPrompts(): Promise<SuggestedPrompt[]> {
  return [];
}

export async function refreshAssistantSuggestedPrompts(): Promise<boolean> {
  return false;
}
