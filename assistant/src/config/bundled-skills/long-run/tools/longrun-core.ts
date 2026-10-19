/**
 * long-run — shared core for the long-run supervisor skill.
 *
 * The skill declares thin tool executors (tools/*.ts) that all delegate here.
 * All of them run with `execution_target: "host"`, i.e. dynamically imported
 * into the assistant daemon, so they receive the conversation id via
 * `ToolContext` and can persist state on disk.
 *
 * State layout (workspace-relative):
 *   long-run/runs/<id>.json    — owned by the tools (this file)
 *   long-run/watch/<id>.json   — owned by the watcher script-schedule
 *
 * Writes are atomic (tmp + rename) so a reader never sees a partial file. The
 * two writers touch disjoint files, so there is no lock to take.
 */

import {
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  renameSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";

import type {
  ToolContext,
  ToolExecutionResult,
} from "../../../../tools/types.js";

// ─── Types ───────────────────────────────────────────────────────────────────

type TodoStatus = "pending" | "doing" | "done" | "skipped" | "blocked";
type RunStatus = "active" | "blocked" | "done";

const TODO_STATUSES: TodoStatus[] = [
  "pending",
  "doing",
  "done",
  "skipped",
  "blocked",
];
const TERMINAL_TODO: TodoStatus[] = ["done", "skipped", "blocked"];

interface Todo {
  id: string;
  text: string;
  status: TodoStatus;
  updated_at: string;
  note?: string;
}
interface Dod {
  id: string;
  text: string;
  satisfied: boolean;
  evidence?: string;
}
interface Participant {
  conversation_id: string;
  from: string;
  to: string | null;
}
interface ChangelogEntry {
  ts: string;
  actor: string;
  action: string;
  before?: unknown;
  after?: unknown;
  reason?: string;
}
interface Watch {
  id: string;
  label: string;
  via: string;
  ready_when: string;
  failed_when?: string;
  created_at: string;
  timeout_at: string;
  note?: string;
}
interface Run {
  id: string;
  label: string;
  created_at: string;
  status: RunStatus;
  owner_conversation_id: string;
  participants: Participant[];
  todos: Todo[];
  dod: Dod[];
  postpone_until: string | null;
  watches?: Watch[];
  block?: { reason: string; need_from_user: string; at: string };
  changelog: ChangelogEntry[];
}

// ─── Result helpers ──────────────────────────────────────────────────────────

function ok(content: string): ToolExecutionResult {
  return { content, isError: false };
}
function err(content: string): ToolExecutionResult {
  return { content, isError: true };
}
function errCode(content: string, errorCode: string): ToolExecutionResult {
  return { content, isError: true, errorCode };
}

// ─── Paths & IO ──────────────────────────────────────────────────────────────

function nowIso(): string {
  return new Date().toISOString();
}

function workspaceDir(context: ToolContext): string {
  return process.env.VELLUM_WORKSPACE_DIR || context.workingDir || "/workspace";
}

function runsDir(context: ToolContext): string {
  return join(workspaceDir(context), "data", "long-run", "runs");
}

function runPath(context: ToolContext, id: string): string {
  return join(runsDir(context), `${id}.json`);
}

function readRun(context: ToolContext, id: string): Run | null {
  const p = runPath(context, id);
  if (!existsSync(p)) {
    return null;
  }
  try {
    return JSON.parse(readFileSync(p, "utf-8")) as Run;
  } catch {
    return null;
  }
}

function writeRun(context: ToolContext, run: Run): void {
  const dir = runsDir(context);
  mkdirSync(dir, { recursive: true });
  const p = join(dir, `${run.id}.json`);
  const tmp = `${p}.${process.pid}.${Date.now()}.tmp`;
  writeFileSync(tmp, JSON.stringify(run, null, 2), "utf-8");
  renameSync(tmp, p);
}

function listRuns(context: ToolContext): Run[] {
  const dir = runsDir(context);
  if (!existsSync(dir)) {
    return [];
  }
  const out: Run[] = [];
  for (const f of readdirSync(dir)) {
    if (!f.endsWith(".json")) {
      continue;
    }
    const r = readRun(context, f.slice(0, -5));
    if (r) {
      out.push(r);
    }
  }
  out.sort((a, b) => a.created_at.localeCompare(b.created_at));
  return out;
}

// ─── Naming ──────────────────────────────────────────────────────────────────

function slugify(s: string): string {
  const base = s
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 40);
  return base || "run";
}

function ymd(): string {
  return new Date().toISOString().slice(0, 10).replace(/-/g, "");
}

function makeId(context: ToolContext, label: string): string {
  const base = `${slugify(label)}-${ymd()}`;
  let id = base;
  let n = 2;
  while (existsSync(runPath(context, id))) {
    id = `${base}-${n}`;
    n += 1;
  }
  return id;
}

// ─── Input coercion ──────────────────────────────────────────────────────────

function asString(v: unknown): string | undefined {
  return typeof v === "string" && v.trim() ? v.trim() : undefined;
}

function asTextList(v: unknown): string[] {
  if (!Array.isArray(v)) {
    return [];
  }
  const out: string[] = [];
  for (const item of v) {
    if (typeof item === "string" && item.trim()) {
      out.push(item.trim());
    } else if (item && typeof item === "object") {
      const t = (item as Record<string, unknown>).text;
      if (typeof t === "string" && t.trim()) {
        out.push(t.trim());
      }
    }
  }
  return out;
}

function nextTodoId(todos: Todo[]): string {
  let max = 0;
  for (const t of todos) {
    const m = /^t(\d+)$/.exec(t.id);
    if (m) {
      max = Math.max(max, Number(m[1]));
    }
  }
  return `t${max + 1}`;
}

function nextDodId(dod: Dod[]): string {
  let max = 0;
  for (const d of dod) {
    const m = /^d(\d+)$/.exec(d.id);
    if (m) {
      max = Math.max(max, Number(m[1]));
    }
  }
  return `d${max + 1}`;
}

function nextWatchId(watches: Watch[]): string {
  let max = 0;
  for (const w of watches) {
    const m = /^w(\d+)$/.exec(w.id);
    if (m) {
      max = Math.max(max, Number(m[1]));
    }
  }
  return `w${max + 1}`;
}

// ─── Derived state ───────────────────────────────────────────────────────────

function isComplete(run: Run): boolean {
  return (
    run.todos.every((t) => TERMINAL_TODO.includes(t.status)) &&
    run.dod.every((d) => d.satisfied)
  );
}

function todoCounts(run: Run): { total: number; terminal: number } {
  return {
    total: run.todos.length,
    terminal: run.todos.filter((t) => TERMINAL_TODO.includes(t.status)).length,
  };
}

function dodCounts(run: Run): { total: number; satisfied: number } {
  return {
    total: run.dod.length,
    satisfied: run.dod.filter((d) => d.satisfied).length,
  };
}

function summary(run: Run): string {
  const t = todoCounts(run);
  const d = dodCounts(run);
  const lines = [
    `Run ${run.id} [${run.status}] "${run.label}"`,
    `owner: ${run.owner_conversation_id}`,
    `todos: ${t.terminal}/${t.total} terminal`,
    `dod: ${d.satisfied}/${d.total} satisfied`,
    `postpone_until: ${run.postpone_until ?? "-"}`,
  ];
  const watches = run.watches ?? [];
  if (watches.length > 0) {
    const wl = watches
      .map(
        (w) =>
          `${w.id} "${w.label}" (timeout ${w.timeout_at}${w.failed_when ? ", fail-check" : ""})`,
      )
      .join("; ");
    lines.push(`watches: ${wl}`);
  }
  if (run.status === "active" && isComplete(run)) {
    lines.push(
      "NOTE: all todos are terminal and all DoD are satisfied — call long_run_end if the run is really finished.",
    );
  }
  if (run.status === "blocked") {
    lines.push(
      `blocked: ${run.block?.reason ?? "-"} | need_from_user: ${run.block?.need_from_user ?? "-"}`,
    );
  }
  return lines.join("\n");
}

function ownerGuard(
  run: Run,
  context: ToolContext,
): ToolExecutionResult | null {
  if (run.owner_conversation_id !== context.conversationId) {
    return err(
      `Run "${run.id}" is controlled by conversation ${run.owner_conversation_id}. Call long_run_claim to take it over before modifying it.`,
    );
  }
  return null;
}

/** A blocked run is binding: mutating tools are refused. */
function blockedGuard(run: Run): ToolExecutionResult | null {
  if (run.status !== "blocked") {
    return null;
  }
  const b = run.block;
  return errCode(
    `Run "${run.id}" is blocked: ${b?.reason ?? "-"}. Needed from the user: ${b?.need_from_user ?? "-"}. To resume it call long_run_resume, or long_run_end to close it.`,
    "run_blocked",
  );
}

/** Ownership + not-blocked guard for the tools that mutate an open run. */
function mutGuard(run: Run, context: ToolContext): ToolExecutionResult | null {
  const owner = ownerGuard(run, context);
  if (owner) {
    return owner;
  }
  return blockedGuard(run);
}

// ─── Tools ───────────────────────────────────────────────────────────────────

export async function longRunPlan(
  input: Record<string, unknown>,
  context: ToolContext,
): Promise<ToolExecutionResult> {
  const label = asString(input.label);
  const todos = asTextList(input.todos);
  const dod = asTextList(input.dod);
  if (!label) {
    return err("label is required (a short human-readable name for the run).");
  }
  if (todos.length === 0) {
    return err("todos is required and must contain at least one task.");
  }
  if (dod.length === 0) {
    return err(
      "dod is required and must contain at least one definition-of-done criterion.",
    );
  }
  const existing = listRuns(context).find(
    (r) =>
      r.owner_conversation_id === context.conversationId && r.status !== "done",
  );
  if (existing) {
    return err(
      `This conversation already owns an open run "${existing.id}". Close it with long_run_end or long_run_block before starting a new one.`,
    );
  }
  const id = makeId(context, label);
  const ts = nowIso();
  const run: Run = {
    id,
    label,
    created_at: ts,
    status: "active",
    owner_conversation_id: context.conversationId,
    participants: [
      { conversation_id: context.conversationId, from: ts, to: null },
    ],
    todos: todos.map((text, i) => ({
      id: `t${i + 1}`,
      text,
      status: "pending" as TodoStatus,
      updated_at: ts,
    })),
    dod: dod.map((text, i) => ({ id: `d${i + 1}`, text, satisfied: false })),
    postpone_until: null,
    watches: [],
    changelog: [
      {
        ts,
        actor: context.conversationId,
        action: "plan",
        after: { label, todos, dod },
      },
    ],
  };
  writeRun(context, run);
  return ok(
    `Long-run created: ${run.id}\n${summary(run)}\n\nThe supervisor checks every 5 minutes and wakes this conversation if it goes idle before the run is closed.`,
  );
}

export async function longRunUpdate(
  input: Record<string, unknown>,
  context: ToolContext,
): Promise<ToolExecutionResult> {
  const id = asString(input.run_id);
  if (!id) {
    return err("run_id is required.");
  }
  const run = readRun(context, id);
  if (!run) {
    return err(`Run "${id}" not found.`);
  }
  const guard = mutGuard(run, context);
  if (guard) {
    return guard;
  }
  const ops = Array.isArray(input.ops) ? input.ops : [];
  if (ops.length === 0) {
    return err("ops is required (at least one operation).");
  }
  const reason = asString(input.reason);
  const ts = nowIso();
  const applied: string[] = [];

  for (const raw of ops) {
    if (!raw || typeof raw !== "object") {
      continue;
    }
    const op = raw as Record<string, unknown>;
    const type = asString(op.type);
    switch (type) {
      case "mark_todo": {
        const t = run.todos.find((x) => x.id === asString(op.todo_id));
        if (!t) {
          applied.push(`mark_todo: unknown todo ${String(op.todo_id)}`);
          break;
        }
        const status = asString(op.status) as TodoStatus | undefined;
        if (!status || !TODO_STATUSES.includes(status)) {
          applied.push(`mark_todo: invalid status ${String(op.status)}`);
          break;
        }
        const before = t.status;
        t.status = status;
        t.updated_at = ts;
        const note = asString(op.note);
        if (note) {
          t.note = note;
        }
        run.changelog.push({
          ts,
          actor: context.conversationId,
          action: "mark_todo",
          before: { id: t.id, status: before },
          after: { id: t.id, status },
          reason,
        });
        applied.push(`${t.id}=${status}`);
        break;
      }
      case "add_todo": {
        const text = asString(op.text);
        if (!text) {
          applied.push("add_todo: missing text");
          break;
        }
        const t: Todo = {
          id: nextTodoId(run.todos),
          text,
          status: "pending",
          updated_at: ts,
        };
        run.todos.push(t);
        run.changelog.push({
          ts,
          actor: context.conversationId,
          action: "add_todo",
          after: { id: t.id, text },
          reason,
        });
        applied.push(`+${t.id}`);
        break;
      }
      case "edit_todo": {
        const t = run.todos.find((x) => x.id === asString(op.todo_id));
        const text = asString(op.text);
        if (!t || !text) {
          applied.push(`edit_todo: ${!t ? "unknown todo" : "missing text"}`);
          break;
        }
        const before = t.text;
        t.text = text;
        t.updated_at = ts;
        run.changelog.push({
          ts,
          actor: context.conversationId,
          action: "edit_todo",
          before: { id: t.id, text: before },
          after: { id: t.id, text },
          reason,
        });
        applied.push(`~${t.id}`);
        break;
      }
      case "remove_todo": {
        const idx = run.todos.findIndex((x) => x.id === asString(op.todo_id));
        if (idx < 0) {
          applied.push(`remove_todo: unknown todo ${String(op.todo_id)}`);
          break;
        }
        const [removed] = run.todos.splice(idx, 1);
        run.changelog.push({
          ts,
          actor: context.conversationId,
          action: "remove_todo",
          before: { id: removed!.id, text: removed!.text },
          reason,
        });
        applied.push(`-${removed!.id}`);
        break;
      }
      case "set_dod": {
        const d = run.dod.find((x) => x.id === asString(op.dod_id));
        if (!d) {
          applied.push(`set_dod: unknown dod ${String(op.dod_id)}`);
          break;
        }
        if (typeof op.satisfied !== "boolean") {
          applied.push("set_dod: satisfied must be a boolean");
          break;
        }
        const before = d.satisfied;
        d.satisfied = op.satisfied;
        const evidence = asString(op.evidence);
        if (evidence) {
          d.evidence = evidence;
        }
        run.changelog.push({
          ts,
          actor: context.conversationId,
          action: "set_dod",
          before: { id: d.id, satisfied: before },
          after: { id: d.id, satisfied: d.satisfied },
          reason,
        });
        applied.push(`${d.id}=${d.satisfied}`);
        break;
      }
      case "add_dod": {
        const text = asString(op.text);
        if (!text) {
          applied.push("add_dod: missing text");
          break;
        }
        const d: Dod = { id: nextDodId(run.dod), text, satisfied: false };
        run.dod.push(d);
        run.changelog.push({
          ts,
          actor: context.conversationId,
          action: "add_dod",
          after: { id: d.id, text },
          reason,
        });
        applied.push(`+${d.id}`);
        break;
      }
      case "edit_dod": {
        const d = run.dod.find((x) => x.id === asString(op.dod_id));
        const text = asString(op.text);
        if (!d || !text) {
          applied.push(`edit_dod: ${!d ? "unknown dod" : "missing text"}`);
          break;
        }
        const before = d.text;
        d.text = text;
        run.changelog.push({
          ts,
          actor: context.conversationId,
          action: "edit_dod",
          before: { id: d.id, text: before },
          after: { id: d.id, text },
          reason,
        });
        applied.push(`~${d.id}`);
        break;
      }
      case "remove_dod": {
        const idx = run.dod.findIndex((x) => x.id === asString(op.dod_id));
        if (idx < 0) {
          applied.push(`remove_dod: unknown dod ${String(op.dod_id)}`);
          break;
        }
        const [removed] = run.dod.splice(idx, 1);
        run.changelog.push({
          ts,
          actor: context.conversationId,
          action: "remove_dod",
          before: { id: removed!.id, text: removed!.text },
          reason,
        });
        applied.push(`-${removed!.id}`);
        break;
      }
      default:
        applied.push(`unknown op: ${String(type)}`);
    }
  }

  writeRun(context, run);
  return ok(
    `Run ${run.id} updated (${applied.length} op: ${applied.join(", ")})\n${summary(run)}`,
  );
}

export async function longRunRead(
  input: Record<string, unknown>,
  context: ToolContext,
): Promise<ToolExecutionResult> {
  const id = asString(input.run_id);
  if (id) {
    const run = readRun(context, id);
    if (!run) {
      return err(`Run "${id}" not found.`);
    }
    return ok(JSON.stringify(run, null, 2));
  }
  const mine = listRuns(context).filter(
    (r) => r.owner_conversation_id === context.conversationId,
  );
  if (mine.length === 0) {
    return ok("No runs owned by this conversation.");
  }
  return ok(mine.map(summary).join("\n\n"));
}

export async function longRunList(
  _input: Record<string, unknown>,
  context: ToolContext,
): Promise<ToolExecutionResult> {
  const runs = listRuns(context);
  if (runs.length === 0) {
    return ok("No long-runs found.");
  }
  const now = Date.now();
  const lines = runs.map((run) => {
    const t = todoCounts(run);
    const d = dodCounts(run);
    const lastTs = run.changelog.length
      ? run.changelog[run.changelog.length - 1]!.ts
      : run.created_at;
    const ageH = Math.max(0, (now - new Date(lastTs).getTime()) / 3_600_000);
    const stale = run.status !== "done" && ageH > 24 ? " STALE" : "";
    const watches = (run.watches ?? []).length;
    const w = watches > 0 ? ` watches=${watches}` : "";
    return `${run.id} [${run.status}] "${run.label}" owner=${run.owner_conversation_id.slice(0, 8)} todos=${t.terminal}/${t.total} dod=${d.satisfied}/${d.total}${w} last=${lastTs}${stale}`;
  });
  return ok(lines.join("\n"));
}

export async function longRunClaim(
  input: Record<string, unknown>,
  context: ToolContext,
): Promise<ToolExecutionResult> {
  const id = asString(input.run_id);
  if (!id) {
    return err("run_id is required.");
  }
  const run = readRun(context, id);
  if (!run) {
    return err(`Run "${id}" not found.`);
  }
  if (run.owner_conversation_id === context.conversationId) {
    return ok(
      `Run ${run.id} is already owned by this conversation.\n${summary(run)}`,
    );
  }
  const ts = nowIso();
  const previous = run.owner_conversation_id;
  const open = run.participants.find((p) => p.to === null);
  if (open) {
    open.to = ts;
  }
  run.participants.push({
    conversation_id: context.conversationId,
    from: ts,
    to: null,
  });
  run.owner_conversation_id = context.conversationId;
  run.changelog.push({
    ts,
    actor: context.conversationId,
    action: "claim",
    before: previous,
    after: context.conversationId,
  });
  writeRun(context, run);
  return ok(`Run ${run.id} claimed from ${previous}.\n${summary(run)}`);
}

export async function longRunNote(
  input: Record<string, unknown>,
  context: ToolContext,
): Promise<ToolExecutionResult> {
  const id = asString(input.run_id);
  const text = asString(input.text);
  if (!id || !text) {
    return err("run_id and text are required.");
  }
  const run = readRun(context, id);
  if (!run) {
    return err(`Run "${id}" not found.`);
  }
  const guard = mutGuard(run, context);
  if (guard) {
    return guard;
  }
  run.changelog.push({
    ts: nowIso(),
    actor: context.conversationId,
    action: "note",
    after: { text },
  });
  writeRun(context, run);
  return ok(`Note recorded on run ${run.id}.`);
}

export async function longRunPostpone(
  input: Record<string, unknown>,
  context: ToolContext,
): Promise<ToolExecutionResult> {
  const id = asString(input.run_id);
  const minutesRaw = input.minutes;
  if (!id) {
    return err("run_id is required.");
  }
  const minutes = typeof minutesRaw === "number" ? Math.floor(minutesRaw) : NaN;
  if (!Number.isFinite(minutes) || minutes < 1) {
    return err("minutes is required (1-30).");
  }
  const capped = Math.min(minutes, 30);
  const run = readRun(context, id);
  if (!run) {
    return err(`Run "${id}" not found.`);
  }
  const guard = mutGuard(run, context);
  if (guard) {
    return guard;
  }
  const ts = nowIso();
  run.postpone_until = new Date(Date.now() + capped * 60_000).toISOString();
  run.changelog.push({
    ts,
    actor: context.conversationId,
    action: "postpone",
    after: { minutes: capped, until: run.postpone_until },
  });
  writeRun(context, run);
  return ok(
    `Next wake postponed by ${capped} minute(s) (until ${run.postpone_until}).`,
  );
}

export async function longRunWatch(
  input: Record<string, unknown>,
  context: ToolContext,
): Promise<ToolExecutionResult> {
  const id = asString(input.run_id);
  const label = asString(input.label);
  const readyWhen = asString(input.ready_when);
  const failedWhen = asString(input.failed_when);
  const via = asString(input.via) ?? "container";
  const note = asString(input.note);
  const timeoutRaw = input.timeout_minutes;
  if (!id) {
    return err("run_id is required.");
  }
  if (!label) {
    return err("label is required (a short name for the wait).");
  }
  if (!readyWhen) {
    return err(
      "ready_when is required (an idempotent check that exits 0 when the wait is over).",
    );
  }
  if (via !== "container" && via !== "host" && !via.startsWith("ssh:")) {
    return err(
      `via must be "container", "host", or "ssh:<hostname>" (got "${via}").`,
    );
  }
  const timeoutMinutes =
    typeof timeoutRaw === "number" ? Math.floor(timeoutRaw) : NaN;
  if (!Number.isFinite(timeoutMinutes) || timeoutMinutes < 1) {
    return err("timeout_minutes is required and must be at least 1.");
  }
  const run = readRun(context, id);
  if (!run) {
    return err(`Run "${id}" not found.`);
  }
  const guard = mutGuard(run, context);
  if (guard) {
    return guard;
  }
  run.watches = run.watches ?? [];
  const ts = nowIso();
  const watch: Watch = {
    id: nextWatchId(run.watches),
    label,
    via,
    ready_when: readyWhen,
    ...(failedWhen ? { failed_when: failedWhen } : {}),
    created_at: ts,
    timeout_at: new Date(Date.now() + timeoutMinutes * 60_000).toISOString(),
    ...(note ? { note } : {}),
  };
  run.watches.push(watch);
  run.changelog.push({
    ts,
    actor: context.conversationId,
    action: "watch",
    after: {
      id: watch.id,
      label,
      via,
      ready_when: watch.ready_when,
      failed_when: watch.failed_when,
      timeout_at: watch.timeout_at,
    },
  });
  writeRun(context, run);
  return ok(
    `Watch ${watch.id} declared: "${label}" (via ${via}, timeout ${watch.timeout_at}${watch.failed_when ? ", with a failure check" : ""}). The supervisor will not nudge this run while the wait is pending. It wakes you once when ready_when exits 0 (success), when failed_when exits 0 (failure), when both are true at once (neutral), or when the timeout expires (neutral).\n\nBefore ending this turn, wait a few seconds and verify the process you started has actually started and shows no obvious startup or initial error. Then continue working or wait; you will be notified when one of those happens.`,
  );
}

export async function longRunWatchClear(
  input: Record<string, unknown>,
  context: ToolContext,
): Promise<ToolExecutionResult> {
  const id = asString(input.run_id);
  const watchId = asString(input.watch_id);
  if (!id || !watchId) {
    return err("run_id and watch_id are required.");
  }
  const run = readRun(context, id);
  if (!run) {
    return err(`Run "${id}" not found.`);
  }
  const guard = mutGuard(run, context);
  if (guard) {
    return guard;
  }
  run.watches = run.watches ?? [];
  const idx = run.watches.findIndex((w) => w.id === watchId);
  if (idx < 0) {
    return err(`Watch "${watchId}" not found on run ${run.id}.`);
  }
  const [removed] = run.watches.splice(idx, 1);
  run.changelog.push({
    ts: nowIso(),
    actor: context.conversationId,
    action: "watch_clear",
    before: { id: removed!.id, label: removed!.label },
  });
  writeRun(context, run);
  return ok(`Watch ${removed!.id} cleared.`);
}

export async function longRunBlock(
  input: Record<string, unknown>,
  context: ToolContext,
): Promise<ToolExecutionResult> {
  const id = asString(input.run_id);
  const reason = asString(input.reason);
  const needFromUser = asString(input.need_from_user);
  if (!id || !reason || !needFromUser) {
    return err("run_id, reason and need_from_user are required.");
  }
  const run = readRun(context, id);
  if (!run) {
    return err(`Run "${id}" not found.`);
  }
  const guard = ownerGuard(run, context);
  if (guard) {
    return guard;
  }
  const ts = nowIso();
  const before = run.status;
  run.status = "blocked";
  run.block = { reason, need_from_user: needFromUser, at: ts };
  run.changelog.push({
    ts,
    actor: context.conversationId,
    action: "block",
    before,
    after: { status: "blocked", reason, need_from_user: needFromUser },
  });
  writeRun(context, run);
  return ok(
    `Run ${run.id} marked blocked and waiting for the user.\n${summary(run)}\n\nA single confirmation wake will be sent, then the supervisor stays silent until the user acts or you resume.`,
  );
}

export async function longRunEnd(
  input: Record<string, unknown>,
  context: ToolContext,
): Promise<ToolExecutionResult> {
  const id = asString(input.run_id);
  if (!id) {
    return err("run_id is required.");
  }
  const run = readRun(context, id);
  if (!run) {
    return err(`Run "${id}" not found.`);
  }
  const guard = ownerGuard(run, context);
  if (guard) {
    return guard;
  }
  const force = input.force === true;
  if (!isComplete(run) && !force) {
    const unmetTodos = run.todos
      .filter((t) => !TERMINAL_TODO.includes(t.status))
      .map((t) => `${t.id} (${t.status})`);
    const unmetDod = run.dod.filter((d) => !d.satisfied).map((d) => d.id);
    const parts: string[] = [];
    if (unmetTodos.length) {
      parts.push(`todos not terminal: ${unmetTodos.join(", ")}`);
    }
    if (unmetDod.length) {
      parts.push(`DoD not satisfied: ${unmetDod.join(", ")}`);
    }
    return err(
      `Run ${run.id} is not complete — ${parts.join("; ")}. Finish the work, or pass force=true to close it anyway.`,
    );
  }
  const ts = nowIso();
  const before = run.status;
  run.status = "done";
  const summaryText = asString(input.summary);
  run.changelog.push({
    ts,
    actor: context.conversationId,
    action: "end",
    before,
    after: {
      status: "done",
      forced: force && !isComplete(run),
      summary: summaryText,
    },
  });
  writeRun(context, run);
  return ok(
    `Run ${run.id} closed as done.${summaryText ? `\n${summaryText}` : ""}`,
  );
}

export async function longRunResume(
  input: Record<string, unknown>,
  context: ToolContext,
): Promise<ToolExecutionResult> {
  const id = asString(input.run_id);
  if (!id) {
    return err("run_id is required.");
  }
  const run = readRun(context, id);
  if (!run) {
    return err(`Run "${id}" not found.`);
  }
  const guard = ownerGuard(run, context);
  if (guard) {
    return guard;
  }
  if (run.status !== "blocked") {
    return ok(`Run ${run.id} is not blocked (status: ${run.status}).`);
  }
  const reason = asString(input.reason);
  const ts = nowIso();
  const before = run.block?.reason;
  delete run.block;
  run.status = "active";
  run.changelog.push({
    ts,
    actor: context.conversationId,
    action: "resume",
    before: { status: "blocked", reason: before },
    after: { status: "active" },
    reason,
  });
  writeRun(context, run);
  return ok(
    `Run ${run.id} resumed (active).${reason ? `\n${reason}` : ""}\n${summary(run)}`,
  );
}
