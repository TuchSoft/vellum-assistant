#!/usr/bin/env bun
/**
 * Load the live SQLite databases into an empty Postgres database.
 *
 * Usage:
 *   VELLUM_DATABASE_URL=postgres://... bun run scripts/load-sqlite-to-postgres.ts \
 *     --main <assistant.db> --memory <assistant-memory.db> \
 *     --telemetry <assistant-telemetry.db> [--force] [--exclude <table>]...
 *
 * The script snapshots each source with `sqlite3 .backup`, applies the runtime
 * schema path (`runPgMigrations` over `PG_STEPS`: baseline plus the migration
 * ledger), loads the data, verifies every table with an order-independent
 * checksum, and prints a per-table report. It exits non-zero when any table
 * fails so a wrapper can gate the cutover on it.
 *
 * The target must be empty. `--force` truncates non-empty target tables and
 * reloads them.
 */

import {
  mkdirSync,
  mkdtempSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, join } from "node:path";
import { parseArgs } from "node:util";

import {
  closePostgresFacades,
  getPostgresAsyncDb,
} from "../src/persistence/db-postgres-facade.js";
import {
  PG_STEPS,
  runPgMigrations,
} from "../src/persistence/pg-migrations/index.js";
import {
  loadSqliteToPostgres,
  snapshotSqliteDatabase,
  type SqliteLoadSource,
} from "../src/persistence/pg-migrations/sqlite-loader.js";

const USAGE = `Usage: bun run scripts/load-sqlite-to-postgres.ts --main <db> [--memory <db>] [--telemetry <db>]
       [--force] [--exclude <table>]... [--batch-size <n>] [--json <path>]
       [--snapshot-dir <dir>] [--keep-snapshots]

VELLUM_DATABASE_URL must point at the (empty) target database.`;

interface ParsedArgs {
  sources: SqliteLoadSource[];
  force: boolean;
  exclude: string[];
  batchSize?: number;
  pageSize?: number;
  jsonPath?: string;
  snapshotDir: string;
  keepSnapshots: boolean;
}

function fail(message: string): never {
  process.stderr.write(`${message}\n\n${USAGE}\n`);
  process.exit(2);
}

function positiveInteger(
  raw: string | undefined,
  flag: string,
): number | undefined {
  if (raw === undefined) {
    return undefined;
  }
  const value = Number(raw);
  if (!Number.isInteger(value) || value <= 0) {
    fail(`${flag} expects a positive integer, got ${raw}`);
  }
  return value;
}

function parseCli(): ParsedArgs {
  const { values } = parseArgs({
    options: {
      main: { type: "string" },
      memory: { type: "string" },
      telemetry: { type: "string" },
      force: { type: "boolean", default: false },
      exclude: { type: "string", multiple: true, default: [] },
      "batch-size": { type: "string" },
      "checksum-page-size": { type: "string" },
      json: { type: "string" },
      "snapshot-dir": { type: "string" },
      "keep-snapshots": { type: "boolean", default: false },
      help: { type: "boolean", default: false },
    },
    allowPositionals: false,
  });

  if (values.help) {
    process.stdout.write(`${USAGE}\n`);
    process.exit(0);
  }
  if (!values.main) {
    fail("--main is required");
  }

  const sources: SqliteLoadSource[] = [{ slot: "main", path: values.main }];
  if (values.memory) {
    sources.push({ slot: "memory", path: values.memory });
  }
  if (values.telemetry) {
    sources.push({ slot: "telemetry", path: values.telemetry });
  }

  const snapshotDir = values["snapshot-dir"]
    ? values["snapshot-dir"]
    : mkdtempSync(join(tmpdir(), "vellum-sqlite-load-"));
  mkdirSync(snapshotDir, { recursive: true });

  return {
    sources,
    force: values.force ?? false,
    exclude: values.exclude ?? [],
    batchSize: positiveInteger(values["batch-size"], "--batch-size"),
    pageSize: positiveInteger(
      values["checksum-page-size"],
      "--checksum-page-size",
    ),
    jsonPath: values.json,
    snapshotDir,
    keepSnapshots:
      (values["keep-snapshots"] ?? false) ||
      values["snapshot-dir"] !== undefined,
  };
}

function humanSize(bytes: number): string {
  if (bytes < 1024) {
    return `${bytes} B`;
  }
  const units = ["KB", "MB", "GB"];
  let value = bytes / 1024;
  let unit = 0;
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024;
    unit += 1;
  }
  return `${value.toFixed(1)} ${units[unit]}`;
}

async function main(): Promise<void> {
  const args = parseCli();
  const url = process.env.VELLUM_DATABASE_URL?.trim();
  if (!url) {
    fail("VELLUM_DATABASE_URL is not set");
  }

  const db = getPostgresAsyncDb("main", url, []);
  const snapshotDir = args.snapshotDir;
  try {
    const snapshots: SqliteLoadSource[] = [];
    for (const source of args.sources) {
      const snapshotPath = join(
        snapshotDir,
        `${source.slot}-${basename(source.path)}`,
      );
      process.stdout.write(
        `snapshot ${source.slot}: ${source.path} -> ${snapshotPath}\n`,
      );
      snapshotSqliteDatabase(source.path, snapshotPath);
      const size = statSync(snapshotPath).size;
      process.stdout.write(`  ${humanSize(size)}\n`);
      snapshots.push({ slot: source.slot, path: snapshotPath });
    }

    const migrations = await runPgMigrations(db, PG_STEPS);
    process.stdout.write(
      `migrations: applied [${migrations.applied.join(", ")}]` +
        ` skipped [${migrations.skipped.join(", ")}]\n`,
    );

    const report = await loadSqliteToPostgres(db, snapshots, {
      force: args.force,
      batchSize: args.batchSize,
      checksumPageSize: args.pageSize,
      excludeTables: args.exclude,
      onProgress: (message) => process.stdout.write(`${message}\n`),
    });

    process.stdout.write("\nTABLE RESULTS\n");
    const width = Math.max(
      20,
      ...report.tables.map((table) => table.table.length),
    );
    for (const table of report.tables) {
      const status = table.error
        ? `ERROR ${table.error}`
        : table.checksumOk
          ? "checksum OK"
          : `checksum MISMATCH source=${table.sourceChecksum} target=${table.targetChecksum}`;
      process.stdout.write(
        `${table.table.padEnd(width)}  ${String(table.sourceRows).padStart(9)}` +
          ` ${String(table.targetRows).padStart(9)}  ${status}  ${table.durationMs}ms\n`,
      );
    }

    if (report.skippedTables.length > 0) {
      process.stdout.write("\nSKIPPED\n");
      for (const skipped of report.skippedTables) {
        process.stdout.write(`  ${skipped.table}: ${skipped.reason}\n`);
      }
    }
    if (report.createdTables.length > 0) {
      process.stdout.write(
        `\ncreated tables not in the baseline: ${report.createdTables.join(", ")}\n`,
      );
    }
    if (report.addedColumns.length > 0) {
      process.stdout.write(
        `added columns not in the baseline: ${report.addedColumns.join(", ")}\n`,
      );
    }
    if (report.targetOnlyTables.length > 0) {
      process.stdout.write(
        `target-only tables left empty: ${report.targetOnlyTables.join(", ")}\n`,
      );
    }

    process.stdout.write(
      `\nTOTAL ${report.totals.tables} tables, ${report.totals.sourceRows} source rows, ` +
        `${report.totals.targetRows} target rows, ` +
        `${(report.totals.durationMs / 1000).toFixed(1)}s, ` +
        `${report.totals.failedTables} failed\n`,
    );

    if (args.jsonPath) {
      mkdirSync(dirname(args.jsonPath), { recursive: true });
      writeFileSync(args.jsonPath, JSON.stringify(report, null, 2));
      process.stdout.write(`report written to ${args.jsonPath}\n`);
    }

    process.exitCode = report.ok ? 0 : 1;
  } finally {
    await closePostgresFacades();
    if (!args.keepSnapshots) {
      rmSync(snapshotDir, { recursive: true, force: true });
    } else {
      process.stdout.write(`snapshots kept in ${snapshotDir}\n`);
    }
  }
}

await main();
