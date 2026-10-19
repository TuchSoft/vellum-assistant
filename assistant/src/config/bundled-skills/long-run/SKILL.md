---
name: long-run
description: >-
  Orchestrate long-horizon autonomous runs (hours to days, many steps, background
  jobs and subagents) so they never stall silently. Declare the run with its tasks
  and definition-of-done, keep it updated as you go, and an external supervisor
  wakes this conversation whenever it goes idle before the run is closed. Use this
  at the start of any task you intend to run autonomously for a long time.
metadata:
  emoji: "\U0001F9ED"
  vellum:
    display-name: "Long Run"
    category: "system"
    activation-hints:
      - "task that will take a long time or run in the background"
      - "work autonomously on this until it is done"
      - "multi-step job with subagents or long-running work"
      - "resume or continue a long-running task"
    avoid-when:
      - "quick one-shot task that finishes in this turn"
      - "the user just wants a normal answer, not an autonomous run"
---

Run long-horizon work to completion without getting stuck.

## When to Use

USE THIS SKILL WHEN:
- The task will span many steps, hours, or days.
- You will run work in the background, spawn subagents, or wait on long jobs.
- The user asks you to work autonomously until something is done.

Do NOT use it for a quick task you finish in this turn - that is just a normal reply.

## Run discipline

You are the orchestrator of this run. Your job is to coordinate work; others - subagents - execute it.

Core principle: your context is precious. Delegate everything to specialized subagents. Exercise critical judgment regarding their work - your reasoning capabilities are superior. If a subagent's claim seems suspicious, cross-verify it with another subagent, or perform a minimal, highly targeted check yourself. Always read the provided specifications. Avoid producing work yourself, and only if it is targeted (e.g. a trivial fix to unblock a pipeline); otherwise delegate it. Planning and messaging with other agents are your tasks - do not delegate them.

Examples:
- A subagent states that something does not exist → verify it yourself.
- A subagent reports unexpected behavior after an edit → verify the claim with a fresh subagent.
- A subagent reports a problem → verify it with a critic.
- A subagent reports something too big to be true → verify it with another, fresh critic.

The workflow.

Turn 1 - understanding and planning:
1. Pre-flight: if there is uncommitted or unsaved state relevant to the run, ask the user before proceeding (IF APPLICABLE).
2. Discovery: use a subagent to explore scope, sources and areas if context is missing.
3. Planning: identify the logical work groups and the delegation sequence - these become the run's todos.
4. Halt: ask any clarifying question you need before committing to the plan. If you have none, record the plan with `long_run_plan` and begin.

Turn 2+ - execution and review (non-interactive): do not return to the user until the work is done, unless you are blocked by a critical issue. For each work group:
1. Assign the subagent its role.
2. Delegate with clear, specific instructions - always include the mandatory coordinator snippet (below).
3. Review with a critic subagent.
4. Iterate or persist: if it passes review, persist the milestone (IF APPLICABLE, below); if it fails, reuse or spawn a subagent to fix it.

Subagent session management (your judgment): reuse a live subagent with `subagent_message` to retain its context, or spawn a new one with `subagent_spawn` when its context is polluted. Watch for these risks:
- Context budget: keep it low; past a point, subagents lose focus or overflow.
- Step budget: a subagent should not run more than ~100 steps in one go; if it heads past that, split the work into smaller blocks and re-run.
- Hallucinations: long runs degrade and increase errors.
- Task bias: a subagent anchors to its initial task or mistake.
- Suitability: make sure the subagent's role actually fits the next phase of work.

Persistence: persist each milestone IF APPLICABLE - for example commit it when the work is in a version-controlled repository. If no such step applies, skip it.

Completion: all milestones recorded, all reviews passed, and tests written and passing (IF APPLICABLE, and if the project has tests). Then close the run with `long_run_end` and a final summary.

Golden rules.

You MUST:
- Include this exact snippet in every subagent prompt:
  > You are running as a subagent, report to your coordinator. Don't spawn any subagent yourself. If you don't have enough info to work (missing file, wrong credential, etc.) or the instructions are not clear, report immediately.
- Persist after each milestone (IF APPLICABLE).
- Own the quality of the outcome: correctness, coverage, documentation alignment, and fit with existing patterns and the agreed specification.
- Split a subagent's work into smaller incremental milestones.

You MUST NOT:
- Execute directly: never explore large sources or implement the work yourself - delegate it.
- Run 2+ subagents in parallel on the same area; parallelize only across isolated areas.
- Accept an unreviewed result.
- Hand out a task too big for one subagent.

Escalation: when you hit a blocking issue that needs the user, or a step that is irreversible or outward-facing, or you finish - that is a critical event. For this run it means `long_run_block` (blocked, the supervisor amplifies it) or `long_run_end` (finished). Do not poll the user; the supervisor wakes you.

## The loop

1. Call `long_run_plan` with a short `label`, the ordered `todos`, and the `dod` (definition-of-done criteria). The todos are your milestones; the DoD is what must hold for the run to be complete.
2. Work as the orchestrator above. As things change, call `long_run_update` to mark todos, satisfy DoD, or add/edit/remove items (always with a `reason`).
3. When you launch something external that you will have to poll, declare it with `long_run_watch` (below) instead of leaving the run idle.
4. When everything is done, call `long_run_end`. If you are truly stuck and need the user, call `long_run_block`.

A supervisor checks this conversation every 5 minutes. While the run is open, if this conversation goes idle (no turn running, no subagent/background job in flight, no pending watch, and no activity for 5 minutes) it wakes you with a reminder. The loop does not end until you close the run explicitly.

## Waiting on external things

If you start something that returns immediately (often with a job id) and whose outcome you can only learn by polling - a remote job, a file another system will produce - do NOT let the run sit idle waiting for the 5-minute nudge. Declare a watch:

```
long_run_watch(
  run_id, label,
  ready_when      = "<idempotent check: exits 0 when the wait is over>",
  failed_when     = "<idempotent check: exits 0 when the process failed early>",  # optional
  via             = "container" | "host" | "ssh:<hostname>",
  timeout_minutes = <n>
)
```

Each field is a plain shell check, never a regex: the wait is over (or the process failed) when the command exits 0; any other exit is ignored and the wait continues. Checks must be idempotent and side-effect-free - they are run repeatedly. A watch ends in exactly one of these ways:
- `ready_when` exits 0 → success wake.
- `failed_when` exits 0 → failure wake.
- both exit 0 in the same poll → neutral wake reporting the ambiguity (no guessing).
- `timeout_minutes` elapses → neutral wake.

While a watch is pending the supervisor stops nudging; it sends one wake as above (never more). Clear it with `long_run_watch_clear` once you have resumed.

Use this ONLY for things Vellum cannot track. A command you launch through a Vellum background command does not need a watch - Vellum already wakes you when it exits. `long_run_postpone` is the blind fallback; prefer a watch whenever the thing is observable.

## Supervisor report

```
python3 "{baseDir}/watch.py" --report --json
```

prints the current verdict for every run (read-only, JSON on stdout): the same checks the supervisor runs at each tick. Any external consumer (for example a monitor app) should call this instead of re-implementing the logic. It never probes, wakes or writes.

## Definition of done

The run counts as complete only when every todo is terminal (`done`, `skipped`, or `blocked`) and every DoD criterion is satisfied. Do not mark something done that you have not verified.

## Blocking and resuming

`long_run_block` stops the run: the supervisor sends one confirmation, then stays silent. While a run is blocked its mutating tools (`long_run_update`, `long_run_watch`, `long_run_watch_clear`, `long_run_note`, `long_run_postpone`) are refused - you MUST get it out of the blocked state first.

- If the user unblocks you, call `long_run_resume` to return the run to active, then continue.
- If the run cannot be finished, close it with `long_run_end` (add `force` if the DoD cannot be met).

## Handling a wake

A wake arrives as an instruction in this conversation. When you get one:
- Look at the run with `long_run_read` to see the real state.
- If a background job or subagent was in flight, check it is still running - do not kill it without a concrete reason.
- If you stalled on a transient error, retry with a slightly different approach.
- If you finished something, record it with `long_run_update`; if work remains, resume it.
- Never declare done what you have not verified.

Five kinds of wake exist: a nudge (idle, run still open), a completion confirm (all todos + DoD satisfied - verify once more then `long_run_end`), a block confirm (you reported blocked - if you really cannot proceed, confirm and the supervisor falls silent; if you can move, resume), and a watch wake (the external wait you declared is satisfied, has failed, is ambiguous, or timed out).

## Tools

- `long_run_plan` - open a run: `label`, `todos[]`, `dod[]`.
- `long_run_read` - snapshot of a run (with `run_id`) or of the runs you own (without).
- `long_run_list` - all runs, including ones whose owner may be gone (so you can claim one).
- `long_run_update` - operate on todos/DoD; pass `ops[]` and a `reason`.
- `long_run_note` - record a finding without changing the structure.
- `long_run_watch` - declare an external wait (ready check + optional fail check + timeout).
- `long_run_watch_clear` - cancel a wait you no longer need.
- `long_run_postpone` - blind: push the next wake out by up to 30 minutes (rare).
- `long_run_claim` - take control of a run owned by another conversation (records the handoff).
- `long_run_resume` - clear a block and return the run to active (the only exit from `blocked`).
- `long_run_block` - declare the run blocked on the user; the supervisor sends one confirm and then stays silent.
- `long_run_end` - close the run as done (requires all todos terminal and all DoD satisfied, unless `force`).

## SKILL COMPLETE WHEN

- The run was opened with `long_run_plan`.
- Every todo is terminal and every DoD is satisfied.
- Any external waits were cleared, and `long_run_end` was called.
