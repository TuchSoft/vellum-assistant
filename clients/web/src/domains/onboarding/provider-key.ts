import type { OnboardingProviderId } from "@/domains/onboarding/provider-catalog";

// Model-provider API key collected during onboarding. Held in sessionStorage
// (consume-once) between the API-key step and the post-hatch application.
// Inference now runs through the LLM gateway, whose upstream keys live on the
// gateway, so the value is collected for UI continuity only.

const PENDING_KEY_STORAGE = "onboarding.providerKey";

export interface PendingProviderKey {
  provider: OnboardingProviderId;
  /** Empty for keyless providers (e.g. Ollama). */
  key: string;
  /** Selected model for the initial local assistant profile. */
  model?: string;
  /** Base URL for openai-compatible providers. */
  baseUrl?: string;
  /** Comma-separated model identifiers for openai-compatible providers. */
  customModels?: string;
}

export function setPendingProviderKey(value: PendingProviderKey | null): void {
  try {
    if (value === null) {
      sessionStorage.removeItem(PENDING_KEY_STORAGE);
      return;
    }
    sessionStorage.setItem(PENDING_KEY_STORAGE, JSON.stringify(value));
  } catch {
    // Storage unavailable (private mode / quota) — degrade silently.
  }
}

function isPendingProviderKey(value: unknown): value is PendingProviderKey {
  return (
    value !== null &&
    typeof value === "object" &&
    "provider" in value &&
    typeof value.provider === "string" &&
    "key" in value &&
    typeof value.key === "string" &&
    (!("model" in value) || typeof value.model === "string") &&
    (!("baseUrl" in value) || typeof value.baseUrl === "string") &&
    (!("customModels" in value) || typeof value.customModels === "string")
  );
}

export function peekPendingProviderKey(): PendingProviderKey | null {
  try {
    const raw = sessionStorage.getItem(PENDING_KEY_STORAGE);
    if (!raw) {
      return null;
    }
    const parsed: unknown = JSON.parse(raw);
    return isPendingProviderKey(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

export function consumePendingProviderKey(): PendingProviderKey | null {
  const value = peekPendingProviderKey();
  try {
    sessionStorage.removeItem(PENDING_KEY_STORAGE);
  } catch {
    // ignore
  }
  return value;
}

export class ProviderKeyRejectedError extends Error {
  readonly provider: OnboardingProviderId;
  readonly reason?: string;

  constructor(provider: OnboardingProviderId, reason?: string) {
    super(reason ?? `${provider} rejected the API key`);
    this.name = "ProviderKeyRejectedError";
    this.provider = provider;
    this.reason = reason;
  }
}

/**
 * Consume the onboarding selection. Inference runs through the gateway, so
 * there is no per-provider credential or profile to write to the assistant.
 */
export async function applyPendingProviderKey(
  _assistantId: string,
): Promise<void> {
  consumePendingProviderKey();
}
