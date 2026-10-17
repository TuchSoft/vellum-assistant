/**
 * Postgres test database bootstrap.
 *
 * Every test file runs in its own process (see `scripts/test.ts`), so this
 * module gives each process its own schema in the throwaway database named by
 * `VELLUM_PG_TEST_URL`, applies the generated baseline there, and points
 * `VELLUM_DATABASE_URL` at it. Legacy SQLite stores keep using the per-process
 * temp workspace; only facade callers see Postgres.
 *
 * Wiring:
 *   - `test-preload.ts` imports this module (dynamically, only when
 *     `VELLUM_PG_TEST_URL` is set) so every facade-touching suite gets an
 *     isolated schema without per-file setup.
 *   - Conformance suites gate their `describe` on {@link describePg}.
 *
 * With `VELLUM_PG_TEST_URL` unset nothing is provisioned, so Postgres-backed
 * suites skip.
 */

import { afterAll, describe } from "bun:test";

import postgres from "postgres";

import { closePostgresFacades } from "../persistence/db-postgres-facade.js";
import { BASELINE_STATEMENTS } from "../persistence/pg-migrations/baseline.generated.js";

const baseUrl = process.env.VELLUM_PG_TEST_URL?.trim() || undefined;

/** `describe` when a Postgres test database is configured, `describe.skip` otherwise. */
export const describePg = baseUrl ? describe : describe.skip;

let provisioned:
  | { url: string; schema: string; admin: postgres.Sql }
  | undefined;

function urlWithSearchPath(url: string, schema: string): string {
  const parsed = new URL(url);
  parsed.searchParams.set("options", `-c search_path=${schema},public`);
  return parsed.toString();
}

/**
 * Create this process's schema, apply the baseline, and export the resulting
 * URL through `VELLUM_DATABASE_URL`. Idempotent; returns the URL or `undefined`
 * when no Postgres test database is configured.
 */
export async function preparePgTestDatabase(): Promise<string | undefined> {
  if (!baseUrl) {
    return undefined;
  }
  if (provisioned) {
    return provisioned.url;
  }

  const schema = `vellum_test_${process.pid}_${Math.random()
    .toString(36)
    .slice(2, 8)}`;
  const admin = postgres(baseUrl, { max: 1, onnotice: () => {} });
  await admin.unsafe(`CREATE SCHEMA "${schema}"`);
  // The baseline uses unqualified table names; point the admin connection at
  // the new schema before applying it.
  await admin.unsafe(`SET search_path TO "${schema}", public`);
  await admin.unsafe(BASELINE_STATEMENTS.join(";\n"));

  const url = urlWithSearchPath(baseUrl, schema);
  process.env.VELLUM_DATABASE_URL = url;
  provisioned = { url, schema, admin };

  afterAll(async () => {
    try {
      await closePostgresFacades();
    } catch {
      /* best-effort: a stuck connection must not fail the file */
    }
    try {
      await admin.unsafe(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`);
    } catch {
      /* best-effort: leaked schemas belong to the throwaway database */
    }
    delete process.env.VELLUM_DATABASE_URL;
    await admin.end({ timeout: 5 });
  });

  return url;
}
