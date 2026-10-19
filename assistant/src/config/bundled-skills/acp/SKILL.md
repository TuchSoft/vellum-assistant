---
name: acp
description: Set up, authenticate, and run external coding agents (Kimi) via the Agent Client Protocol
compatibility: "Designed for Vellum personal assistants"
metadata:
  emoji: "🔗"
  vellum:
    display-name: "ACP"
    category: "development"
    activation-hints:
      - "User asks to use Kimi, or delegate a coding task to an ACP agent"
      - "User wants an agent to work autonomously and report back later"
      - "User mentions ACP, kimi-acp, or kimi code"
    avoid-when:
      - "The task is small enough to do inline"
---

ACP agent orchestration - spawn external coding agents (Kimi) to work on tasks via the Agent Client Protocol. Each agent runs as its own subprocess speaking ACP over stdio and streams results back into the conversation.

## Usage

Use `acp_spawn` to delegate a coding task to an external agent. The agent runs as a subprocess speaking the ACP protocol over stdio and streams results back.

The assistant's Kimi profile is configured under `acp.agents.kimi`. Pass `agent: "kimi"` explicitly on `acp_spawn`; the tool's code default is another agent id, so omitting `agent` does not select Kimi. Natural names such as "kimi code" resolve to the canonical `kimi` id unless the user's config defines an agent literally keyed by that name, which always wins.

## Choosing a model

Pass `model` only when the user names one. Model names are the agent's own vocabulary, not Assistant model ids. For Kimi that means values such as `k3`, `k3-256k`, or `kimi-for-coding`. Pass what the user said and let the agent resolve it.

The spawn result reports `requestedModel` and `effectiveModel`. Treat `effectiveModel` as authoritative for the top-level ACP session. Never infer that model from the task text or from a nested subagent. When `requestedModel` is non-null and differs from `effectiveModel`, state which model the session is actually running on and relay `modelWarning` when present.

If the agent refuses the model, or advertises no model selector, the spawn result says so: relay it in one sentence and carry on, because the session is live on the agent's own model.

A session runs on the model it started on, so a different model means a new `acp_spawn`. A standing default per agent lives in the config at `acp.agents.<id>.model`.

## First-time setup

The `kimi` profile must exist under `acp.agents.kimi` in the assistant config. The profile names the command that starts the Kimi ACP adapter, typically a wrapper around `kimi acp`. Once the profile exists, setup is just spawning:

1. Confirm the profile is available with `acp_list_agents`.
2. Call `acp_spawn` with `agent: "kimi"`. Do NOT run `vellum sleep && vellum wake`, because that kills the conversation.

## Adapter availability

When an allowlisted adapter binary is missing from PATH, the assistant installs the pinned version via a sandboxed bun global install and then runs the real installed binary. The install runs in a fresh empty temporary directory, never the task's project directory, with known secrets stripped from the installer environment and the registry pinned to the public npm registry.

The Kimi profile is configured explicitly, so it is not part of the automatic npm install allowlist. If `acp_list_agents` reports the profile or its command as unavailable, surface the install hint instead of changing `acp.agents.kimi.command`.

An adapter already on PATH is left alone, whoever installed it: automatic installation runs only when preflight found no binary at all, and only for allowlisted adapters.

## Kimi setup

The Kimi adapter is the `kimi` CLI running in ACP mode, reached through the command configured in `acp.agents.kimi`. Authentication is owned by that CLI. Sign in with the Kimi CLI on the machine that runs the adapter, or provide the credentials the profile expects.

Do NOT put API keys, OAuth tokens, or any other secret in the workspace config file. Use the credential store instead. Secrets never belong in the workspace directory.

## Critical: correct agent command

- The Kimi profile is the `acp.agents.kimi` entry. Leave its `command`, `args`, and `env` alone unless the user explicitly asks to change them.
- NEVER replace the Kimi command with a different coding-agent CLI, and do not point the `kimi` id at a Claude or Codex adapter.
- If the profile is missing, tell the user what `acp_list_agents` reports and what the profile needs. Do not invent a command.

## Updating an adapter

Adapter upgrades ship with Assistant releases for the allowlisted adapters. The configured Kimi command is part of the assistant image and its profile, so update it with the image rather than replacing the binary in place.

## When to use acp_steer vs acp_spawn

- On a running session, `acp_steer` interrupts the in-flight prompt. Use it to course-correct ("stop, do X instead"). It cancels whatever the agent is currently working on and replaces it with the new instruction. Queued follow-ups behind a running prompt are not supported; wait for the `acp_session_completed` notification instead.
- On a completed (or assistant-restarted) session, `acp_steer` transparently resumes it. The session is restored from persisted history via ACP session loading when the agent supports it, and the new instruction runs with the agent's full prior context. This is the primary way to do follow-up work on an existing session id, and it is preferable to spawning a fresh session that would lose context.
- If resume is not possible (the session was recorded before resume support and has no working directory, or the agent lacks the capability), the error explains why; fall back to `acp_spawn`.

## Discoverability

Use `acp_list_agents` to see what is set up and what is missing. It returns each available agent profile, whether the agent's binary is on PATH, and an install hint if not. This is the right tool to call when checking the Kimi profile or when the user asks "what coding agents do I have?"

## Working directory

Default to the conversation's current working directory when spawning an agent. For risky changes or parallel work where you do not want the agent touching the same checkout the user is editing, create a git worktree first via the shell tool and pass that worktree path as `cwd` to `acp_spawn`. That keeps the agent isolated from the user's in-progress work.

## Tips

- The spawned agent runs autonomously with its own tools, file editing, and terminal access.
- Results are streamed back and injected into the conversation when the agent completes.
- Use `acp_status` to inspect running and idle agents. Use `acp_steer` to attempt follow-up work on an idle session; do not replace it with a new `acp_spawn`.
- The `cwd` parameter controls where the agent works. Set it to the project root the user wants the agent to operate in.
