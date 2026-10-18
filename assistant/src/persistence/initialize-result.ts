/**
 * Result of a database initialization pass, shared by the SQLite test
 * harness (`db-init.ts`) and the Postgres boot path (`pg-db-init.ts`).
 */
export interface InitializeDbResult {
  migrationsOk: boolean;
  failedMigrations: Array<{ name: string; error?: string }>;
  deferredMigrations: Array<{ name: string; missing: string[] }>;
  validationError?: string;
}
