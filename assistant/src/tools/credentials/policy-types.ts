/**
 * Credential injection types.
 *
 * These types describe how a stored credential value is injected into an
 * outbound proxied request.
 */

/** How a credential value is injected into an outbound proxied request. */
export type CredentialInjectionType = "header" | "query";

/** Reference to another credential whose value is composed with the primary value. */
export interface CredentialComposeRef {
  /** Service of the credential to compose with. */
  service: string;
  /** Field of the credential to compose with. */
  field: string;
  /** Separator between the primary and composed values (e.g. ":"). */
  separator: string;
}

/** Transform applied to a credential value after composition. */
export type CredentialValueTransform = "base64";

/**
 * Describes where and how to inject a credential into proxied requests
 * matching a specific host pattern.
 */
export interface CredentialInjectionTemplate {
  /** Glob pattern for matching request hosts (e.g. "*.fal.ai"). */
  hostPattern: string;
  /** Where the credential value is injected. */
  injectionType: CredentialInjectionType;
  /** Header name when injectionType is 'header' (e.g. "Authorization"). */
  headerName?: string;
  /** Prefix prepended to the secret value (e.g. "Key ", "Bearer "). */
  valuePrefix?: string;
  /** Query parameter name when injectionType is 'query'. */
  queryParamName?: string;
  /**
   * Compose this credential's value with another credential's value before injection.
   * The result is `{primaryValue}{separator}{composedValue}`, optionally transformed
   * by `valueTransform`.
   */
  composeWith?: CredentialComposeRef;
  /**
   * Transform applied to the (possibly composed) value before prepending `valuePrefix`.
   * Applied after composition.
   */
  valueTransform?: CredentialValueTransform;
}
