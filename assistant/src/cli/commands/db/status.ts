/**
 * `assistant db status` — read-only inspection of the assistant Postgres
 * database.
 *
 * Opens its own short-lived connection from `VELLUM_DATABASE_URL` (the same URL
 * the runtime uses) and never goes through the daemon: this is exactly the
 * moment you most want it to work, when the runtime is degraded and IPC is not
 * an option. Every query is a catalog read and the connection is closed before
 * the process exits.
 *
 * Reports:
 *   - the current database, its reported size (`pg_database_size`) and the
 *     server version
 *   - table count (regular tables in the current schema) and the number of
 *     connections open against this database (`pg_stat_activity`)
 *   - the largest tables by row count and by total size (table + TOAST +
 *     indexes, `pg_total_relation_size`)
 *
 * Row counts come from `pg_class.reltuples`, the planner's estimate. Exact
 * counts would scan every table, which is the wrong trade for a status command:
 * a table written since the last `ANALYZE` can report a stale number.
 */

import type { Command } from "commander";
import postgres from "postgres";

import { red } from "../../lib/cli-colors.js";
import { subcommand } from "../../lib/cli-command-help.js";
import { shouldOutputJson, writeOutput } from "../../output.js";
import { formatBytes, formatCount } from "./format.js";

/** How many tables each "largest" list reports. */
const LARGEST_TABLES = 5;

// ---------------------------------------------------------------------------
// Connection seam
// ---------------------------------------------------------------------------

/**
 * The slice of a Postgres connection this command needs. A real connection
 * wraps `postgres.js`; tests supply an object over fixed rows.
 */
export interface DbStatusConnection {
  /** Run one read-only query and return its rows. */
  query(sql: string): Promise<Record<string, unknown>[]>;
  /** Release the connection. Never throws into the caller. */
  close(): Promise<void>;
}

export type DbStatusConnect = (url: string) => DbStatusConnection;

function connectPostgres(url: string): DbStatusConnection {
  const sql = postgres(url, { max: 1, onnotice: () => {} });
  return {
    async query(text) {
      return (await sql.unsafe(text)) as unknown as Record<string, unknown>[];
    },
    async close() {
      await sql.end({ timeout: 5 });
    },
  };
}

export interface DbStatusDeps {
  /** Override the Postgres connection factory (tests). */
  connect?: DbStatusConnect;
}

// ---------------------------------------------------------------------------
// Queries
// ---------------------------------------------------------------------------

/**
 * `current_schema()` resolves through the connection's `search_path`: `public`
 * in production, the isolated schema in the Postgres test bootstrap.
 */
const SUMMARY_SQL = `
  SELECT current_database() AS database,
         pg_database_size(current_database()) AS size_bytes,
         current_setting('server_version') AS server_version,
         version() AS server_version_full,
         (SELECT count(*)
            FROM pg_stat_activity
           WHERE datname = current_database()) AS connections,
         (SELECT count(*)
            FROM pg_class c
            JOIN pg_namespace n ON n.oid = c.relnamespace
           WHERE c.relkind = 'r'
             AND n.nspname = current_schema()) AS table_count
`;

const LARGEST_BY_ROWS_SQL = `
  SELECT c.relname AS name,
         GREATEST(c.reltuples, 0) AS row_estimate
    FROM pg_class c
    JOIN pg_namespace n ON n.oid = c.relnamespace
   WHERE c.relkind = 'r'
     AND n.nspname = current_schema()
   ORDER BY GREATEST(c.reltuples, 0) DESC, c.relname ASC
   LIMIT ${LARGEST_TABLES}
`;

const LARGEST_BY_SIZE_SQL = `
  SELECT c.relname AS name,
         pg_total_relation_size(c.oid) AS size_bytes
    FROM pg_class c
    JOIN pg_namespace n ON n.oid = c.relnamespace
   WHERE c.relkind = 'r'
     AND n.nspname = current_schema()
   ORDER BY pg_total_relation_size(c.oid) DESC, c.relname ASC
   LIMIT ${LARGEST_TABLES}
`;

// ---------------------------------------------------------------------------
// Shapes
// ---------------------------------------------------------------------------

interface SummaryRow {
  database: string;
  size_bytes: string | number;
  server_version: string;
  server_version_full: string;
  connections: string | number;
  table_count: string | number;
}

interface RowsTableRow {
  name: string;
  row_estimate: string | number;
}

interface SizeTableRow {
  name: string;
  size_bytes: string | number;
}

export interface DbStatusTableRows {
  name: string;
  /** Estimated live rows (`pg_class.reltuples`). */
  rows: number;
}

export interface DbStatusTableSize {
  name: string;
  /** Table + TOAST + indexes, in bytes. */
  sizeBytes: number;
}

export interface DbStatusReport {
  database: string;
  /** `server_version`, e.g. "17.6". */
  serverVersion: string;
  /** `version()`, e.g. "PostgreSQL 17.6 (Debian ...) on aarch64 ...". */
  serverVersionFull: string;
  sizeBytes: number;
  tableCount: number;
  connections: number;
  largestByRows: DbStatusTableRows[];
  largestBySize: DbStatusTableSize[];
}

/**
 * Postgres returns `bigint` as a string through `postgres.js` (and `count(*)`
 * is always `bigint`), so every numeric column is coerced here. A value that
 * is not finite becomes 0 rather than poisoning the report.
 */
function toNumber(value: unknown): number {
  const n = typeof value === "number" ? value : Number(value);
  return Number.isFinite(n) ? n : 0;
}

// ---------------------------------------------------------------------------
// Reading
// ---------------------------------------------------------------------------

/** Read the full status report. Throws when the database cannot be read. */
export async function readDbStatus(
  connection: DbStatusConnection,
): Promise<DbStatusReport> {
  const summaryRows = await connection.query(SUMMARY_SQL);
  const summary = summaryRows[0] as unknown as SummaryRow | undefined;
  if (!summary) {
    throw new Error("the database summary query returned no rows");
  }

  const byRows = (await connection.query(
    LARGEST_BY_ROWS_SQL,
  )) as unknown as RowsTableRow[];
  const bySize = (await connection.query(
    LARGEST_BY_SIZE_SQL,
  )) as unknown as SizeTableRow[];

  return {
    database: String(summary.database),
    serverVersion: String(summary.server_version),
    serverVersionFull: String(summary.server_version_full),
    sizeBytes: toNumber(summary.size_bytes),
    tableCount: toNumber(summary.table_count),
    connections: toNumber(summary.connections),
    largestByRows: byRows.map((t) => ({
      name: String(t.name),
      rows: toNumber(t.row_estimate),
    })),
    largestBySize: bySize.map((t) => ({
      name: String(t.name),
      sizeBytes: toNumber(t.size_bytes),
    })),
  };
}

// ---------------------------------------------------------------------------
// Rendering
// ---------------------------------------------------------------------------

const LABEL_WIDTH = 17;

function row(label: string, value: string): string {
  return `${label.padEnd(LABEL_WIDTH)}${value}\n`;
}

function renderTableList(
  header: string,
  entries: { name: string; value: string }[],
): string {
  let out = `${header}\n`;
  if (entries.length === 0) {
    return `${out}  (no tables)\n`;
  }
  const nameWidth = Math.max(16, ...entries.map((e) => e.name.length));
  for (const entry of entries) {
    out += `  ${entry.name.padEnd(nameWidth)}  ${entry.value}\n`;
  }
  return out;
}

export function renderHuman(report: DbStatusReport): string {
  let out = "";
  out += row("Database", report.database);
  out += row("Server version", report.serverVersion);
  out += row("Size", formatBytes(report.sizeBytes));
  out += row("Tables", formatCount(report.tableCount));
  out += row("Connections", formatCount(report.connections));

  out += "\n";
  out += renderTableList(
    `Largest tables (by rows, pg_class.reltuples estimate, top ${LARGEST_TABLES})`,
    report.largestByRows.map((t) => ({
      name: t.name,
      value: `${formatCount(t.rows)} rows`,
    })),
  );

  out += "\n";
  out += renderTableList(
    `Largest tables (by size, table + TOAST + indexes, top ${LARGEST_TABLES})`,
    report.largestBySize.map((t) => ({
      name: t.name,
      value: formatBytes(t.sizeBytes),
    })),
  );

  return out;
}

const MISSING_URL_ERROR =
  "VELLUM_DATABASE_URL is not set. The assistant stores its data in Postgres, " +
  "so this command needs the same database URL the runtime uses.";

function emitError(cmd: Command, message: string): void {
  if (shouldOutputJson(cmd)) {
    writeOutput(cmd, { error: message });
    return;
  }
  process.stderr.write(`${red("ERROR")}  ${message}\n`);
}

// ---------------------------------------------------------------------------
// Command wiring
// ---------------------------------------------------------------------------

export function registerDbStatus(
  parent: Command,
  deps: DbStatusDeps = {},
): void {
  const connect = deps.connect ?? connectPostgres;

  subcommand(parent, "status").action(async function (this: Command) {
    const url = process.env.VELLUM_DATABASE_URL?.trim();
    if (!url) {
      emitError(this, MISSING_URL_ERROR);
      process.exit(1);
    }

    let connection: DbStatusConnection | null = null;
    let report: DbStatusReport | null = null;
    let failure: string | null = null;
    try {
      connection = connect(url);
      report = await readDbStatus(connection);
    } catch (err) {
      failure = err instanceof Error ? err.message : String(err);
    } finally {
      if (connection) {
        try {
          await connection.close();
        } catch {
          // Best-effort: a close failure must not mask the report.
        }
      }
    }

    if (!report) {
      emitError(
        this,
        `Failed to read the assistant database: ${failure ?? "unknown error"}`,
      );
      process.exit(1);
    }

    if (shouldOutputJson(this)) {
      writeOutput(this, report);
    } else {
      process.stdout.write(renderHuman(report));
    }
  });
}
