import { bigint, index, pgTable, primaryKey, text } from "drizzle-orm/pg-core";

export const workflowRuns = pgTable(
  "workflow_runs",
  {
    id: text("id").primaryKey(),
    name: text("name"),
    scriptSource: text("script_source").notNull(),
    scriptHash: text("script_hash").notNull(),
    argsJson: text("args_json"),
    capabilitiesJson: text("capabilities_json"),
    status: text("status").notNull(),
    conversationId: text("conversation_id"),
    agentsSpawned: bigint("agents_spawned", { mode: "number" })
      .notNull()
      .default(0),
    inputTokens: bigint("input_tokens", { mode: "number" })
      .notNull()
      .default(0),
    outputTokens: bigint("output_tokens", { mode: "number" })
      .notNull()
      .default(0),
    resultJson: text("result_json"),
    error: text("error"),
    createdAt: bigint("created_at", { mode: "number" }),
    updatedAt: bigint("updated_at", { mode: "number" }),
    finishedAt: bigint("finished_at", { mode: "number" }),
    trustJson: text("trust_json"),
  },
  (table) => [
    index("idx_workflow_runs_status_created_at").on(
      table.status,
      table.createdAt,
    ),
  ],
);

// Append-only journal of each workflow's agent() calls, keyed by run + sequence
// for crash-recovery replay.
export const workflowJournal = pgTable(
  "workflow_journal",
  {
    runId: text("run_id").notNull(),
    seq: bigint("seq", { mode: "number" }).notNull(),
    callHash: text("call_hash").notNull(),
    kind: text("kind").notNull(),
    requestJson: text("request_json"),
    resultJson: text("result_json"),
    status: text("status").notNull(),
    createdAt: bigint("created_at", { mode: "number" }),
    inputTokens: bigint("input_tokens", { mode: "number" }),
    outputTokens: bigint("output_tokens", { mode: "number" }),
  },
  (table) => [primaryKey({ columns: [table.runId, table.seq] })],
);
