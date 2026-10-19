#!/usr/bin/env python3
"""
long-run watcher — tick + read-only report.

Two modes:

  python3 watch.py                 tick: evaluate open runs, probe pending
                                   external waits, wake the owner when idle,
                                   write the watcher-owned flags. This is what
                                   the Vellum script-schedule runs.

  python3 watch.py --report --json read-only: compute and print (JSON on stdout)
                                   the state of every run using the SAME
                                   helpers as the tick. Never probes, never
                                   wakes, never writes. This is the contract
                                   for external consumers (the monitor app).

Design notes:
- Pure stdlib (sqlite3, subprocess). Read-only on the assistant DB.
- A tick is stateless: it reads the current state, it does not accumulate
  timers. "Activity in the last 5 minutes" is a simple window comparison.
- Wakes use `assistant conversations wake`, which (patched, patch 15) dispatches
  in the background by default.
- State the watcher owns lives in data/long-run/watch/<id>.json; the run
  definition lives in data/long-run/runs/<id>.json and is owned by the tools.
  Disjoint writers.
- In --report mode every log line goes to stderr so stdout stays pure JSON.

Env:
  VELLUM_WORKSPACE_DIR   workspace root (default /workspace)
  LONGRUN_DRYRUN=1       (tick only) log intended wakes without sending them
"""

import datetime
import json
import os
import sqlite3
import subprocess
import sys
import time

WS = os.environ.get("VELLUM_WORKSPACE_DIR") or "/workspace"
BASE = os.path.join(WS, "data", "long-run")
RUNS = os.path.join(BASE, "runs")
WATCH = os.path.join(BASE, "watch")
DB = os.path.join(WS, "data", "db", "assistant.db")

WINDOW_MS = 5 * 60 * 1000
PROBE_TIMEOUT = 60
DRYRUN = os.environ.get("LONGRUN_DRYRUN") == "1"

TERMINAL_TODO = ("done", "skipped", "blocked")

# Log stream: stdout for the tick (captured in the schedule run record), stderr
# for --report (so stdout stays parseable JSON).
LOG_STREAM = sys.stdout

HINTS = {
    "nudge": (
        'Long-run "{label}" is open and idle: no activity for 5 minutes.\n'
        "- Establish what was in flight at your last action.\n"
        "- If a background job or subagent was running, verify it is still alive. "
        "Do NOT terminate it without a concrete reason.\n"
        "- If the last operation failed on a transient error, retry with a different approach.\n"
        "- If work completed, record it with long_run_update. If work remains, resume it.\n"
        "Do NOT mark anything done that you have not verified."
    ),
    "complete_confirm": (
        'Long-run "{label}" is fully marked complete: every todo is terminal and every DoD criterion is satisfied.\n'
        'Re-read each DoD criterion and confirm it holds - not "probably". If any doubt remains, '
        "resume the work and update the run. If it holds, close the run with long_run_end and a short summary."
    ),
    "blocked_confirm": (
        'Long-run "{label}" is marked blocked. Confirm the block before it stands:\n'
        "- Was it a transient error or an external dependency that may recover?\n"
        "- Are there workarounds, partial steps, or other work you can do now?\n"
        "- Are you genuinely missing instructions, data, or access only the user can provide?\n"
        "If you can still make progress, resume it with long_run_resume. If you are truly blocked, "
        "call long_run_block again with the precise reason and what you need; after that the supervisor stays silent."
    ),
    "watch_ready": (
        'The external wait "{label}" is satisfied: its ready_when check exits 0.\n'
        "Resume the run from where you stopped. Clear the wait with long_run_watch_clear once it is no longer needed."
    ),
    "watch_failed": (
        'The external wait "{label}" reports the process FAILED: its failed_when check exits 0.\n'
        "Do NOT assume success. Inspect what went wrong - the job errored, was blocked, or terminated - "
        "then decide: retry with a different approach, block the run, or close it. Clear the wait with long_run_watch_clear once handled."
    ),
    "watch_both": (
        'The external wait "{label}" reports BOTH conditions satisfied in the same poll: its ready_when AND '
        "failed_when checks both exit 0.\n"
        "The state is ambiguous - do NOT assume success. Inspect the process directly, then decide how to proceed. "
        "Clear the wait with long_run_watch_clear once handled."
    ),
    "watch_timeout": (
        'External wait "{label}" timed out: neither condition became true within the declared window.\n'
        "Do NOT assume success. Verify what happened - the job may have failed, stalled, or never started - "
        "then resume and update the run."
    ),
}


def _trunc(value, limit=140):
    text = "" if value is None else str(value)
    return text if len(text) <= limit else text[: limit - 1] + "\u2026"


def state_block(run):
    """Compact, agent-authored summary of the run, appended to every wake hint.

    The content is the assistant's own run data (trusted); it is what re-anchors
    the agent on its objectives and progress at the moment of the wake.
    """
    todos = run.get("todos", []) or []
    dod = run.get("dod", []) or []
    term = sum(1 for t in todos if t.get("status") in TERMINAL_TODO)
    ok = sum(1 for d in dod if d.get("satisfied"))
    lines = [
        'Run "%s" (%s) | status %s | todos %d/%d terminal | DoD %d/%d satisfied'
        % (run.get("label"), run.get("id"), run.get("status"), term, len(todos), ok, len(dod))
    ]
    if todos:
        lines.append("todos:")
        for t in todos:
            note = " - " + _trunc(t.get("note"), 120) if t.get("note") else ""
            lines.append("  %s [%s] %s%s" % (t.get("id"), t.get("status"), _trunc(t.get("text")), note))
    if dod:
        lines.append("DoD:")
        for d in dod:
            mark = "x" if d.get("satisfied") else " "
            lines.append("  %s [%s] %s" % (d.get("id"), mark, _trunc(d.get("text"))))
    return "\n".join(lines)


def build_hint(kind, run):
    head = HINTS[kind].format(label=run.get("label", run.get("id")))
    tail = (
        "\n\nCurrent run state:\n"
        + state_block(run)
        + "\n\nUpdate the run with long_run_update (ops[] + reason). Close it with "
        "long_run_end when every todo is terminal and every DoD is satisfied."
    )
    return head + tail


def log(*args):
    print("[long-run]", *args, file=LOG_STREAM, flush=True)


def now_ms():
    return int(time.time() * 1000)


def now_iso():
    return datetime.datetime.now(datetime.timezone.utc).isoformat()


def load_json(path):
    try:
        with open(path) as fh:
            return json.load(fh)
    except Exception:
        return None


def save_json(path, obj):
    try:
        tmp = path + ".tmp"
        with open(tmp, "w") as fh:
            json.dump(obj, fh, indent=2)
        os.replace(tmp, path)
    except Exception as exc:  # noqa: BLE001 - the watcher must never crash a tick
        log("cannot write watch state:", exc)


def parse_iso_ms(value):
    if not value:
        return None
    try:
        return datetime.datetime.fromisoformat(
            value.replace("Z", "+00:00")
        ).timestamp() * 1000
    except Exception:
        return None


def connect():
    if not os.path.exists(DB):
        log("db not found:", DB)
        return None
    try:
        return sqlite3.connect(f"file:{DB}?mode=ro", uri=True, timeout=5)
    except Exception as exc:  # noqa: BLE001
        log("db open failed:", exc)
        return None


def tree_ids(cur, owner):
    """owner + all descendant conversations (native forks + subagent children)."""
    try:
        cur.execute(
            """
            WITH RECURSIVE tree(id) AS (
              SELECT ?
              UNION
              SELECT c.id FROM conversations c JOIN tree t
                ON COALESCE(c.fork_parent_conversation_id, c.parent_conversation_id) = t.id
              UNION
              SELECT s.conversation_id FROM subagents s JOIN tree t
                ON s.parent_conversation_id = t.id
            )
            SELECT DISTINCT id FROM tree
            """,
            (owner,),
        )
        ids = [row[0] for row in cur.fetchall() if row[0]]
        return ids or [owner]
    except Exception as exc:  # noqa: BLE001 - degrade to the owner only
        log("tree query failed:", exc)
        return [owner]


def placeholders(ids):
    return ",".join("?" * len(ids))


def active_work(cur, ids):
    """Return a label for the kind of work still in flight, or None."""
    ph = placeholders(ids)
    try:
        cur.execute(
            f"SELECT COUNT(*) FROM conversations WHERE id IN ({ph}) "
            "AND processing_started_at IS NOT NULL",
            ids,
        )
        if cur.fetchone()[0] > 0:
            return "turn"
    except Exception as exc:  # noqa: BLE001
        log("activity query failed:", exc)
    try:
        cur.execute(
            f"SELECT COUNT(*) FROM subagents WHERE parent_conversation_id IN ({ph}) "
            "AND status IN ('pending','running')",
            ids,
        )
        if cur.fetchone()[0] > 0:
            return "subagent"
    except Exception:
        pass
    for table in ("task_runs", "workflow_runs", "cron_runs"):
        try:
            cur.execute(
                f"SELECT COUNT(*) FROM {table} WHERE conversation_id IN ({ph}) "
                "AND status = 'running'",
                ids,
            )
            if cur.fetchone()[0] > 0:
                return table
        except Exception:
            continue
    return None


def last_activity_ms(cur, ids):
    ph = placeholders(ids)
    best = 0
    for table in ("messages", "tool_invocations"):
        try:
            cur.execute(
                f"SELECT MAX(created_at) FROM {table} WHERE conversation_id IN ({ph})",
                ids,
            )
            value = cur.fetchone()[0]
            if value and value > best:
                best = value
        except Exception:
            continue
    return best


def all_todos_terminal(run):
    todos = run.get("todos", [])
    return bool(todos) and all(t.get("status") in TERMINAL_TODO for t in todos)


def all_dod_ok(run):
    dod = run.get("dod", [])
    return bool(dod) and all(d.get("satisfied") for d in dod)


def wake(owner, hint, kind, label):
    if DRYRUN:
        log(f"DRYRUN would wake {owner} [{kind}] label={label!r}")
        return True
    try:
        proc = subprocess.run(
            [
                "assistant",
                "conversations",
                "wake",
                owner,
                "--hint",
                hint,
                "--source",
                "long-run",
                "--json",
            ],
            capture_output=True,
            text=True,
            timeout=45,
        )
    except Exception as exc:  # noqa: BLE001
        log("wake failed to run:", exc)
        return False
    out = (proc.stdout or "").strip()
    if proc.returncode != 0:
        log("wake rc", proc.returncode, out, (proc.stderr or "").strip())
        return False
    try:
        parsed = json.loads(out) if out else {}
    except Exception:
        parsed = {}
    log("wake", kind, owner, parsed)
    return bool(parsed.get("ok", True))


def run_check(via, command):
    """Run one idempotent check command. Returns (fired: bool, detail: str).

    The check is true (fired) when the command exits 0; any other exit, a
    missing command, or a probe error is simply "not fired yet".
    """
    if not command:
        return False, "no command"
    try:
        if via == "container":
            proc = subprocess.run(
                command, shell=True, capture_output=True, text=True,
                timeout=PROBE_TIMEOUT,
            )
        elif via == "host":
            proc = subprocess.run(
                ["assistant", "host-exec", "-t", str(PROBE_TIMEOUT), "--", command],
                capture_output=True, text=True, timeout=PROBE_TIMEOUT + 20,
            )
        elif via.startswith("ssh:"):
            host = via[4:]
            proc = subprocess.run(
                ["ssh", "-o", "BatchMode=yes", "-o", "ConnectTimeout=10", host, command],
                capture_output=True, text=True, timeout=PROBE_TIMEOUT + 20,
            )
        else:
            return False, f"unknown via {via}"
    except Exception as exc:  # noqa: BLE001 - probe failure is just "not fired"
        return False, f"probe error: {exc}"
    return proc.returncode == 0, f"exit {proc.returncode}"


def decide(run):
    if all_todos_terminal(run) and all_dod_ok(run):
        return "complete_confirm"
    if run.get("status") == "blocked":
        return "blocked_confirm"
    return "nudge"


def evaluate_watches(run, owner, flag, wpath, now):
    """
    Tick only. Evaluate the run's pending watches. Sends at most one wake per
    watch that fires/times out, records it in `watches_fired`, and returns
    (pending: int, fired_this_tick: bool).
    """
    watches = run.get("watches", []) or []
    fired = flag.get("watches_fired", {}) or {}
    if not isinstance(fired, dict):
        fired = {}
    # Prune fired entries whose watch no longer exists.
    valid_ids = {w.get("id") for w in watches}
    fired = {k: v for k, v in fired.items() if k in valid_ids}
    flag["watches_fired"] = fired

    if not watches:
        return 0, False

    fired_this_tick = False
    for w in watches:
        wid = w.get("id")
        if wid in fired:
            continue
        label = w.get("label", wid)
        via = w.get("via", "container")
        ready, ready_detail = run_check(via, w.get("ready_when"))
        failed = False
        failed_detail = "none"
        if w.get("failed_when"):
            failed, failed_detail = run_check(via, w.get("failed_when"))
        log("watch", wid, "ready:", ready_detail, "failed:", failed_detail)
        if ready and failed:
            # Both conditions true in the same poll: ambiguous, tell the agent
            # neutrally instead of guessing success or failure.
            if wake(owner, build_hint("watch_both", run), "watch_both", label):
                fired[wid] = {"at": now_iso(), "kind": "both"}
                fired_this_tick = True
            continue
        if failed:
            if wake(owner, build_hint("watch_failed", run), "watch_failed", label):
                fired[wid] = {"at": now_iso(), "kind": "failed"}
                fired_this_tick = True
            continue
        if ready:
            if wake(owner, build_hint("watch_ready", run), "watch_ready", label):
                fired[wid] = {"at": now_iso(), "kind": "ready"}
                fired_this_tick = True
            continue
        tout = parse_iso_ms(w.get("timeout_at"))
        if tout and now > tout:
            if wake(owner, build_hint("watch_timeout", run), "watch_timeout", label):
                fired[wid] = {"at": now_iso(), "kind": "timeout"}
                fired_this_tick = True

    flag["watches_fired"] = fired
    save_json(wpath, flag)
    pending = sum(1 for w in watches if w.get("id") not in fired)
    return pending, fired_this_tick


# ─── Tick ────────────────────────────────────────────────────────────────────


def tick():
    if not os.path.isdir(RUNS):
        log("no runs dir:", RUNS)
        return
    os.makedirs(WATCH, exist_ok=True)
    conn = connect()
    cur = conn.cursor() if conn else None
    now = now_ms()

    for name in sorted(os.listdir(RUNS)):
        if not name.endswith(".json"):
            continue
        rid = name[:-5]
        run = load_json(os.path.join(RUNS, name))
        if not run or run.get("status") == "done":
            continue
        owner = run.get("owner_conversation_id")
        if not owner:
            continue

        wpath = os.path.join(WATCH, rid + ".json")
        flag = load_json(wpath) or {}

        until = parse_iso_ms(run.get("postpone_until"))
        if until and until > now:
            continue

        # A blocked run is a hard stop: one confirmation wake, then silence.
        # Its watches are inert (never probed) until it is resumed.
        if run.get("status") == "blocked":
            if not flag.get("blocked_confirm_sent"):
                label = run.get("label", rid)
                if wake(owner, build_hint("blocked_confirm", run), "blocked_confirm", label):
                    flag["blocked_confirm_sent"] = True
                    flag["last_wake_at"] = now_iso()
                    flag["last_wake_kind"] = "blocked_confirm"
                    save_json(wpath, flag)
            continue

        if flag.get("blocked_confirm_sent"):
            flag["blocked_confirm_sent"] = False
            save_json(wpath, flag)

        # External waits: while one is pending (or one just fired) the run is
        # "waiting" and the normal nudge is suppressed.
        pending, fired_this_tick = evaluate_watches(run, owner, flag, wpath, now)
        if fired_this_tick or pending > 0:
            log(rid, "waiting on external watch", f"pending={pending}")
            continue

        ids = tree_ids(cur, owner) if cur else [owner]
        busy = active_work(cur, ids) if cur else None
        if busy:
            log(rid, "working:", busy)
            continue

        act = last_activity_ms(cur, ids) if cur else 0
        if act and (now - act) < WINDOW_MS:
            log(rid, "recent activity")
            continue

        kind = decide(run)
        if kind == "blocked_confirm" and flag.get("blocked_confirm_sent"):
            continue

        label = run.get("label", rid)
        if wake(owner, build_hint(kind, run), kind, label):
            flag["last_wake_at"] = now_iso()
            flag["last_wake_kind"] = kind
            if kind == "blocked_confirm":
                flag["blocked_confirm_sent"] = True
            save_json(wpath, flag)

    if conn:
        conn.close()


# ─── Report (read-only) ──────────────────────────────────────────────────────


def build_report_entry(cur, run, flags, now):
    owner = run.get("owner_conversation_id")
    ids = tree_ids(cur, owner) if (cur and owner) else ([owner] if owner else [])

    busy = active_work(cur, ids) if (cur and ids) else None
    act = last_activity_ms(cur, ids) if (cur and ids) else 0
    recent = bool(act and (now - act) < WINDOW_MS)

    title = None
    if cur and owner:
        try:
            cur.execute("SELECT title FROM conversations WHERE id = ?", (owner,))
            row = cur.fetchone()
            title = row[0] if row else None
        except Exception:
            title = None

    subs = {
        "count": 0,
        "pending": 0,
        "running": 0,
        "completed": 0,
        "interrupted": 0,
        "aborted": 0,
        "failed": 0,
        "other": 0,
        "tokens_in": 0,
        "tokens_out": 0,
    }
    if cur and ids:
        try:
            ph = placeholders(ids)
            cur.execute(
                f"SELECT status, COUNT(*), COALESCE(SUM(input_tokens),0), "
                f"COALESCE(SUM(output_tokens),0) FROM subagents "
                f"WHERE parent_conversation_id IN ({ph}) GROUP BY status",
                ids,
            )
            for status, cnt, tin, tout in cur.fetchall():
                subs["count"] += cnt
                subs["tokens_in"] += tin or 0
                subs["tokens_out"] += tout or 0
                key = status if status in subs else "other"
                subs[key] += cnt
        except Exception as exc:  # noqa: BLE001
            log("subagents query failed:", exc)

    fired = flags.get("watches_fired", {}) or {}
    if not isinstance(fired, dict):
        fired = {}
    watches = []
    for w in run.get("watches", []) or []:
        wid = w.get("id")
        watches.append(
            {
                "id": wid,
                "label": w.get("label"),
                "via": w.get("via"),
                "ready_when": w.get("ready_when"),
                "failed_when": w.get("failed_when"),
                "timeout_at": w.get("timeout_at"),
                "created_at": w.get("created_at"),
                "pending": wid not in fired,
                "fired": fired.get(wid),
            }
        )
    pending = sum(1 for w in watches if w["pending"])

    until = parse_iso_ms(run.get("postpone_until"))
    postponed = bool(until and until > now)
    complete = all_todos_terminal(run) and all_dod_ok(run)
    status = run.get("status")

    # A blocked run wins over everything: its watches are inert until resumed,
    # so "waiting" must not shadow "blocked" (mirrors the tick).
    if status == "done":
        verdict = "done"
    elif status == "blocked":
        verdict = "blocked"
    elif pending > 0:
        verdict = "waiting"
    elif busy:
        verdict = "busy"
    elif recent:
        verdict = "active"
    elif complete:
        verdict = "complete"
    else:
        verdict = "idle"

    would_wake = None
    if status == "blocked":
        if not postponed and not flags.get("blocked_confirm_sent"):
            would_wake = "blocked_confirm"
    elif status != "done" and not postponed and pending == 0 and not busy and not recent:
        if complete:
            would_wake = "complete_confirm"
        else:
            would_wake = "nudge"

    computed = {
        "verdict": verdict,
        "work_in_flight": busy,
        "last_activity_min_ago": (round((now - act) / 60000, 1) if act else None),
        "recent_activity": recent,
        "postponed": postponed,
        "tree_size": len(ids) if ids else 0,
        "owner_title": title,
        "subagents": subs,
        "watches": watches,
        "would_wake": would_wake,
    }
    return {"run": run, "watch_flags": flags, "computed": computed}


def report():
    payload = {
        "generated_at": now_iso(),
        "workspace": WS,
        "db_ok": False,
        "runs": [],
    }
    conn = connect()
    cur = conn.cursor() if conn else None
    payload["db_ok"] = bool(conn)
    now = now_ms()
    if os.path.isdir(RUNS):
        for name in sorted(os.listdir(RUNS)):
            if not name.endswith(".json"):
                continue
            run = load_json(os.path.join(RUNS, name))
            if not run:
                continue
            rid = name[:-5]
            flags = load_json(os.path.join(WATCH, rid + ".json")) or {}
            payload["runs"].append(build_report_entry(cur, run, flags, now))
    if conn:
        conn.close()
    sys.stdout.write(json.dumps(payload, indent=2) + "\n")


if __name__ == "__main__":
    if "--report" in sys.argv[1:]:
        LOG_STREAM = sys.stderr
        try:
            report()
        except Exception as exc:  # noqa: BLE001 - still emit valid JSON
            sys.stdout.write(
                json.dumps(
                    {
                        "generated_at": now_iso(),
                        "workspace": WS,
                        "db_ok": False,
                        "runs": [],
                        "error": str(exc),
                    },
                    indent=2,
                )
                + "\n"
            )
    else:
        try:
            tick()
        except Exception as exc:  # noqa: BLE001 - a failed tick must not look like a crash
            log("tick failed:", exc)
