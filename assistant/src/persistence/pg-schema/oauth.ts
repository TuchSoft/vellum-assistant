import {
  bigint,
  boolean,
  index,
  pgTable,
  text,
  uniqueIndex,
} from "drizzle-orm/pg-core";

export const oauthProviders = pgTable("oauth_providers", {
  provider: text("provider_key").primaryKey(),
  authorizeUrl: text("auth_url").notNull(),
  tokenExchangeUrl: text("token_url").notNull(),
  refreshUrl: text("refresh_url"),
  tokenEndpointAuthMethod: text("token_endpoint_auth_method")
    .notNull()
    .default("client_secret_post"),
  tokenExchangeBodyFormat: text("token_exchange_body_format")
    .notNull()
    .default("form"),
  userinfoUrl: text("userinfo_url"),
  baseUrl: text("base_url"),
  defaultScopes: text("default_scopes").notNull().default("[]"),
  availableScopes: text("available_scopes"),
  scopeSeparator: text("scope_separator").notNull().default(" "),
  authorizeParams: text("extra_params"),
  pingUrl: text("ping_url"),
  pingMethod: text("ping_method"),
  pingHeaders: text("ping_headers"),
  pingBody: text("ping_body"),
  revokeUrl: text("revoke_url"),
  revokeBodyTemplate: text("revoke_body_template"),
  managedServiceConfigKey: text("managed_service_config_key"),
  managedServiceIsPaid: boolean("managed_service_is_paid")
    .notNull()
    .default(false),
  displayLabel: text("display_name"),
  description: text("description"),
  dashboardUrl: text("dashboard_url"),
  clientIdPlaceholder: text("client_id_placeholder"),
  logoUrl: text("logo_url"),
  requiresClientSecret: bigint("requires_client_secret", { mode: "number" })
    .notNull()
    .default(1),
  loopbackPort: bigint("loopback_port", { mode: "number" }),
  injectionTemplates: text("injection_templates"),
  appType: text("app_type"),
  setupNotes: text("setup_notes"),
  identityUrl: text("identity_url"),
  identityMethod: text("identity_method"),
  identityHeaders: text("identity_headers"),
  identityBody: text("identity_body"),
  identityResponsePaths: text("identity_response_paths"),
  identityFormat: text("identity_format"),
  identityOkField: text("identity_ok_field"),
  responseOkField: text("response_ok_field"),
  featureFlag: text("feature_flag"),
  createdAt: bigint("created_at", { mode: "number" }).notNull(),
  updatedAt: bigint("updated_at", { mode: "number" }).notNull(),
});

export const oauthApps = pgTable(
  "oauth_apps",
  {
    id: text("id").primaryKey(),
    provider: text("provider_key")
      .notNull()
      .references(() => oauthProviders.provider),
    clientId: text("client_id").notNull(),
    clientSecretCredentialPath: text("client_secret_credential_path").notNull(),
    createdAt: bigint("created_at", { mode: "number" }).notNull(),
    updatedAt: bigint("updated_at", { mode: "number" }).notNull(),
  },
  (table) => [
    uniqueIndex("idx_oauth_apps_provider_client").on(
      table.provider,
      table.clientId,
    ),
  ],
);

export const oauthConnections = pgTable(
  "oauth_connections",
  {
    id: text("id").primaryKey(),
    oauthAppId: text("oauth_app_id")
      .notNull()
      .references(() => oauthApps.id),
    provider: text("provider_key").notNull(),
    accountInfo: text("account_info"),
    grantedScopes: text("granted_scopes").notNull().default("[]"),
    expiresAt: bigint("expires_at", { mode: "number" }),
    hasRefreshToken: bigint("has_refresh_token", { mode: "number" })
      .notNull()
      .default(0),
    status: text("status").notNull().default("active"),
    label: text("label"),
    metadata: text("metadata"),
    createdAt: bigint("created_at", { mode: "number" }).notNull(),
    updatedAt: bigint("updated_at", { mode: "number" }).notNull(),
  },
  (table) => [index("idx_oauth_connections_provider_key").on(table.provider)],
);
