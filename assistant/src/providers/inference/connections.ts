import { and, eq, isNull } from "drizzle-orm";
import { z } from "zod";

import { type AsyncDb, requireMainDb } from "../../persistence/db-facade.js";
import { normalizeCredentialRef } from "../../security/credential-key.js";
import { getLogger } from "../../util/logger.js";
import { clearConnectionProviderCache } from "../registry.js";
import {
  isVellumManagedConnection,
  VELLUM_MANAGED_CONNECTION_NAME,
  VELLUM_MANAGED_PROVIDER,
} from "../vellum-model-routing.js";

export { VELLUM_MANAGED_CONNECTION_NAME };
import {
  type Auth,
  AuthSchema,
  type ConnectionModel,
  ConnectionModelSchema,
  type ConnectionProvider,
  ConnectionProviderSchema,
  type ProviderConnection,
  PROVIDERS_REQUIRING_BASE_URL_AND_MODELS,
  VALID_CONNECTION_PROVIDERS,
} from "./auth.js";

const log = getLogger("providers/inference/connections");

/**
 * Whether a row is one of the managed connections, judged by the row and not
 * by its name alone. Boot seeding leaves a user-owned row claiming a canonical
 * name in place, and that row is an ordinary connection: routing ignores it,
 * the route layer lets it be edited and deleted, and clients must render it
 * that way or the collision becomes unrecoverable from the UI.
 */
function isManagedRow(row: {
  name: string;
  provider: string;
  auth: { type: string };
}): boolean {
  return (
    MANAGED_CONNECTION_NAMES.has(row.name) && isVellumManagedConnection(row)
  );
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Parse an auth value (stored JSON or caller input), normalizing any
 * credential reference to the vault-key form. Normalizing on read as well as
 * write heals rows that were stored with the secrets-API wire name (e.g.
 * `openrouter:api_key`) without a migration.
 */
function parseAuth(raw: unknown): Auth | null {
  const parsed = AuthSchema.safeParse(raw);
  if (!parsed.success) {
    return null;
  }
  const auth = parsed.data;
  return "credential" in auth
    ? { ...auth, credential: normalizeCredentialRef(auth.credential) }
    : auth;
}

function parseModelsColumn(raw: string | null): ConnectionModel[] | null {
  if (raw === null || raw === "") {
    return null;
  }
  try {
    const parsed = z.array(ConnectionModelSchema).safeParse(JSON.parse(raw));
    return parsed.success ? parsed.data : null;
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------
// Synchronous snapshot
// ---------------------------------------------------------------------------

/**
 * Synchronous view of the connection rows, or `undefined` before the first
 * load in this process.
 *
 * Dispatch and capability probes judge connection names on synchronous paths
 * (the resolver's `isResolvableProvider` callback, the native-web-search probe,
 * context-window sizing), so they read this snapshot instead of the async
 * facade. Every async read and every mutation refreshes it; boot warms it
 * before dispatch starts.
 */
let snapshot: Map<string, ProviderConnection> | undefined;

function replaceSnapshot(connections: ProviderConnection[]): void {
  snapshot = new Map(
    connections.map((connection) => [connection.name, connection]),
  );
}

function putSnapshot(connection: ProviderConnection): void {
  snapshot?.set(connection.name, connection);
}

function dropSnapshot(name: string): void {
  snapshot?.delete(name);
}

/** Whether the snapshot has been loaded in this process. */
export function isConnectionSnapshotLoaded(): boolean {
  return snapshot !== undefined;
}

/**
 * A connection from the synchronous snapshot, or `undefined` when the
 * snapshot is cold or the name is absent. Cold is indistinguishable from
 * absent here; callers that fail open use `isConnectionSnapshotLoaded` to
 * tell the two apart.
 */
export function peekConnection(name: string): ProviderConnection | undefined {
  return snapshot?.get(name);
}

/** Every connection in the synchronous snapshot (empty while cold). */
export function listSnapshotConnections(): ProviderConnection[] {
  return [...(snapshot?.values() ?? [])];
}

/** Reload the synchronous snapshot from the main database. */
export async function refreshConnectionSnapshot(): Promise<void> {
  replaceSnapshot(await listConnections(requireMainDb()));
}

/**
 * Load the snapshot if this process has not loaded it yet. Fail-soft: a
 * missing or unreachable database leaves the snapshot cold, which callers
 * handle the same way they handle a database blip.
 */
export async function ensureConnectionSnapshot(): Promise<void> {
  if (snapshot !== undefined) {
    return;
  }
  try {
    await refreshConnectionSnapshot();
  } catch (err) {
    log.warn(
      { err },
      "provider connection snapshot unavailable; synchronous connection lookups degrade",
    );
  }
}

// ---------------------------------------------------------------------------
// Read
// ---------------------------------------------------------------------------

export async function listConnections(
  db: AsyncDb = requireMainDb(),
  filter?: { provider?: string },
): Promise<ProviderConnection[]> {
  const connections = db.schema.providerConnections;
  const rows = filter?.provider
    ? await db.orm
        .select()
        .from(connections)
        .where(eq(connections.provider, filter.provider))
    : await db.orm.select().from(connections);

  const result = rows.flatMap((row) => {
    const auth = parseAuth(JSON.parse(row.auth));
    if (!auth) {
      return [];
    }
    const provider = ConnectionProviderSchema.safeParse(row.provider);
    if (!provider.success) {
      return [];
    }
    return [
      {
        ...row,
        auth,
        provider: provider.data,
        label: row.label ?? null,
        baseUrl: row.baseUrl ?? null,
        models: parseModelsColumn(row.models),
        isManaged: isManagedRow({ ...row, provider: provider.data, auth }),
      },
    ];
  });

  if (filter?.provider) {
    for (const connection of result) {
      putSnapshot(connection);
    }
  } else {
    replaceSnapshot(result);
  }

  return result;
}

export async function getConnection(
  db: AsyncDb = requireMainDb(),
  name: string,
): Promise<ProviderConnection | null> {
  const connections = db.schema.providerConnections;
  const [row] = await db.orm
    .select()
    .from(connections)
    .where(eq(connections.name, name))
    .limit(1);

  if (!row) {
    return null;
  }
  const auth = parseAuth(JSON.parse(row.auth));
  if (!auth) {
    return null;
  }
  const provider = ConnectionProviderSchema.safeParse(row.provider);
  if (!provider.success) {
    return null;
  }
  const connection: ProviderConnection = {
    ...row,
    auth,
    provider: provider.data,
    label: row.label ?? null,
    baseUrl: row.baseUrl ?? null,
    models: parseModelsColumn(row.models),
    isManaged: isManagedRow({ ...row, provider: provider.data, auth }),
  };
  putSnapshot(connection);
  return connection;
}

// ---------------------------------------------------------------------------
// Write
// ---------------------------------------------------------------------------

export type CreateConnectionInput = {
  name: string;
  provider: string;
  auth: Auth;
  label?: string | null;
  baseUrl?: string | null;
  models?: ConnectionModel[] | null;
};

export type UpdateConnectionInput = {
  auth: Auth;
  /**
   * Optional provider correction. The HTTP PATCH route never passes this
   * (provider is immutable there); it exists for owners of well-known rows
   * to keep the provider truthful when they rewrite the auth, e.g. the
   * ChatGPT sign-in flow stamping "openai" on the subscription row so a
   * claiming row with a different provider cannot strand the fresh token.
   */
  provider?: string;
  label?: string | null;
  baseUrl?: string | null;
  models?: ConnectionModel[] | null;
};

export type ConnectionCreateError =
  | { code: "already_exists" }
  | { code: "invalid_provider"; provider: string }
  | { code: "invalid_auth" }
  | { code: "base_url_required" }
  | { code: "models_required" };

export type ConnectionUpdateError =
  | { code: "not_found" }
  | { code: "invalid_auth" }
  | { code: "invalid_provider"; provider: string }
  | { code: "base_url_required" }
  | { code: "models_required" };

export type ConnectionDeleteError =
  | { code: "not_found" }
  | { code: "has_references"; count: number };

export async function createConnection(
  db: AsyncDb = requireMainDb(),
  input: CreateConnectionInput,
): Promise<
  | { ok: true; connection: ProviderConnection }
  | { ok: false; error: ConnectionCreateError }
> {
  const connections = db.schema.providerConnections;
  if (!VALID_CONNECTION_PROVIDERS.includes(input.provider as never)) {
    return {
      ok: false,
      error: { code: "invalid_provider", provider: input.provider },
    };
  }
  // Safe cast: VALID_CONNECTION_PROVIDERS.includes() guards above.
  const provider = input.provider as ConnectionProvider;

  const auth = parseAuth(input.auth);
  if (!auth) {
    return { ok: false, error: { code: "invalid_auth" } };
  }

  const [existing] = await db.orm
    .select({ name: connections.name })
    .from(connections)
    .where(eq(connections.name, input.name))
    .limit(1);
  if (existing) {
    return { ok: false, error: { code: "already_exists" } };
  }

  const label = input.label ?? null;
  const baseUrl = input.baseUrl ?? null;
  const models = input.models ?? null;

  if (PROVIDERS_REQUIRING_BASE_URL_AND_MODELS.has(provider)) {
    if (!baseUrl) {
      return { ok: false, error: { code: "base_url_required" } };
    }
    if (!models || models.length === 0) {
      return { ok: false, error: { code: "models_required" } };
    }
  }

  const now = Date.now();
  await db.orm.insert(connections).values({
    name: input.name,
    provider,
    auth: JSON.stringify(auth),
    label,
    baseUrl,
    models: models === null ? null : JSON.stringify(models),
    createdAt: now,
    updatedAt: now,
  });

  // Invalidate per-connection adapter cache so subsequent dispatch
  // resolves the freshly-inserted row's auth.
  clearConnectionProviderCache();

  const connection: ProviderConnection = {
    name: input.name,
    provider,
    auth,
    label,
    baseUrl,
    models,
    createdAt: now,
    updatedAt: now,
    isManaged: isManagedRow({ name: input.name, provider, auth }),
  };
  putSnapshot(connection);

  return { ok: true, connection };
}

export async function updateConnection(
  db: AsyncDb = requireMainDb(),
  name: string,
  input: UpdateConnectionInput,
): Promise<
  | { ok: true; connection: ProviderConnection }
  | { ok: false; error: ConnectionUpdateError }
> {
  const connections = db.schema.providerConnections;
  const existing = await getConnection(db, name);
  if (!existing) {
    return { ok: false, error: { code: "not_found" } };
  }

  const auth = parseAuth(input.auth);
  if (!auth) {
    return { ok: false, error: { code: "invalid_auth" } };
  }

  if (
    input.provider !== undefined &&
    !VALID_CONNECTION_PROVIDERS.includes(input.provider as never)
  ) {
    return {
      ok: false,
      error: { code: "invalid_provider", provider: input.provider },
    };
  }
  const nextProvider = input.provider ?? existing.provider;

  const nextBaseUrl =
    input.baseUrl !== undefined ? input.baseUrl : existing.baseUrl;
  const nextModels =
    input.models !== undefined ? input.models : existing.models;

  if (PROVIDERS_REQUIRING_BASE_URL_AND_MODELS.has(nextProvider)) {
    if (!nextBaseUrl) {
      return { ok: false, error: { code: "base_url_required" } };
    }
    if (!nextModels || nextModels.length === 0) {
      return { ok: false, error: { code: "models_required" } };
    }
  }

  const now = Date.now();
  const setClause: {
    auth: string;
    updatedAt: number;
    provider?: string;
    label?: string | null;
    baseUrl?: string | null;
    models?: string | null;
  } = { auth: JSON.stringify(auth), updatedAt: now };
  if (input.provider !== undefined) {
    setClause.provider = input.provider;
  }
  if (input.label !== undefined) {
    setClause.label = input.label;
  }
  if (input.baseUrl !== undefined) {
    setClause.baseUrl = input.baseUrl;
  }
  if (input.models !== undefined) {
    setClause.models =
      input.models === null ? null : JSON.stringify(input.models);
  }

  await db.orm
    .update(connections)
    .set(setClause)
    .where(eq(connections.name, name));

  // Drop cached adapter built against the previous auth config.
  clearConnectionProviderCache();

  const connection: ProviderConnection = {
    ...existing,
    auth,
    provider: nextProvider,
    label: input.label !== undefined ? input.label : existing.label,
    baseUrl: nextBaseUrl,
    models: nextModels,
    updatedAt: now,
    isManaged: isManagedRow({ name, provider: nextProvider, auth }),
  };
  putSnapshot(connection);

  return { ok: true, connection };
}

/**
 * Delete a connection.
 *
 * `force`: when true, delete even if profiles reference it.
 * When false, rejects if any profile in the provided profile names list
 * references this connection.
 */
export async function deleteConnection(
  db: AsyncDb = requireMainDb(),
  name: string,
  opts: { force?: boolean; referencingProfiles?: string[] } = {},
): Promise<{ ok: true } | { ok: false; error: ConnectionDeleteError }> {
  const connections = db.schema.providerConnections;
  const [existing] = await db.orm
    .select({ name: connections.name })
    .from(connections)
    .where(eq(connections.name, name))
    .limit(1);

  if (!existing) {
    return { ok: false, error: { code: "not_found" } };
  }

  if (
    !opts.force &&
    opts.referencingProfiles &&
    opts.referencingProfiles.length > 0
  ) {
    return {
      ok: false,
      error: { code: "has_references", count: opts.referencingProfiles.length },
    };
  }

  await db.orm.delete(connections).where(eq(connections.name, name));

  // Evict cached adapter for the deleted connection name.
  clearConnectionProviderCache();
  dropSnapshot(name);

  return { ok: true };
}

// ---------------------------------------------------------------------------
// Seed canonical connections (upsert, used at boot time)
// ---------------------------------------------------------------------------

/**
 * The former per-provider `*-managed` connection names, now collapsed into the
 * single `vellum` connection. They are no longer seeded, but existing installs
 * (and fresh installs seeded by migration 243) may still carry these rows until
 * a follow-up migration deletes them. They are filtered out of the connection
 * list so the UI never shows the pre-consolidation duplicates.
 */
export const LEGACY_MANAGED_CONNECTION_NAMES: ReadonlySet<string> = new Set([
  "anthropic-managed",
  "openai-managed",
  "gemini-managed",
  "fireworks-managed",
  "together-managed",
]);

const CANONICAL_CONNECTIONS: Array<{
  name: string;
  provider: string;
  auth: Auth;
  label: string;
}> = [
  {
    name: VELLUM_MANAGED_CONNECTION_NAME,
    provider: VELLUM_MANAGED_PROVIDER,
    auth: { type: "platform" },
    label: "Vellum",
  },
];

/**
 * The Vellum-managed connection as boot seeding defines it, built without a DB
 * read. Dispatch uses this when the `vellum` name is occupied by a user-owned
 * row: seeding refuses to overwrite such a row, so the canonical row can be
 * absent from the DB while managed routing still has to work. Platform auth
 * needs no row of its own, only this shape.
 */
export function canonicalVellumConnection(): ProviderConnection {
  const now = Date.now();
  const canonical = CANONICAL_CONNECTIONS[0];
  return {
    name: canonical.name,
    provider: canonical.provider,
    auth: canonical.auth,
    label: canonical.label,
    baseUrl: null,
    models: null,
    createdAt: now,
    updatedAt: now,
    isManaged: true,
  };
}

/**
 * Names of the canonical Vellum-managed connections. Seeded on every daemon
 * boot via `seedCanonicalConnections` and representing the platform-managed
 * inference route. They are write-protected at the route layer:
 *   - DELETE is blocked outright (would resurrect on next boot anyway, but
 *     blocking prevents a confusing delete → re-appear loop).
 *   - PATCH that changes `auth` is blocked (auth is locked to `{type:"platform"}`
 *     so any other value would be reverted on the next boot upsert).
 *   - PATCH that changes `label` is allowed — users may legitimately relabel the
 *     managed connection. `label` is seeded on initial INSERT and backfilled when
 *     null on subsequent boots so pre-seed installs pick up the default; a non-null
 *     user-customized label is preserved (see `seedCanonicalConnections`).
 *
 * Mirrors `MANAGED_PROFILE_NAMES` (config/seed-inference-profiles.ts).
 */
export const MANAGED_CONNECTION_NAMES: ReadonlySet<string> = new Set(
  CANONICAL_CONNECTIONS.map((c) => c.name),
);

/**
 * Upsert the canonical connections on every boot. Existing rows are
 * updated to the latest provider/auth values so Vellum can push connection
 * changes to customers in new releases.
 *
 * Label handling: the default label is seeded on initial INSERT so new
 * installs render a human-friendly name in the connections list. The boot
 * upsert deliberately leaves `label` alone on existing rows so user
 * customization is preserved; the separate backfill step below assigns the
 * default only when the existing row has `label IS NULL`, covering installs
 * that pre-date the label seed.
 */
export async function seedCanonicalConnections(
  db: AsyncDb = requireMainDb(),
): Promise<void> {
  const connections = db.schema.providerConnections;
  const now = Date.now();
  for (const { name, provider, auth, label } of CANONICAL_CONNECTIONS) {
    // Never clobber a pre-existing user connection that happens to share this
    // canonical name. `vellum` was not a reserved name before consolidation, so
    // an install may already have a BYOK connection keyed `vellum` (with a real
    // provider + api_key auth). Upserting it here would silently rewrite it to
    // the platform-auth sentinel and make it managed/write-protected, breaking
    // any profile that references the user's connection. Only seed/refresh when
    // the row is absent or already our sentinel (same provider).
    const [existing] = await db.orm
      .select({ provider: connections.provider })
      .from(connections)
      .where(eq(connections.name, name))
      .limit(1);
    if (existing && existing.provider !== provider) {
      log.warn(
        { name, existingProvider: existing.provider },
        `Skipping canonical seed for "${name}": a user-owned connection already claims this name.`,
      );
      continue;
    }

    await db.orm
      .insert(connections)
      .values({
        name,
        provider,
        auth: JSON.stringify(auth),
        label,
        createdAt: now,
        updatedAt: now,
      })
      .onConflictDoUpdate({
        target: connections.name,
        set: {
          provider,
          auth: JSON.stringify(auth),
          updatedAt: now,
        },
      });

    // Backfill the default label on rows that pre-date label seeding so
    // existing installs pick up the friendly name. Does not overwrite a
    // user-set label.
    await db.orm
      .update(connections)
      .set({ label, updatedAt: now })
      .where(and(eq(connections.name, name), isNull(connections.label)));

    if (snapshot) {
      const previous = snapshot.get(name);
      snapshot.set(name, {
        name,
        provider,
        auth,
        label: previous?.label ?? label,
        baseUrl: previous?.baseUrl ?? null,
        models: previous?.models ?? null,
        createdAt: previous?.createdAt ?? now,
        updatedAt: now,
        isManaged: isManagedRow({ name, provider, auth }),
      });
    }
  }
}
