/**
 * Tests for `assistant db status`.
 *
 * The command is split into a read layer ({@link readDbStatus}) and a render
 * layer ({@link renderHuman}), both fed by a narrow {@link DbStatusConnection}
 * seam, so the SQL and the formatting are tested without a live server. The
 * command wiring is exercised end to end through commander with a fake
 * connection factory, which is the only thing `postgres.js` would otherwise
 * provide.
 */

import { afterEach, describe, expect, test } from "bun:test";

import { Command } from "commander";

import { applyCommandHelp } from "../../../lib/cli-command-help.js";
import { dbHelp } from "../index.help.js";
import { registerDbCommand } from "../index.js";
import type { DbStatusConnection } from "../status.js";
import { readDbStatus, registerDbStatus, renderHuman } from "../status.js";

const GIB = 1024 * 1024 * 1024;

// ---------------------------------------------------------------------------
// Fakes
// ---------------------------------------------------------------------------

interface SummaryOverrides {
  database?: string;
  size_bytes?: string | number;
  server_version?: string;
  server_version_full?: string;
  connections?: string | number;
  table_count?: string | number;
}

/** Rows shaped like the real catalog queries, with bigint-as-string values. */
function fakeConnection(options: {
  summary?: SummaryOverrides | null;
  byRows?: Record<string, unknown>[];
  bySize?: Record<string, unknown>[];
  failWith?: Error;
  seen?: string[];
}): DbStatusConnection {
  return {
    async query(sql) {
      options.seen?.push(sql);
      if (options.failWith) {
        throw options.failWith;
      }
      if (sql.includes("pg_database_size")) {
        if (options.summary === null) {
          return [];
        }
        return [
          {
            database: "vellum",
            // generic-examples:ignore-next-line — reason: Postgres bigint fixture, not a phone number
            size_bytes: "2147483648",
            server_version: "17.6",
            server_version_full:
              "PostgreSQL 17.6 (Debian 17.6-1.pgdg12+1) on aarch64-unknown-linux-gnu",
            connections: "14",
            table_count: "97",
            ...options.summary,
          },
        ];
      }
      if (sql.includes("reltuples")) {
        return (
          options.byRows ?? [
            { name: "messages", row_estimate: 132418 },
            { name: "tool_invocations", row_estimate: 17010 },
          ]
        );
      }
      if (sql.includes("pg_total_relation_size")) {
        return (
          options.bySize ?? [
            { name: "messages", size_bytes: "734003200" },
            { name: "tool_invocations", size_bytes: "10485760" },
          ]
        );
      }
      throw new Error(`unexpected query: ${sql}`);
    },
    async close() {},
  };
}

// ---------------------------------------------------------------------------
// Command harness
// ---------------------------------------------------------------------------

let restoreWorkspaceEnv: string | undefined;

afterEach(() => {
  if (restoreWorkspaceEnv === undefined) {
    delete process.env.VELLUM_DATABASE_URL;
  } else {
    process.env.VELLUM_DATABASE_URL = restoreWorkspaceEnv;
  }
  restoreWorkspaceEnv = undefined;
});

function setDatabaseUrl(value: string | undefined): void {
  restoreWorkspaceEnv = process.env.VELLUM_DATABASE_URL;
  if (value === undefined) {
    delete process.env.VELLUM_DATABASE_URL;
  } else {
    process.env.VELLUM_DATABASE_URL = value;
  }
}

/** Run `assistant db status` with the given args, capturing stdio + exit. */
async function runStatus(
  args: string[],
  connect: (url: string) => DbStatusConnection,
): Promise<{ stdout: string; stderr: string; exitCode: number }> {
  const stdoutChunks: string[] = [];
  const stderrChunks: string[] = [];
  let exitCode = 0;

  const originalStdoutWrite = process.stdout.write.bind(process.stdout);
  const originalStderrWrite = process.stderr.write.bind(process.stderr);
  const originalExit = process.exit;

  process.stdout.write = ((chunk: string | Uint8Array) => {
    stdoutChunks.push(
      typeof chunk === "string" ? chunk : new TextDecoder().decode(chunk),
    );
    return true;
  }) as typeof process.stdout.write;

  process.stderr.write = ((chunk: string | Uint8Array) => {
    stderrChunks.push(
      typeof chunk === "string" ? chunk : new TextDecoder().decode(chunk),
    );
    return true;
  }) as typeof process.stderr.write;

  // process.exit is captured by throwing — the command finishes its work
  // (including closing its connection) before exiting.
  process.exit = ((code?: number) => {
    exitCode = code ?? 0;
    throw new Error("__test_exit__");
  }) as typeof process.exit;

  try {
    const program = new Command();
    program.exitOverride();
    const db = program.command("db");
    applyCommandHelp(db, dbHelp);
    registerDbStatus(db, { connect });
    try {
      await program.parseAsync(["node", "assistant", "db", ...args]);
    } catch (e) {
      if ((e as Error).message !== "__test_exit__") {
        throw e;
      }
    }
  } finally {
    process.stdout.write = originalStdoutWrite;
    process.stderr.write = originalStderrWrite;
    process.exit = originalExit;
  }

  return {
    stdout: stdoutChunks.join(""),
    stderr: stderrChunks.join(""),
    exitCode,
  };
}

// ---------------------------------------------------------------------------
// Read layer
// ---------------------------------------------------------------------------

describe("readDbStatus", () => {
  test("coerces Postgres bigint strings to numbers", async () => {
    const report = await readDbStatus(fakeConnection({}));

    expect(report.database).toBe("vellum");
    expect(report.serverVersion).toBe("17.6");
    expect(report.sizeBytes).toBe(2 * GIB);
    expect(report.tableCount).toBe(97);
    expect(report.connections).toBe(14);
    expect(report.largestByRows).toEqual([
      { name: "messages", rows: 132418 },
      { name: "tool_invocations", rows: 17010 },
    ]);
    expect(report.largestBySize).toEqual([
      { name: "messages", sizeBytes: 734003200 },
      { name: "tool_invocations", sizeBytes: 10485760 },
    ]);
  });

  test("preserves the server-reported ordering of both lists", async () => {
    const report = await readDbStatus(
      fakeConnection({
        byRows: [
          { name: "b", row_estimate: 10 },
          { name: "a", row_estimate: 5 },
        ],
        bySize: [
          { name: "a", size_bytes: 4096 },
          { name: "b", size_bytes: 1024 },
        ],
      }),
    );

    expect(report.largestByRows.map((t) => t.name)).toEqual(["b", "a"]);
    expect(report.largestBySize.map((t) => t.name)).toEqual(["a", "b"]);
  });

  test("keeps a never-analyzed table at zero rows instead of a negative estimate", async () => {
    // Postgres reports reltuples = -1 for a table ANALYZE has never seen; the
    // query clamps it with GREATEST(..., 0), which the fake mirrors.
    const report = await readDbStatus(
      fakeConnection({ byRows: [{ name: "fresh", row_estimate: 0 }] }),
    );

    expect(report.largestByRows).toEqual([{ name: "fresh", rows: 0 }]);
  });

  test("issues read-only catalog queries", async () => {
    const seen: string[] = [];
    await readDbStatus(fakeConnection({ seen }));

    expect(seen).toHaveLength(3);
    for (const sql of seen) {
      expect(sql.trim().toUpperCase().startsWith("SELECT")).toBe(true);
      expect(sql.toUpperCase()).not.toMatch(/\b(INSERT|UPDATE|DELETE|DROP)\b/);
    }
    expect(seen[0]).toContain("pg_database_size");
    expect(seen[0]).toContain("pg_stat_activity");
    expect(seen[1]).toContain("reltuples");
    expect(seen[2]).toContain("pg_total_relation_size");
  });

  test("throws when the summary query returns no rows", async () => {
    await expect(
      readDbStatus(fakeConnection({ summary: null })),
    ).rejects.toThrow("the database summary query returned no rows");
  });
});

// ---------------------------------------------------------------------------
// Render layer
// ---------------------------------------------------------------------------

describe("renderHuman", () => {
  test("renders the identity, size, version, and connection count", async () => {
    const out = renderHuman(await readDbStatus(fakeConnection({})));

    expect(out).toMatch(/Database\s+vellum/);
    expect(out).toMatch(/Server version\s+17\.6/);
    expect(out).toMatch(/Size\s+2\.00 GB/);
    expect(out).toMatch(/Tables\s+97/);
    expect(out).toMatch(/Connections\s+14/);
  });

  test("renders both largest-table lists in order with their units", async () => {
    const out = renderHuman(await readDbStatus(fakeConnection({})));

    expect(out).toContain("Largest tables (by rows");
    expect(out).toContain("Largest tables (by size");
    expect(out).toContain("132,418 rows");
    expect(out).toContain("700.0 MB");
    expect(out.indexOf("132,418 rows")).toBeLessThan(
      out.indexOf("17,010 rows"),
    );
    expect(out.indexOf("700.0 MB")).toBeLessThan(out.indexOf("10.0 MB"));
  });

  test("says so when the database has no tables", async () => {
    const out = renderHuman(
      await readDbStatus(fakeConnection({ byRows: [], bySize: [] })),
    );

    expect(out.match(/\(no tables\)/g)).toHaveLength(2);
  });
});

// ---------------------------------------------------------------------------
// Command wiring
// ---------------------------------------------------------------------------

describe("assistant db status", () => {
  test("prints the human report and exits 0", async () => {
    setDatabaseUrl("postgresql://vellum:pw@postgres:5432/vellum");

    const { stdout, stderr, exitCode } = await runStatus(["status"], () =>
      fakeConnection({}),
    );

    expect(exitCode).toBe(0);
    expect(stderr).toBe("");
    expect(stdout).toContain("Database");
    expect(stdout).toContain("vellum");
    expect(stdout).toContain("Largest tables (by rows");
  });

  test("--json emits a single-line JSON report", async () => {
    setDatabaseUrl("postgresql://vellum:pw@postgres:5432/vellum");

    const { stdout, exitCode } = await runStatus(["--json", "status"], () =>
      fakeConnection({}),
    );

    expect(exitCode).toBe(0);
    expect(stdout.trim().split("\n")).toHaveLength(1);
    const parsed = JSON.parse(stdout);
    expect(parsed.database).toBe("vellum");
    expect(parsed.serverVersion).toBe("17.6");
    expect(parsed.sizeBytes).toBe(2 * GIB);
    expect(parsed.tableCount).toBe(97);
    expect(parsed.connections).toBe(14);
    expect(parsed.largestByRows[0]).toEqual({
      name: "messages",
      rows: 132418,
    });
    expect(parsed.largestBySize[0]).toEqual({
      name: "messages",
      sizeBytes: 734003200,
    });
  });

  test("closes the connection before exiting", async () => {
    setDatabaseUrl("postgresql://vellum:pw@postgres:5432/vellum");
    let closed = false;
    const connection = fakeConnection({});
    connection.close = async () => {
      closed = true;
    };

    await runStatus(["status"], () => connection);

    expect(closed).toBe(true);
  });

  test("exits 1 with a loud error when VELLUM_DATABASE_URL is unset", async () => {
    setDatabaseUrl(undefined);

    const { stdout, stderr, exitCode } = await runStatus(["status"], () => {
      throw new Error("must not connect without a URL");
    });

    expect(exitCode).toBe(1);
    expect(stdout).toBe("");
    expect(stderr).toContain("ERROR");
    expect(stderr).toContain("VELLUM_DATABASE_URL is not set");
  });

  test("--json unset URL emits a structured error and exits 1", async () => {
    setDatabaseUrl("   ");

    const { stdout, exitCode } = await runStatus(["--json", "status"], () => {
      throw new Error("must not connect without a URL");
    });

    expect(exitCode).toBe(1);
    expect(JSON.parse(stdout)).toEqual({
      error: expect.stringContaining("VELLUM_DATABASE_URL is not set"),
    });
  });

  test("exits 1 and reports the driver error when the database is unreachable", async () => {
    setDatabaseUrl("postgresql://vellum:pw@postgres:5432/vellum");

    const { stdout, stderr, exitCode } = await runStatus(["status"], () =>
      fakeConnection({
        failWith: new Error("connect ECONNREFUSED 172.21.0.6:5432"),
      }),
    );

    expect(exitCode).toBe(1);
    expect(stdout).toBe("");
    expect(stderr).toContain("ERROR");
    expect(stderr).toContain("connect ECONNREFUSED 172.21.0.6:5432");
  });

  test("exits 1 when the connection factory itself rejects the URL", async () => {
    setDatabaseUrl("not-a-url");

    const { stderr, exitCode } = await runStatus(["status"], () => {
      throw new Error("Invalid URL");
    });

    expect(exitCode).toBe(1);
    expect(stderr).toContain("Failed to read the assistant database");
    expect(stderr).toContain("Invalid URL");
  });

  test("registers only the status subcommand", () => {
    const program = new Command();
    registerDbCommand(program);

    const db = program.commands.find((c) => c.name() === "db");
    expect(db).toBeDefined();
    expect(db?.commands.map((c) => c.name())).toEqual(["status"]);
  });
});
