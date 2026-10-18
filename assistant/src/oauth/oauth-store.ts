/**
 * CRUD store for OAuth providers, apps, and connections.
 *
 * Backed by Drizzle over the async Postgres facade. All JSON fields
 * (default_scopes, available_scopes, extra_params, granted_scopes, metadata)
 * are stored as serialized JSON strings.
 *
 * Note: TS field names use camelCase from the platform's naming
 * (provider, authorizeUrl, tokenExchangeUrl, displayLabel, authorizeParams),
 * while underlying SQL columns retain their original snake_case names
 * (provider_key, auth_url, token_url, display_name, extra_params).
 */

import {
  deleteOAuthTokens,
  oauthAppClientSecretPath,
  oauthConnectionAccessTokenPath,
  type SecureKeyBackend,
} from "@vellumai/credential-storage";
import { and, desc, eq, or, sql } from "drizzle-orm";
import { v4 as uuid } from "uuid";

import { invalidateAssistantSuggestedPromptsCache } from "../home/suggested-prompts-cache.js";
import type { SchemaTables } from "../persistence/db-facade.js";
import { requireMainDb } from "../persistence/db-facade.js";
import {
  deleteSecureKeyAsync,
  getSecureKeyAsync,
  setSecureKeyAsync,
} from "../security/secure-keys.js";
import { getLogger } from "../util/logger.js";
import type { AvailableScopes } from "./connect-types.js";
import { getConnectionAccessTokenResult } from "./credential-token-resolver.js";
import { tryRevokeOAuthToken } from "./revoke.js";

const log = getLogger("oauth-store");

// ---------------------------------------------------------------------------
// Row types
// ---------------------------------------------------------------------------

export type OAuthProviderRow = SchemaTables["oauthProviders"]["$inferSelect"];
export type OAuthAppRow = SchemaTables["oauthApps"]["$inferSelect"];
export type OAuthConnectionRow =
  SchemaTables["oauthConnections"]["$inferSelect"];

// ---------------------------------------------------------------------------
// Provider operations
// ---------------------------------------------------------------------------

/**
 * Seed well-known provider profiles into the database. Uses INSERT … ON
 * CONFLICT DO UPDATE so that implementation fields (authorizeUrl, tokenExchangeUrl,
 * refreshUrl, tokenEndpointAuthMethod, userinfoUrl, authorizeParams,
 * pingUrl, pingMethod, pingHeaders, pingBody, revokeUrl, revokeBodyTemplate,
 * managedServiceConfigKey,
 * loopbackPort, injectionTemplates, appType, setupNotes,
 * identityUrl, identityMethod, identityHeaders, identityBody,
 * identityResponsePaths, identityFormat, identityOkField, responseOkField, featureFlag,
 * scopeSeparator, defaultScopes, availableScopes)
 * and display metadata (displayLabel, description, dashboardUrl,
 * clientIdPlaceholder, logoUrl, requiresClientSecret) propagate to existing
 * installations on every startup. baseUrl is backfilled from seed data when null
 * (e.g. legacy rows created before the column existed) but preserved
 * if the user has set a custom value.
 */
export async function seedProviders(
  profiles: Array<{
    provider: string;
    authorizeUrl: string;
    tokenExchangeUrl: string;
    refreshUrl?: string;
    tokenEndpointAuthMethod?: string;
    tokenExchangeBodyFormat?: string;
    userinfoUrl?: string;
    pingUrl?: string;
    pingMethod?: string;
    pingHeaders?: Record<string, string>;
    pingBody?: unknown;
    revokeUrl?: string;
    revokeBodyTemplate?: Record<string, string>;
    baseUrl?: string;
    defaultScopes: string[];
    availableScopes?: AvailableScopes;
    scopeSeparator?: string;
    authorizeParams?: Record<string, string>;
    managedServiceConfigKey?: string;
    managedServiceIsPaid?: boolean;
    displayLabel?: string;
    description?: string;
    dashboardUrl?: string | null;
    clientIdPlaceholder?: string | null;
    logoUrl?: string | null;
    requiresClientSecret?: boolean;
    loopbackPort?: number;
    injectionTemplates?: Array<{
      hostPattern: string;
      injectionType: string;
      headerName: string;
      valuePrefix: string;
    }>;
    appType?: string;
    setupNotes?: string[];
    identityUrl?: string;
    identityMethod?: string;
    identityHeaders?: Record<string, string>;
    identityBody?: unknown;
    identityResponsePaths?: string[];
    identityFormat?: string;
    identityOkField?: string;
    responseOkField?: string;
    featureFlag?: string;
  }>,
): Promise<void> {
  const db = requireMainDb();
  const providers = db.schema.oauthProviders;
  const now = Date.now();
  for (const p of profiles) {
    const authorizeUrl = p.authorizeUrl;
    const tokenExchangeUrl = p.tokenExchangeUrl;
    const refreshUrl = p.refreshUrl ?? null;
    // Coerce undefined and empty string to the default. The schema declares
    // this column as NOT NULL with default "client_secret_post"; passing null
    // here would be a type error, and an empty string is never a valid OAuth
    // token endpoint auth method.
    const tokenEndpointAuthMethod =
      p.tokenEndpointAuthMethod || "client_secret_post";
    const tokenExchangeBodyFormat = p.tokenExchangeBodyFormat || "form";
    const userinfoUrl = p.userinfoUrl ?? null;
    const pingUrl = p.pingUrl ?? null;
    const pingMethod = p.pingMethod ?? null;
    const pingHeaders = p.pingHeaders ? JSON.stringify(p.pingHeaders) : null;
    const pingBody =
      p.pingBody !== undefined ? JSON.stringify(p.pingBody) : null;
    const revokeUrl = p.revokeUrl ?? null;
    const revokeBodyTemplate = p.revokeBodyTemplate
      ? JSON.stringify(p.revokeBodyTemplate)
      : null;
    const baseUrl = p.baseUrl ?? null;
    const defaultScopes = JSON.stringify(p.defaultScopes);
    const availableScopes = p.availableScopes
      ? JSON.stringify(p.availableScopes)
      : null;
    // Coerce empty string to the default space separator. An empty separator
    // would join scopes into a single concatenated token (e.g. "readwrite"),
    // which is never a valid OAuth authorize URL value.
    const scopeSeparator = p.scopeSeparator || " ";
    const authorizeParams = p.authorizeParams
      ? JSON.stringify(p.authorizeParams)
      : null;
    const managedServiceConfigKey = p.managedServiceConfigKey ?? null;
    const managedServiceIsPaid = p.managedServiceIsPaid === true;
    const displayLabel = p.displayLabel ?? null;
    const description = p.description ?? null;
    const dashboardUrl = p.dashboardUrl ?? null;
    const clientIdPlaceholder = p.clientIdPlaceholder ?? null;
    const logoUrl = p.logoUrl ?? null;
    const requiresClientSecret = p.requiresClientSecret !== false ? 1 : 0;
    const loopbackPort = p.loopbackPort ?? null;
    const injectionTemplates = p.injectionTemplates
      ? JSON.stringify(p.injectionTemplates)
      : null;
    const appType = p.appType ?? null;
    const setupNotes = p.setupNotes ? JSON.stringify(p.setupNotes) : null;
    const identityUrl = p.identityUrl ?? null;
    const identityMethod = p.identityMethod ?? null;
    const identityHeaders = p.identityHeaders
      ? JSON.stringify(p.identityHeaders)
      : null;
    const identityBody =
      p.identityBody !== undefined ? JSON.stringify(p.identityBody) : null;
    const identityResponsePaths = p.identityResponsePaths
      ? JSON.stringify(p.identityResponsePaths)
      : null;
    const identityFormat = p.identityFormat ?? null;
    const identityOkField = p.identityOkField ?? null;
    const responseOkField = p.responseOkField ?? null;
    const featureFlag = p.featureFlag ?? null;

    await db.orm
      .insert(providers)
      .values({
        provider: p.provider,
        authorizeUrl,
        tokenExchangeUrl,
        refreshUrl,
        tokenEndpointAuthMethod,
        tokenExchangeBodyFormat,
        userinfoUrl,
        baseUrl,
        defaultScopes,
        availableScopes,
        scopeSeparator,
        authorizeParams,
        pingUrl,
        pingMethod,
        pingHeaders,
        pingBody,
        revokeUrl,
        revokeBodyTemplate,
        managedServiceConfigKey,
        managedServiceIsPaid,
        displayLabel,
        description,
        dashboardUrl,
        clientIdPlaceholder,
        logoUrl,
        requiresClientSecret,
        loopbackPort,
        injectionTemplates,
        appType,
        setupNotes,
        identityUrl,
        identityMethod,
        identityHeaders,
        identityBody,
        identityResponsePaths,
        identityFormat,
        identityOkField,
        responseOkField,
        featureFlag,
        createdAt: now,
        updatedAt: now,
      })
      .onConflictDoUpdate({
        target: providers.provider,
        set: {
          authorizeUrl,
          tokenExchangeUrl,
          refreshUrl,
          tokenEndpointAuthMethod,
          tokenExchangeBodyFormat,
          userinfoUrl,
          baseUrl: sql`COALESCE(${providers.baseUrl}, ${baseUrl})`,
          defaultScopes,
          availableScopes,
          scopeSeparator,
          authorizeParams,
          pingUrl,
          pingMethod,
          pingHeaders,
          pingBody,
          revokeUrl,
          revokeBodyTemplate,
          managedServiceConfigKey,
          managedServiceIsPaid,
          displayLabel,
          description,
          dashboardUrl,
          clientIdPlaceholder,
          logoUrl,
          requiresClientSecret,
          loopbackPort,
          injectionTemplates,
          appType,
          setupNotes,
          identityUrl,
          identityMethod,
          identityHeaders,
          identityBody,
          identityResponsePaths,
          identityFormat,
          identityOkField,
          responseOkField,
          featureFlag,
          updatedAt: now,
        },
      });
  }
}

/**
 * Rewrite a provider's stored base URL, but only when it still holds a known
 * stale default value. Existing installs are seeded with `COALESCE(baseUrl,
 * seedValue)`, so a corrected seed base URL never propagates on its own: a row
 * created with the old default keeps it forever. This targeted update advances
 * that specific stale value to the current default while leaving user-customized
 * base URLs (anything other than `staleBaseUrl`) untouched.
 *
 * Idempotent: once the row holds `nextBaseUrl` the WHERE clause matches nothing.
 * Returns the number of rows updated.
 */
export async function migrateProviderBaseUrl(params: {
  provider: string;
  staleBaseUrl: string;
  nextBaseUrl: string;
}): Promise<number> {
  const db = requireMainDb();
  const providers = db.schema.oauthProviders;
  const updated = await db.orm
    .update(providers)
    .set({ baseUrl: params.nextBaseUrl, updatedAt: Date.now() })
    .where(
      and(
        eq(providers.provider, params.provider),
        eq(providers.baseUrl, params.staleBaseUrl),
      ),
    )
    .returning({ id: providers.provider });
  return updated.length;
}

/** Look up a provider by its primary key. */
export async function getProvider(
  provider: string,
): Promise<OAuthProviderRow | undefined> {
  const db = requireMainDb();
  const providers = db.schema.oauthProviders;
  const rows = await db.orm
    .select()
    .from(providers)
    .where(eq(providers.provider, provider))
    .limit(1);
  return rows[0];
}

/** Return all registered providers. */
export async function listProviders(): Promise<OAuthProviderRow[]> {
  const db = requireMainDb();
  return await db.orm.select().from(db.schema.oauthProviders);
}

/**
 * Register a new provider (for dynamic registration). Throws if the
 * provider_key already exists.
 */
export async function registerProvider(params: {
  provider: string;
  authorizeUrl: string;
  tokenExchangeUrl: string;
  refreshUrl?: string;
  tokenEndpointAuthMethod?: string;
  tokenExchangeBodyFormat?: string;
  userinfoUrl?: string;
  pingUrl?: string;
  pingMethod?: string;
  pingHeaders?: Record<string, string>;
  pingBody?: unknown;
  revokeUrl?: string;
  revokeBodyTemplate?: Record<string, string>;
  baseUrl?: string;
  defaultScopes: string[];
  availableScopes?: AvailableScopes;
  scopeSeparator?: string;
  authorizeParams?: Record<string, string>;
  managedServiceConfigKey?: string;
  managedServiceIsPaid?: boolean;
  displayLabel?: string;
  description?: string;
  dashboardUrl?: string;
  clientIdPlaceholder?: string;
  logoUrl?: string | null;
  requiresClientSecret?: number;
  loopbackPort?: number;
  injectionTemplates?: Array<{
    hostPattern: string;
    injectionType: string;
    headerName: string;
    valuePrefix: string;
  }>;
  appType?: string;
  setupNotes?: string[];
  identityUrl?: string;
  identityMethod?: string;
  identityHeaders?: Record<string, string>;
  identityBody?: unknown;
  identityResponsePaths?: string[];
  identityFormat?: string;
  identityOkField?: string;
  responseOkField?: string;
  featureFlag?: string;
}): Promise<OAuthProviderRow> {
  const db = requireMainDb();
  const providers = db.schema.oauthProviders;
  const now = Date.now();

  const existing = await getProvider(params.provider);
  if (existing) {
    throw new Error(`OAuth provider already exists: ${params.provider}`);
  }

  const row = {
    provider: params.provider,
    authorizeUrl: params.authorizeUrl,
    tokenExchangeUrl: params.tokenExchangeUrl,
    refreshUrl: params.refreshUrl ?? null,
    tokenEndpointAuthMethod:
      params.tokenEndpointAuthMethod || "client_secret_post",
    tokenExchangeBodyFormat: params.tokenExchangeBodyFormat || "form",
    userinfoUrl: params.userinfoUrl ?? null,
    baseUrl: params.baseUrl ?? null,
    defaultScopes: JSON.stringify(params.defaultScopes),
    availableScopes: params.availableScopes
      ? JSON.stringify(params.availableScopes)
      : null,
    // Coerce empty string to the default space separator (see seedProviders).
    scopeSeparator: params.scopeSeparator || " ",
    authorizeParams: params.authorizeParams
      ? JSON.stringify(params.authorizeParams)
      : null,
    pingUrl: params.pingUrl ?? null,
    pingMethod: params.pingMethod ?? null,
    pingHeaders: params.pingHeaders ? JSON.stringify(params.pingHeaders) : null,
    pingBody:
      params.pingBody !== undefined ? JSON.stringify(params.pingBody) : null,
    revokeUrl: params.revokeUrl ?? null,
    revokeBodyTemplate: params.revokeBodyTemplate
      ? JSON.stringify(params.revokeBodyTemplate)
      : null,
    managedServiceConfigKey: params.managedServiceConfigKey ?? null,
    managedServiceIsPaid: params.managedServiceIsPaid === true,
    displayLabel: params.displayLabel ?? null,
    description: params.description ?? null,
    dashboardUrl: params.dashboardUrl ?? null,
    clientIdPlaceholder: params.clientIdPlaceholder ?? null,
    logoUrl: params.logoUrl ?? null,
    requiresClientSecret: params.requiresClientSecret ?? 1,
    loopbackPort: params.loopbackPort ?? null,
    injectionTemplates: params.injectionTemplates
      ? JSON.stringify(params.injectionTemplates)
      : null,
    appType: params.appType ?? null,
    setupNotes: params.setupNotes ? JSON.stringify(params.setupNotes) : null,
    identityUrl: params.identityUrl ?? null,
    identityMethod: params.identityMethod ?? null,
    identityHeaders: params.identityHeaders
      ? JSON.stringify(params.identityHeaders)
      : null,
    identityBody:
      params.identityBody !== undefined
        ? JSON.stringify(params.identityBody)
        : null,
    identityResponsePaths: params.identityResponsePaths
      ? JSON.stringify(params.identityResponsePaths)
      : null,
    identityFormat: params.identityFormat ?? null,
    identityOkField: params.identityOkField ?? null,
    responseOkField: params.responseOkField ?? null,
    featureFlag: params.featureFlag ?? null,
    createdAt: now,
    updatedAt: now,
  };

  await db.orm.insert(providers).values(row);

  return row;
}

/**
 * Update mutable fields on an existing provider. Only the fields explicitly
 * provided (not `undefined`) are written; everything else is left unchanged.
 * JSON fields (defaultScopes, availableScopes, authorizeParams, pingHeaders, pingBody)
 * are serialized with JSON.stringify before storage.
 *
 * Returns the updated provider row, or `undefined` if no provider with the
 * given key exists.
 */
export async function updateProvider(
  provider: string,
  params: Partial<{
    authorizeUrl: string;
    tokenExchangeUrl: string;
    refreshUrl: string;
    tokenEndpointAuthMethod: string;
    tokenExchangeBodyFormat: string;
    userinfoUrl: string;
    pingUrl: string;
    pingMethod: string;
    pingHeaders: Record<string, string>;
    pingBody: unknown;
    revokeUrl: string | null;
    revokeBodyTemplate: Record<string, string> | null;
    baseUrl: string;
    defaultScopes: string[];
    availableScopes: AvailableScopes | null;
    scopeSeparator: string;
    authorizeParams: Record<string, string>;
    displayLabel: string;
    description: string;
    dashboardUrl: string;
    clientIdPlaceholder: string;
    logoUrl: string | null;
    requiresClientSecret: boolean;
    loopbackPort: number;
    injectionTemplates: Array<{
      hostPattern: string;
      injectionType: string;
      headerName: string;
      valuePrefix: string;
    }>;
    appType: string;
    setupNotes: string[];
    identityUrl: string;
    identityMethod: string;
    identityHeaders: Record<string, string>;
    identityBody: unknown;
    identityResponsePaths: string[];
    identityFormat: string;
    identityOkField: string;
    responseOkField: string;
    featureFlag: string;
    managedServiceIsPaid: boolean;
  }>,
): Promise<OAuthProviderRow | undefined> {
  const existing = await getProvider(provider);
  if (!existing) {
    return undefined;
  }

  const db = requireMainDb();
  const providers = db.schema.oauthProviders;
  const set: Partial<SchemaTables["oauthProviders"]["$inferInsert"]> = {
    updatedAt: Date.now(),
  };

  if (params.authorizeUrl !== undefined) {
    set.authorizeUrl = params.authorizeUrl;
  }
  if (params.tokenExchangeUrl !== undefined) {
    set.tokenExchangeUrl = params.tokenExchangeUrl;
  }
  if (params.refreshUrl !== undefined) {
    set.refreshUrl = params.refreshUrl;
  }
  if (params.tokenEndpointAuthMethod !== undefined) {
    set.tokenEndpointAuthMethod =
      params.tokenEndpointAuthMethod || "client_secret_post";
  }
  if (params.tokenExchangeBodyFormat !== undefined) {
    set.tokenExchangeBodyFormat = params.tokenExchangeBodyFormat || "form";
  }
  if (params.userinfoUrl !== undefined) {
    set.userinfoUrl = params.userinfoUrl;
  }
  if (params.pingUrl !== undefined) {
    set.pingUrl = params.pingUrl;
  }
  if (params.pingMethod !== undefined) {
    set.pingMethod = params.pingMethod;
  }
  if (params.pingHeaders !== undefined) {
    set.pingHeaders = JSON.stringify(params.pingHeaders);
  }
  if (params.pingBody !== undefined) {
    set.pingBody = JSON.stringify(params.pingBody);
  }
  if (params.revokeUrl !== undefined) {
    set.revokeUrl = params.revokeUrl;
  }
  if (params.revokeBodyTemplate !== undefined) {
    set.revokeBodyTemplate =
      params.revokeBodyTemplate === null
        ? null
        : JSON.stringify(params.revokeBodyTemplate);
  }
  if (params.baseUrl !== undefined) {
    set.baseUrl = params.baseUrl;
  }
  if (params.defaultScopes !== undefined) {
    set.defaultScopes = JSON.stringify(params.defaultScopes);
  }
  if (params.availableScopes !== undefined) {
    set.availableScopes =
      params.availableScopes === null
        ? null
        : JSON.stringify(params.availableScopes);
  }
  if (
    params.scopeSeparator !== undefined
  ) // Coerce empty string to the default space separator (see seedProviders).
  {
    set.scopeSeparator = params.scopeSeparator || " ";
  }
  if (params.authorizeParams !== undefined) {
    set.authorizeParams = JSON.stringify(params.authorizeParams);
  }
  if (params.displayLabel !== undefined) {
    set.displayLabel = params.displayLabel;
  }
  if (params.description !== undefined) {
    set.description = params.description;
  }
  if (params.dashboardUrl !== undefined) {
    set.dashboardUrl = params.dashboardUrl;
  }
  if (params.clientIdPlaceholder !== undefined) {
    set.clientIdPlaceholder = params.clientIdPlaceholder;
  }
  if (params.logoUrl !== undefined) {
    set.logoUrl = params.logoUrl;
  }
  if (params.requiresClientSecret !== undefined) {
    set.requiresClientSecret = params.requiresClientSecret ? 1 : 0;
  }
  if (params.loopbackPort !== undefined) {
    set.loopbackPort = params.loopbackPort;
  }
  if (params.injectionTemplates !== undefined) {
    set.injectionTemplates = JSON.stringify(params.injectionTemplates);
  }
  if (params.appType !== undefined) {
    set.appType = params.appType;
  }
  if (params.setupNotes !== undefined) {
    set.setupNotes = JSON.stringify(params.setupNotes);
  }
  if (params.identityUrl !== undefined) {
    set.identityUrl = params.identityUrl;
  }
  if (params.identityMethod !== undefined) {
    set.identityMethod = params.identityMethod;
  }
  if (params.identityHeaders !== undefined) {
    set.identityHeaders = JSON.stringify(params.identityHeaders);
  }
  if (params.identityBody !== undefined) {
    set.identityBody = JSON.stringify(params.identityBody);
  }
  if (params.identityResponsePaths !== undefined) {
    set.identityResponsePaths = JSON.stringify(params.identityResponsePaths);
  }
  if (params.identityFormat !== undefined) {
    set.identityFormat = params.identityFormat;
  }
  if (params.identityOkField !== undefined) {
    set.identityOkField = params.identityOkField;
  }
  if (params.responseOkField !== undefined) {
    set.responseOkField = params.responseOkField;
  }
  if (params.featureFlag !== undefined) {
    set.featureFlag = params.featureFlag;
  }
  if (params.managedServiceIsPaid !== undefined) {
    set.managedServiceIsPaid = params.managedServiceIsPaid;
  }

  await db.orm
    .update(providers)
    .set(set)
    .where(eq(providers.provider, provider));

  return await getProvider(provider);
}

/**
 * Delete a provider by its key. Returns `true` if a row was deleted,
 * `false` if no provider with that key existed.
 *
 * Note: Postgres enforces the foreign-key constraint from `oauth_apps.provider_key`,
 * so deleting a provider that has existing apps will throw.
 */
export async function deleteProvider(provider: string): Promise<boolean> {
  const existing = await getProvider(provider);
  if (!existing) {
    return false;
  }

  const db = requireMainDb();
  const providers = db.schema.oauthProviders;
  const deleted = await db.orm
    .delete(providers)
    .where(eq(providers.provider, provider))
    .returning({ id: providers.provider });
  return deleted.length > 0;
}

// ---------------------------------------------------------------------------
// App operations
// ---------------------------------------------------------------------------

/**
 * Insert or return an existing app by (provider_key, client_id).
 * Generates a UUID on insert.
 */
export async function upsertApp(
  provider: string,
  clientId: string,
  clientSecretOpts?: {
    clientSecretValue?: string;
    clientSecretCredentialPath?: string;
  },
): Promise<OAuthAppRow> {
  const { clientSecretValue, clientSecretCredentialPath } =
    clientSecretOpts ?? {};

  if (clientSecretValue && clientSecretCredentialPath) {
    throw new Error(
      "Cannot provide both clientSecretValue and clientSecretCredentialPath",
    );
  }

  // Verify the credential path points to an existing secret.
  if (clientSecretCredentialPath) {
    const existing = await getSecureKeyAsync(clientSecretCredentialPath);
    if (existing === undefined) {
      throw new Error(
        `No secret found at credential path: ${clientSecretCredentialPath}`,
      );
    }
  }

  const db = requireMainDb();
  const apps = db.schema.oauthApps;

  const existingRows = await db.orm
    .select()
    .from(apps)
    .where(and(eq(apps.provider, provider), eq(apps.clientId, clientId)))
    .limit(1);
  const existingRow = existingRows[0];

  if (existingRow) {
    if (clientSecretValue) {
      const stored = await setSecureKeyAsync(
        existingRow.clientSecretCredentialPath,
        clientSecretValue,
      );
      if (!stored) {
        throw new Error("Failed to store client_secret in secure storage");
      }
      // Bump updatedAt so the rollback guard in the new-row insertion path
      // can detect that a concurrent caller has claimed this row. Without
      // this, a concurrent inserter's rollback DELETE would still match on
      // the original updatedAt and delete the row we just validated.
      const newUpdatedAt = Date.now();
      await db.orm
        .update(apps)
        .set({ updatedAt: newUpdatedAt })
        .where(eq(apps.id, existingRow.id));
      return { ...existingRow, updatedAt: newUpdatedAt };
    }
    if (clientSecretCredentialPath) {
      await db.orm
        .update(apps)
        .set({
          clientSecretCredentialPath,
          updatedAt: Date.now(),
        })
        .where(eq(apps.id, existingRow.id));
      const refreshed = await db.orm
        .select()
        .from(apps)
        .where(eq(apps.id, existingRow.id))
        .limit(1);
      return refreshed[0]!;
    }
    return existingRow;
  }

  const now = Date.now();
  const id = uuid();
  const credPath = clientSecretCredentialPath ?? oauthAppClientSecretPath(id);

  const row = {
    id,
    provider,
    clientId,
    clientSecretCredentialPath: credPath,
    createdAt: now,
    updatedAt: now,
  };

  // Insert the DB row first so that a failed insert doesn't leave an
  // orphaned secret in secure storage.
  await db.orm.insert(apps).values(row);

  if (clientSecretValue) {
    const stored = await setSecureKeyAsync(credPath, clientSecretValue);
    if (!stored) {
      // Roll back the just-inserted row to avoid an orphaned app pointing
      // at a non-existent client_secret in secure storage.
      //
      // Guard: only delete if updatedAt still matches our insertion timestamp.
      // A concurrent upsertApp call may have observed this row, successfully
      // stored the secret, and updated the row, deleting it would orphan that
      // caller's valid reference.
      await db.orm
        .delete(apps)
        .where(and(eq(apps.id, id), eq(apps.updatedAt, now)));
      throw new Error("Failed to store client_secret in secure storage");
    }
  }

  return row;
}

/** Look up an app by its primary key. */
export async function getApp(id: string): Promise<OAuthAppRow | undefined> {
  const db = requireMainDb();
  const apps = db.schema.oauthApps;
  const rows = await db.orm.select().from(apps).where(eq(apps.id, id)).limit(1);
  return rows[0];
}

/** Read an app client_secret from secure storage. */
export async function getAppClientSecret(
  appOrId: OAuthAppRow | string,
): Promise<string | undefined> {
  const app = typeof appOrId === "string" ? await getApp(appOrId) : appOrId;
  if (!app) {
    return undefined;
  }
  return getSecureKeyAsync(app.clientSecretCredentialPath);
}

/** Look up an app by (provider_key, client_id). */
export async function getAppByProviderAndClientId(
  provider: string,
  clientId: string,
): Promise<OAuthAppRow | undefined> {
  const db = requireMainDb();
  const apps = db.schema.oauthApps;
  const rows = await db.orm
    .select()
    .from(apps)
    .where(and(eq(apps.provider, provider), eq(apps.clientId, clientId)))
    .limit(1);
  return rows[0];
}

/**
 * Get the most recently created app for a provider.
 * Returns undefined if no app exists for this provider.
 */
export async function getMostRecentAppByProvider(
  provider: string,
): Promise<OAuthAppRow | undefined> {
  const db = requireMainDb();
  const apps = db.schema.oauthApps;
  const rows = await db.orm
    .select()
    .from(apps)
    .where(eq(apps.provider, provider))
    .orderBy(desc(apps.createdAt))
    .limit(1);
  return rows[0];
}

/** Return all OAuth apps. */
export async function listApps(): Promise<OAuthAppRow[]> {
  const db = requireMainDb();
  return await db.orm.select().from(db.schema.oauthApps);
}

/** Delete an app by ID. Cleans up the client_secret from secure storage. Returns true if a row was deleted. */
export async function deleteApp(id: string): Promise<boolean> {
  const db = requireMainDb();
  const apps = db.schema.oauthApps;

  const rows = await db.orm.select().from(apps).where(eq(apps.id, id)).limit(1);
  const app = rows[0];
  if (!app) {
    return false;
  }

  // Delete the DB row first so that if it fails (e.g. FK constraint from
  // existing connections), the secret in secure storage remains intact.
  await db.orm.delete(apps).where(eq(apps.id, id));

  const result = await deleteSecureKeyAsync(app.clientSecretCredentialPath);
  if (result === "error") {
    // Throw (rather than returning "error" like disconnectOAuthProvider) because
    // the DB row is already deleted above. The caller should surface this to the
    // user so they can retry or manually clean up the orphaned secret.
    throw new Error(
      `Deleted app ${id} but failed to remove client_secret from secure storage`,
    );
  }

  return true;
}

// ---------------------------------------------------------------------------
// Connection operations
// ---------------------------------------------------------------------------

/**
 * Create a new OAuth connection. Generates a UUID and sets status='active'.
 * `metadata` is an optional JSON object for provider-specific token response data.
 */
export async function createConnection(params: {
  oauthAppId: string;
  provider: string;
  accountInfo?: string;
  grantedScopes: string[];
  expiresAt?: number;
  hasRefreshToken: boolean;
  label?: string;
  metadata?: Record<string, unknown>;
  /** Override the creation timestamp. Useful in tests to ensure deterministic ordering. */
  createdAt?: number;
}): Promise<OAuthConnectionRow> {
  const db = requireMainDb();
  const connections = db.schema.oauthConnections;
  const now = params.createdAt ?? Date.now();
  const id = uuid();

  const row = {
    id,
    oauthAppId: params.oauthAppId,
    provider: params.provider,
    accountInfo: params.accountInfo ?? null,
    grantedScopes: JSON.stringify(params.grantedScopes),
    expiresAt: params.expiresAt ?? null,
    hasRefreshToken: params.hasRefreshToken ? 1 : 0,
    status: "active" as const,
    label: params.label ?? null,
    metadata: params.metadata ? JSON.stringify(params.metadata) : null,
    createdAt: now,
    updatedAt: now,
  };

  await db.orm.insert(connections).values(row);

  return row;
}

/** Look up a connection by its primary key. */
export async function getConnection(
  id: string,
): Promise<OAuthConnectionRow | undefined> {
  const db = requireMainDb();
  const connections = db.schema.oauthConnections;
  const rows = await db.orm
    .select()
    .from(connections)
    .where(eq(connections.id, id))
    .limit(1);
  return rows[0];
}

/**
 * Get the most recent active connection for a provider.
 *
 * Optional filters narrow the result:
 * - `account`: match an account label (e.g. email), then a connection ID when
 *   no label matches within the other filters.
 * - `clientId`: restrict to connections linked to a specific OAuth app.
 *
 * Returns `undefined` when no matching active connection exists.
 */
export async function getActiveConnection(
  provider: string,
  options?: { clientId?: string; account?: string },
): Promise<OAuthConnectionRow | undefined> {
  return (await getActiveConnections(provider, options))[0];
}

/**
 * Like {@link getActiveConnection}, but returns ALL matching active connections
 * (most-recently-created first) instead of just the newest. Callers that must
 * choose among multiple connections, for example picking the one that carries a
 * specific set of granted scopes, use this; `getActiveConnection` is the
 * single-result convenience over the same query.
 */
export async function getActiveConnections(
  provider: string,
  options?: { clientId?: string; account?: string },
): Promise<OAuthConnectionRow[]> {
  const { clientId, account } = options ?? {};
  const db = requireMainDb();
  const connections = db.schema.oauthConnections;

  const conditions = [
    eq(connections.provider, provider),
    eq(connections.status, "active"),
  ];

  if (clientId) {
    const app = await getAppByProviderAndClientId(provider, clientId);
    if (!app) {
      return [];
    }
    conditions.push(eq(connections.oauthAppId, app.id));
  }

  const rows = await db.orm
    .select()
    .from(connections)
    .where(
      and(
        ...conditions,
        account
          ? or(
              eq(connections.accountInfo, account),
              eq(connections.id, account),
            )
          : undefined,
      ),
    )
    .orderBy(desc(connections.createdAt), sql`ctid DESC`);

  if (account) {
    const labelMatches = rows.filter(
      (connection) => connection.accountInfo === account,
    );
    if (labelMatches.length > 0) {
      return labelMatches;
    }
  }
  return rows;
}

/** @deprecated Use {@link getActiveConnection} instead. */
export async function getConnectionByProvider(
  provider: string,
  clientId?: string,
): Promise<OAuthConnectionRow | undefined> {
  return await getActiveConnection(provider, { clientId });
}

/**
 * Get ALL active connections for a provider (supports multi-account).
 */
export async function listActiveConnectionsByProvider(
  provider: string,
): Promise<OAuthConnectionRow[]> {
  const db = requireMainDb();
  const connections = db.schema.oauthConnections;
  return await db.orm
    .select()
    .from(connections)
    .where(
      and(eq(connections.provider, provider), eq(connections.status, "active")),
    )
    .orderBy(desc(connections.createdAt), sql`ctid DESC`);
}

/**
 * Check whether a provider has a usable OAuth connection: an active row in the
 * database AND a corresponding access token in secure storage.
 *
 * This guards against the edge case where the connection row was created/updated
 * but the secure-key write for the access token failed, which would make
 * `resolveOAuthConnection()` throw at usage time.
 */
export async function isProviderConnected(provider: string): Promise<boolean> {
  const conn = await getActiveConnection(provider);
  if (!conn || conn.status !== "active") {
    return false;
  }
  const tokenResult = await getConnectionAccessTokenResult({
    provider,
    connectionId: conn.id,
  });
  return tokenResult.value !== undefined;
}

/**
 * Update fields on an existing connection. Returns true if a row was updated.
 */
export async function updateConnection(
  id: string,
  updates: Partial<{
    oauthAppId: string;
    accountInfo: string;
    grantedScopes: string[];
    /** Pass `null` to explicitly clear a stale expiresAt in the DB. */
    expiresAt: number | null;
    hasRefreshToken: boolean;
    status: string;
    label: string;
    metadata: Record<string, unknown>;
  }>,
): Promise<boolean> {
  const db = requireMainDb();
  const connections = db.schema.oauthConnections;
  const now = Date.now();

  // Build the set clause, serializing JSON fields and converting booleans.
  // For expiresAt, null means "clear the column" so we check for undefined
  // explicitly rather than truthiness.
  const set: Partial<SchemaTables["oauthConnections"]["$inferInsert"]> = {
    updatedAt: now,
  };
  if (updates.oauthAppId !== undefined) {
    set.oauthAppId = updates.oauthAppId;
  }
  if (updates.accountInfo !== undefined) {
    set.accountInfo = updates.accountInfo;
  }
  if (updates.grantedScopes !== undefined) {
    set.grantedScopes = JSON.stringify(updates.grantedScopes);
  }
  if (updates.expiresAt !== undefined) {
    set.expiresAt = updates.expiresAt;
  }
  if (updates.hasRefreshToken !== undefined) {
    set.hasRefreshToken = updates.hasRefreshToken ? 1 : 0;
  }
  if (updates.status !== undefined) {
    set.status = updates.status;
  }
  if (updates.label !== undefined) {
    set.label = updates.label;
  }
  if (updates.metadata !== undefined) {
    set.metadata = JSON.stringify(updates.metadata);
  }

  const updated = await db.orm
    .update(connections)
    .set(set)
    .where(eq(connections.id, id))
    .returning({ id: connections.id });

  return updated.length > 0;
}

/** List connections, optionally filtered by provider key and/or client ID. */
export async function listConnections(
  provider?: string,
  clientId?: string,
): Promise<OAuthConnectionRow[]> {
  const db = requireMainDb();
  const connections = db.schema.oauthConnections;

  let rows: OAuthConnectionRow[];
  if (provider) {
    rows = await db.orm
      .select()
      .from(connections)
      .where(eq(connections.provider, provider))
      .orderBy(connections.provider, connections.id);
  } else {
    rows = await db.orm
      .select()
      .from(connections)
      .orderBy(connections.provider, connections.id);
  }

  if (clientId) {
    const apps = db.schema.oauthApps;
    const matchingApps = await db.orm
      .select({ id: apps.id })
      .from(apps)
      .where(eq(apps.clientId, clientId));
    const matchingAppIds = new Set(matchingApps.map((a) => a.id));
    return rows.filter((r) => matchingAppIds.has(r.oauthAppId));
  }

  return rows;
}

/** Delete a connection by ID. Returns true if a row was deleted. */
export async function deleteConnection(id: string): Promise<boolean> {
  const db = requireMainDb();
  const connections = db.schema.oauthConnections;
  const deleted = await db.orm
    .delete(connections)
    .where(eq(connections.id, id))
    .returning({ id: connections.id });
  return deleted.length > 0;
}

// ---------------------------------------------------------------------------
// Disconnect (full cleanup)
// ---------------------------------------------------------------------------

/**
 * Fully disconnect an OAuth provider:
 * 1. Best-effort upstream token revoke when the provider has `revokeUrl`
 *    configured (mirrors platform's `try_revoke_token`).
 * 2. Delete the new-format secure keys (access_token and refresh_token).
 * 3. Remove the connection row from the database.
 *
 * The upstream revoke step is strictly best-effort: any failure (network
 * error, non-2xx response, missing access token, etc.) is logged as a
 * warning and the local cleanup proceeds anyway. The connection is always
 * cleaned up locally regardless of whether the upstream call succeeds.
 *
 * When `connectionId` is provided, disconnects that specific connection
 * (useful for multi-account providers). Otherwise falls back to the most
 * recent active connection.
 *
 * Returns `"disconnected"` if a connection was found and locally cleaned up,
 * `"not-found"` if no active connection existed for the given provider,
 * or `"error"` if secure key deletion failed (connection row is preserved
 * to avoid orphaning secrets).
 */
export async function disconnectOAuthProvider(
  provider: string,
  clientId?: string,
  connectionId?: string,
): Promise<"disconnected" | "not-found" | "error"> {
  const conn = connectionId
    ? await getConnection(connectionId)
    : await getActiveConnection(provider, { clientId });
  if (!conn) {
    return "not-found";
  }

  // Best-effort upstream revoke. Mirrors platform's try_revoke_token in
  // django/app/assistant/oauth/providers/base.py. Failures here never
  // block local cleanup; the connection is always cleaned up locally
  // regardless of whether the upstream call succeeds.
  try {
    const providerRow = await getProvider(conn.provider);
    if (providerRow?.revokeUrl) {
      const app = await getApp(conn.oauthAppId);
      const accessToken = await getSecureKeyAsync(
        oauthConnectionAccessTokenPath(conn.id),
      );
      if (app && accessToken) {
        const bodyTemplate = providerRow.revokeBodyTemplate
          ? (JSON.parse(providerRow.revokeBodyTemplate) as Record<
              string,
              unknown
            >)
          : null;
        await tryRevokeOAuthToken({
          provider: conn.provider,
          revokeUrl: providerRow.revokeUrl,
          bodyTemplate,
          accessToken,
          clientId: app.clientId,
        });
      }
    }
  } catch (err) {
    // tryRevokeOAuthToken already swallows fetch errors, but the lookups
    // (getProvider/getApp/getSecureKeyAsync/JSON.parse) could throw too.
    // Defense in depth: never let the local cleanup path die because of
    // anything in the revoke setup.
    log.warn(
      {
        provider: conn.provider,
        connectionId: conn.id,
        err: err instanceof Error ? err.message : String(err),
      },
      "Error preparing upstream OAuth revoke (best-effort, continuing local cleanup)",
    );
  }

  // Wrap the assistant's secure-key functions into the SecureKeyBackend
  // interface expected by the shared deleteOAuthTokens helper.
  const backend: SecureKeyBackend = {
    get: (key: string) => getSecureKeyAsync(key),
    set: (key: string, value: string) => setSecureKeyAsync(key, value),
    delete: (key: string) => deleteSecureKeyAsync(key),
    list: async () => [],
  };

  const { accessTokenResult, refreshTokenResult } = await deleteOAuthTokens(
    backend,
    conn.id,
  );

  if (accessTokenResult === "error" || refreshTokenResult === "error") {
    // Return "error" (rather than throwing like deleteApp) so the connection row
    // is preserved. This avoids orphaning secrets in secure storage; the caller
    // can retry later and the row acts as a pointer to the keys that still need
    // cleanup. In deleteApp the DB row is already gone, so throwing is the only
    // way to surface the failure.
    log.warn(
      {
        provider,
        connectionId: conn.id,
        accessTokenResult,
        refreshTokenResult,
      },
      "Failed to delete OAuth secure keys — skipping connection row deletion to avoid orphaning secrets",
    );
    return "error";
  }

  await deleteConnection(conn.id);

  // Best-effort cache invalidation so Home suggestions track the disconnect;
  // the call swallows its own failures and never blocks disconnect.
  void invalidateAssistantSuggestedPromptsCache();

  return "disconnected";
}
