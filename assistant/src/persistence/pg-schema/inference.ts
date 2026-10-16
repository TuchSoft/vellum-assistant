import { bigint, index, pgTable, text } from "drizzle-orm/pg-core";

/**
 * Named provider connections.
 *
 * Each row is a named auth-config instance for a code-defined provider.
 * Profiles in config.json reference connections by `name` via the
 * `provider_connection` field.
 *
 * Created by migration 243.
 */
export const providerConnections = pgTable(
  "provider_connections",
  {
    name: text("name").primaryKey(),
    provider: text("provider").notNull(),
    auth: text("auth").notNull(),
    label: text("label"),
    baseUrl: text("base_url"),
    models: text("models"),
    createdAt: bigint("created_at", { mode: "number" }).notNull(),
    updatedAt: bigint("updated_at", { mode: "number" }).notNull(),
  },
  (table) => [index("idx_provider_connections_provider").on(table.provider)],
);

export type ProviderConnectionRow = typeof providerConnections.$inferSelect;
export type NewProviderConnectionRow = typeof providerConnections.$inferInsert;
