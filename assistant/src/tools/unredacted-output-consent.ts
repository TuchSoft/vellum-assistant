/**
 * Unredacted-output consent key: the escape hatch a model can set on any
 * tool invocation to request that the tool result skip secret redaction.
 * The request is never self-granting: the executor forces an interactive
 * user consent prompt for that invocation (bypassing every auto-approve
 * path, including full-access posture) and skips redaction only when the
 * user explicitly approves the prompt.
 *
 * The key is deliberately long and self-describing so that setting it is a
 * deliberate act that reads unmistakably in logs and consent prompts.
 */

export const UNREDACTED_OUTPUT_CONSENT_KEY =
  "i_have_explicit_user_consent_to_show_secrets_unredacted";

export interface UnredactedConsentExtraction {
  /** Input without the consent key, safe to hand to the tool. */
  input: Record<string, unknown>;
  /** True only when the key was present with boolean value true. */
  requested: boolean;
}

/**
 * Extract and strip the consent key from raw tool input before any schema
 * validation runs (registered Zod schemas would silently drop unknown keys,
 * and the tool itself must never see the key).
 */
export function extractUnredactedOutputConsent(
  input: Record<string, unknown>,
): UnredactedConsentExtraction {
  if (input[UNREDACTED_OUTPUT_CONSENT_KEY] !== true) {
    return { input, requested: false };
  }
  const { [UNREDACTED_OUTPUT_CONSENT_KEY]: _consentKey, ...rest } = input;
  return { input: rest, requested: true };
}
