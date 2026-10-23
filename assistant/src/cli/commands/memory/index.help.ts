/** Declarative help for the `assistant memory` command. */

import type { CliCommandHelp } from "../../lib/cli-command-help.js";

/**
 * Memory kinds accepted by the daemon's memory-item routes. Mirrored here
 * for help text only — the route validates and rejects unknown kinds.
 */
export const MEMORY_KINDS =
  "episodic, semantic, procedural, emotional, prospective, behavioral, narrative, shared";

export const memoryHelp: CliCommandHelp = {
  name: "memory",
  description:
    "Manage memory items and maintain the assistant memory subsystem",
  helpText: `
The 'nodes' subgroup provides content-based list, delete, and update over
memory graph nodes — address facts by text, not UUID (requires concept-page
memory: memory.v3.live).

The 'items' subgroup exposes full CRUD over individual memory items
(remembered facts) — list, get, create, update, delete.

The memory subsystem retrieves concept pages two ways: the v2 concept-page
activation model (prose pages with directed edges) and the v3 section-lane
model (section-grain lanes held in memory inside the assistant). Each subgroup exposes
operator-facing maintenance verbs — reindexing, backfills, validation, and evals.

Examples:
  $ assistant memory nodes stats
  $ assistant memory nodes list --search "coffee"
  $ assistant memory nodes delete "User prefers TypeScript"
  $ assistant memory nodes update "User prefers TypeScript" "User prefers TypeScript and Bun"
  $ assistant memory items list --search "coffee"
  $ assistant memory items update 9f2c4f3a-3f1a-41e4-88e7-abc123 --statement "Prefers tea"
  $ assistant memory items delete 9f2c4f3a-3f1a-41e4-88e7-abc123
  $ assistant memory validate
  $ assistant memory v3 rebuild-index
  $ assistant memory ingest --dir .mv3/staging --dry-run`,
  subcommands: [
    {
      name: "nodes",
      description:
        "Content-based list, delete, and update of memory graph nodes",
      helpText: `
Memory nodes are raw graph records (content, type, fidelity) in the memory
graph store, which every memory tier writes to. Unlike 'memory items', which
addresses nodes by UUID, these
commands address nodes by content text — matching the way an operator refers to
a remembered fact without first looking up its ID.

All subcommands require concept-page memory (memory.v3.live) and the assistant to be running.

Examples:
  $ assistant memory nodes stats
  $ assistant memory nodes list
  $ assistant memory nodes list --search "TypeScript" --limit 20
  $ assistant memory nodes delete "User prefers TypeScript"
  $ assistant memory nodes update "User prefers TypeScript" "User prefers TypeScript and Bun"`,
      subcommands: [
        {
          name: "stats",
          description: "Show a health overview of the memory graph",
          options: [
            {
              flags: "--json",
              description: "Machine-readable compact JSON output",
            },
          ],
          helpText: `
Behavior:
  Scans all active memory graph nodes in a single pass and reports:
  total count, breakdown by type and fidelity (with an ASCII bar chart),
  nodes at risk of decay (significance < 15%), average significance,
  oldest/newest node timestamps, last reinforcement, and the top 5 nodes
  by significance. Does not require the daemon to be running.

Examples:
  $ assistant memory nodes stats
  $ assistant memory nodes stats --json`,
        },
        {
          name: "list",
          description: "List active memory graph nodes",
          options: [
            {
              flags: "--search <query>",
              description: "Filter nodes whose content contains <query>",
            },
            {
              flags: "--kind <kind>",
              description:
                "Restrict to auto-seeded capability nodes: 'skill' or 'cli'",
            },
            {
              flags: "--limit <n>",
              description: "Max results (default 50, max 200)",
            },
            {
              flags: "--json",
              description: "Machine-readable compact JSON output",
            },
          ],
          helpText: `
Behavior:
  Returns active (non-deleted) memory graph nodes ordered by significance.
  With --search or --kind, all nodes are scanned so the filter is exhaustive
  regardless of graph size. With neither, the query is capped at --limit rows
  at the DB level for efficiency.

  --kind filters to the capability nodes auto-seeded from the assistant's
  own catalog — one 'skill' node per enabled/catalog skill, one 'cli' node
  per CLI command. This answers "which skills have a node in memory": each
  matching row's content names the skill and its id. Combine with --search
  to narrow to a specific capability. Filters compose (both must match).

Examples:
  $ assistant memory nodes list
  $ assistant memory nodes list --kind skill
  $ assistant memory nodes list --kind skill --search "pdf"
  $ assistant memory nodes list --search "coffee" --limit 10
  $ assistant memory nodes list --json`,
        },
        {
          name: "delete",
          args: "<content>",
          description: "Delete a memory node by content match",
          options: [
            {
              flags: "--json",
              description: "Machine-readable compact JSON output",
            },
          ],
          helpText: `
Arguments:
  <content>  The text of the memory to delete. Exact match (case-insensitive)
             takes priority; if no exact match exists, a substring match is
             tried. Fails when 0 or more than 1 nodes match — use
             'assistant memory nodes list --search <query>' to find exact text.

Behavior:
  Hard-deletes the graph node and removes it from the recall index. This
  operation is permanent; use 'assistant memory nodes update' to correct
  content instead of deleting it.

Examples:
  $ assistant memory nodes delete "User prefers TypeScript"
  $ assistant memory nodes delete "User prefers TypeScript" --json`,
        },
        {
          name: "update",
          args: "<old-content> <new-content>",
          description: "Update a memory node's content in place",
          options: [
            {
              flags: "--json",
              description: "Machine-readable compact JSON output",
            },
          ],
          helpText: `
Arguments:
  <old-content>  Text of the memory to update. Exact match (case-insensitive)
                 takes priority over substring match. Fails when 0 or more than
                 1 nodes match.
  <new-content>  Replacement text. Fails if another active node already has
                 this content (prevents duplicates).

Behavior:
  Replaces the node's content and re-embeds it so recall stays consistent.
  Use this to correct a fact rather than deleting and re-adding it — the edit
  history is preserved on the node.

Examples:
  $ assistant memory nodes update "User prefers TypeScript" "User prefers TypeScript and Bun"
  $ assistant memory nodes update "old fact" "corrected fact" --json`,
        },
      ],
    },
    {
      name: "items",
      description: "Manage individual memory items (full CRUD)",
      helpText: `
Memory items are individual remembered facts (graph nodes) with a kind
(${MEMORY_KINDS}),
a subject line, and a statement. Items are normally created by the
assistant via the remember tool; 'items create' exists for manual seeding
and repair.

Examples:
  $ assistant memory items list --search "coffee"
  $ assistant memory items update 9f2c4f3a-3f1a-41e4-88e7-abc123 --statement "Prefers tea"
  $ assistant memory items delete 9f2c4f3a-3f1a-41e4-88e7-abc123`,
      subcommands: [
        {
          name: "list",
          description:
            "List memory items with filtering, search, and pagination",
          options: [
            {
              flags: "--kind <kind>",
              description: `Filter by kind (${MEMORY_KINDS})`,
            },
            {
              flags: "--status <status>",
              description:
                "Filter by status: active (default), inactive, or all",
            },
            {
              flags: "--search <query>",
              description: "Semantic/full-text search query",
            },
            {
              flags: "--sort <field>",
              description:
                "Sort field: lastSeenAt (default), importance, kind, or firstSeenAt",
            },
            {
              flags: "--order <order>",
              description: "asc or desc (default desc)",
            },
            { flags: "--limit <n>", description: "Max results (default 100)" },
            {
              flags: "--offset <n>",
              description: "Pagination offset (default 0)",
            },
            {
              flags: "--json",
              description: "Machine-readable compact JSON output",
            },
          ],
          helpText: `
Behavior:
  Lists memory items (remembered facts) from the assistant's memory store.
  With --search, results are ranked by semantic relevance when the embedding
  backend is available, falling back to substring match otherwise. Deleted
  items are hidden unless --status inactive or --status all is passed.

Examples:
  $ assistant memory items list
  $ assistant memory items list --kind semantic --limit 20
  $ assistant memory items list --search "favorite restaurants" --json`,
        },
        {
          name: "get",
          args: "<id>",
          description: "Get a single memory item by ID",
          options: [
            {
              flags: "--json",
              description: "Machine-readable compact JSON output",
            },
          ],
          helpText: `
Arguments:
  <id>   Memory item ID (UUID) — run 'assistant memory items list' to find it.

Examples:
  $ assistant memory items get 9f2c4f3a-3f1a-41e4-88e7-abc123
  $ assistant memory items get 9f2c4f3a-3f1a-41e4-88e7-abc123 --json`,
        },
        {
          name: "create",
          description: "Create a new memory item",
          options: [
            {
              flags: "--kind <kind>",
              description: `Memory kind (${MEMORY_KINDS})`,
              required: true,
            },
            {
              flags: "--statement <text>",
              description: "Statement content of the memory",
              required: true,
            },
            {
              flags: "--subject <text>",
              description: "Subject line (defaults to the statement)",
            },
            {
              flags: "--importance <n>",
              description: "Importance score 0-1 (default 0.8)",
            },
            {
              flags: "--json",
              description: "Machine-readable compact JSON output",
            },
          ],
          helpText: `
Behavior:
  Creates a memory graph node and enqueues its embedding so it becomes
  recallable. Fails with a conflict error if an active item with identical
  content already exists. Memories are normally formed by the assistant via
  the remember tool — use this for manual seeding and repair.

Examples:
  $ assistant memory items create --kind semantic --statement "User prefers dark mode"
  $ assistant memory items create --kind procedural --subject "Deploys" \\
      --statement "Deploys go out Tuesdays after standup" --importance 0.9`,
        },
        {
          name: "update",
          args: "<id>",
          description: "Update fields on an existing memory item",
          options: [
            {
              flags: "--subject <text>",
              description: "Replace the subject line",
            },
            {
              flags: "--statement <text>",
              description: "Replace the statement content",
            },
            {
              flags: "--kind <kind>",
              description: `Change the kind (${MEMORY_KINDS})`,
            },
            {
              flags: "--status <status>",
              description:
                "Set status: active (restores a deleted item) or superseded",
            },
            {
              flags: "--importance <n>",
              description: "Set importance score 0-1",
            },
            {
              flags: "--json",
              description: "Machine-readable compact JSON output",
            },
          ],
          helpText: `
Arguments:
  <id>   Memory item ID (UUID) — run 'assistant memory items list' to find it.

Behavior:
  Partially updates the given fields; anything not passed is left unchanged.
  Content changes trigger re-embedding so recall stays consistent. Setting
  --status active restores a previously deleted item; --status superseded
  retires it (same effect as 'assistant memory items delete'). Fails with a
  conflict error when the new content duplicates another active item.

Examples:
  $ assistant memory items update 9f2c4f3a-3f1a-41e4-88e7-abc123 --statement "Prefers tea over coffee"
  $ assistant memory items update 9f2c4f3a-3f1a-41e4-88e7-abc123 --importance 0.9 --kind semantic
  $ assistant memory items update 9f2c4f3a-3f1a-41e4-88e7-abc123 --status active`,
        },
        {
          name: "delete",
          args: "<id>",
          description: "Delete a memory item",
          options: [
            { flags: "--force", description: "Skip the confirmation prompt" },
            {
              flags: "--json",
              description: "Machine-readable compact JSON output",
            },
          ],
          helpText: `
Options:
  --force  Skip the destructive y/N confirmation prompt. Required when stdin
           is not a TTY (e.g. in scripts and CI).
  --json   Output the deletion result as compact JSON.

Arguments:
  <id>   Memory item ID (UUID) — run 'assistant memory items list' to find it.

Behavior:
  Soft-deletes the memory item — it stops being recalled and its embeddings
  are removed from the index, but the underlying record is retained. A
  deleted item can be restored with
  'assistant memory items update <id> --status active'.

Examples:
  $ assistant memory items delete 9f2c4f3a-3f1a-41e4-88e7-abc123
  $ assistant memory items delete 9f2c4f3a-3f1a-41e4-88e7-abc123 --force --json`,
        },
      ],
    },
    {
      name: "v2",
      description: "Concept-page subsystem operations",
      helpText: `
The concept-page memory subsystem stores prose concept pages with directed
edges in each page's frontmatter. Pages live under
/workspace/memory/concepts/ and are active when memory.v3.live is set.

Mutating subcommands return a jobId enqueued on the memory job queue,
except reembed-skills which runs synchronously inside the assistant.
Read-only subcommands print diagnostic reports without mutating state.

The namespace keeps its historical 'v2' spelling because the IPC routes it
drives (memory/v2/*) are frozen wire surface.

Examples:
  $ assistant memory v2 reembed
  $ assistant memory v2 reembed-skills`,
      subcommands: [
        {
          name: "reembed",
          description:
            "Refresh dense + sparse vectors for every concept page in Qdrant",
          helpText: `
Fans out an embed_concept_page job per concept page slug so each page's
dense and sparse vectors get recomputed against the current embedding
backend (the direct-injected memory/*.md meta files are not embedded and are
not enqueued). Useful after upgrading
the embedding model or recovering a corrupted Qdrant collection.

The fan-out runs on the background memory worker — this command returns
once the parent job is enqueued.

Examples:
  $ assistant memory v2 reembed`,
        },
        {
          name: "reembed-skills",
          description:
            "Re-seed concept-page skill entries from the current skill catalog (synchronous)",
          helpText: `
Re-runs the skill catalog seed against the current skill set, replacing
both the in-process skill cache and the skill entries in the unified
memory_v2_concept_pages Qdrant collection (under the skills/<id> slug
prefix). Useful after editing a skill's SKILL.md, after a feature-flag flip
changes the enabled-skill set, or to recover corrupted skill embeddings.

Unlike 'reembed' (concept pages), this runs synchronously inside the
assistant — the command returns only once the seed completes. Requires
concept-page memory to be active (memory.v3.live).

Examples:
  $ assistant memory v2 reembed-skills`,
        },
        {
          name: "validate",
          description:
            "Same report as 'memory validate' (read-only concept-page check)",
          helpText: `
Identical to 'assistant memory validate'; prefer that spelling. The report
covers the concept-page store.

Examples:
  $ assistant memory validate`,
        },
      ],
    },
    {
      name: "v3",
      description: "Memory v3 live-lane maintenance (section-lane model)",
      helpText: `
The v3 memory subsystem retrieves concept pages over section-grain lanes held
in memory inside the assistant. These commands maintain that live state
safely.

Examples:
  $ assistant memory v3 rebuild-index
  $ assistant memory v3 backfill-sections
  $ assistant memory v3 reindex-projects
  $ assistant memory v3 gate-stats
  $ assistant memory v3 gate-stats --lookback-days 7 --json`,
      subcommands: [
        {
          name: "rebuild-index",
          description: "Invalidate the v3 lanes so the next turn rebuilds",
          helpText: `
Drops the assistant's in-memory v3 lanes so the section index is rebuilt
from the current on-disk state on the next turn. Useful after editing concept
pages out-of-band.

Examples:
  $ assistant memory v3 rebuild-index`,
        },
        {
          name: "backfill-sections",
          description:
            "One-time: embed every page's sections into the dense store (incl skills/CLI)",
          options: [
            {
              flags: "--json",
              description: "Emit raw JSON instead of a formatted summary",
            },
          ],
          helpText: `
Embeds EVERY concept page's sections — including synthetic skill and CLI
capability rows — into the section dense store in one pass, then advances
the maintain checkpoint so the next incremental pass only re-embeds future
edits. Use this once on an install whose section dense store is empty or
predates v3: the periodic maintenance pass only re-embeds pages edited since
its last run (and never the synthetic rows), so most of the corpus would
otherwise never be embedded.

Idempotent and safe to re-run. Runs inside the assistant so it uses the live
configuration and advances the checkpoint the assistant reads.

Examples:
  $ assistant memory v3 backfill-sections
  $ assistant memory v3 backfill-sections --json | jq '.sections'`,
        },
        {
          name: "reindex-projects",
          description:
            "One-time: rewrite the projects/exclusive payload on existing section points",
          options: [
            {
              flags: "--json",
              description: "Emit raw JSON instead of a formatted summary",
            },
          ],
          helpText: `
Rewrites the \`projects\` and \`exclusive\` payload fields of every section
point in the dense store from the page frontmatter. Needed once on a corpus
indexed before project scope existed; points indexed afterwards carry the
fields from their page automatically.

Payload only: no embeddings are recomputed and no points are deleted, so it
is idempotent and safe to re-run after a bulk frontmatter edit.

Examples:
  $ assistant memory v3 reindex-projects
  $ assistant memory v3 reindex-projects --json | jq '.points'`,
        },
        {
          name: "eval",
          description:
            "Build blinded A/B retrieval-eval packets (snapshot corpus vs staged wiki)",
          // The repeatable `--exclude-conversation <id>` option (accumulator
          // parser + array default) and the `--json` option after it live in
          // memory-v3.ts — the contract cannot express parser functions or
          // array defaults, and option order must match registration order.
          options: [
            {
              flags: "--staging <dir>",
              description:
                "Staged v3 wiki dir (relative to the workspace, or absolute)",
              required: true,
            },
            {
              flags: "--snapshot <dir>",
              description:
                "Read-only v2 snapshot dir (relative to the workspace, or absolute)",
              required: true,
            },
            {
              flags: "--out <dir>",
              description: "Output dir for packets.json + key.json",
              required: true,
            },
            {
              flags: "--turns <n>",
              description: "Number of recent turns to mine",
              defaultValue: "30",
            },
            {
              flags: "--k <n>",
              description: "Pages per memory set",
              defaultValue: "8",
            },
            {
              flags: "--seed <n>",
              description: "Blinding seed (reproducible A/B assignment)",
              defaultValue: "1",
            },
            {
              flags: "--no-dense",
              description:
                "Needle-only: skip section embedding (fast, cheaper, lower fidelity)",
            },
            {
              flags: "--turns-file <path>",
              description:
                "Pin the exact turns from a prior key.json/packets.json (reproducible re-judge); overrides --turns",
            },
          ],
          helpText: `
Mines recent user turns, retrieves the top pages from each corpus per turn, and
writes blinded A/B packets (plus a separate unblinding key) for a blind-judge
workflow. Both corpora are read in memory — nothing in the live lanes or Qdrant
is touched. With the dense lane on (default) it embeds every section of both
corpora, which can take a while on a large corpus; use --no-dense for a fast
lexical-only pass.

To iterate on the staged wiki reproducibly, mine the turns ONCE and pin them on
every re-run with --turns-file (pointing at the first run's key.json), so the
comparison stays fixed while only the staged corpus changes. Re-runs that
re-mine drift onto a different turn set and are not comparable. Likewise, do not
compare a --no-dense run against a dense one, and check eval-meta.json's
embedding identity is the same across runs.

Examples:
  $ assistant memory v3 eval --snapshot .mv3/snapshot/concepts --staging .mv3/staging --out .mv3/eval
  $ assistant memory v3 eval --snapshot .mv3/snapshot/concepts --staging .mv3/staging --out .mv3/eval --turns-file .mv3/eval/key.json
  $ assistant memory v3 eval --snapshot .mv3/snapshot/concepts --staging .mv3/staging --out .mv3/eval --exclude-conversation <migration-conv-id>`,
        },
        {
          name: "gate-stats",
          description:
            "Show injection gate pass rates bucketed by corpus size (read-only)",
          options: [
            {
              flags: "--lookback-days <n>",
              description: "Days of telemetry to aggregate (1–90, default 30)",
              defaultValue: "30",
            },
            {
              flags: "--json",
              description: "Emit raw JSON instead of a formatted table",
            },
          ],
          helpText: `
Reads the memory v3 injection gate telemetry outbox and prints pass rates
and reason distributions grouped by concept page count bucket
(0–9 / 10–49 / 50–199 / 200+). Scored runs (dense lane was available and
actually weighed scores) are reported separately from pass-open shortcuts
(dense disabled / unavailable / gate threw) so scoredPassRate reflects
only contested gate decisions — the signal relevant for threshold calibration.

Coverage is limited to runs still pending platform flush. In a healthy system
the outbox holds only the last few minutes to hours of events, so
--lookback-days is an upper bound, not a guarantee; long-window aggregation
lives on the platform side on top of flushed watchdog events.

Reads the telemetry database directly — the assistant does not need to be
running.

Intended use: verify that gate firing rates shift as expected after a
config or threshold change, and check whether the bm25-auto-calibration
flag is worth enabling for large corpora.

Examples:
  $ assistant memory v3 gate-stats
  $ assistant memory v3 gate-stats --lookback-days 7
  $ assistant memory v3 gate-stats --json | jq '.buckets[] | select(.pageCountRange == "200+")'`,
        },
        {
          name: "eval-tally",
          description:
            "Unblind + tally blind-judge verdicts against key.json with a noise-aware win/tie/loss verdict",
          options: [
            {
              flags: "--verdicts <path>",
              description:
                "JSON file: array of { turn, winner, scoreA, scoreB } (one or more per turn for a panel)",
              required: true,
            },
            {
              flags: "--key <path>",
              description:
                "key.json from `eval` — the per-turn A/B → snapshot/staging unblinding map",
              required: true,
            },
            {
              flags: "--alpha <p>",
              description:
                "Significance threshold for the sign test (the wiki only FAILS on a significant snapshot lead)",
              defaultValue: "0.05",
            },
            {
              flags: "--out <path>",
              description: "Also write the full tally JSON to this path",
            },
            {
              flags: "--json",
              description: "Emit raw JSON instead of a formatted summary",
            },
          ],
          helpText: `
Joins the blind-judge verdicts to the unblinding key (A/B is shuffled PER TURN,
so the winner must be mapped turn-by-turn — a global A-vs-B count is wrong) and
applies a two-sided sign test: the wiki only FAILS when the snapshot's win lead
is statistically significant. A within-noise difference is a tie, which passes
the win-or-tie gate. Pass a judge PANEL (multiple verdicts per turn, e.g. from
re-judging under several seeds) to control single-vote noise.

Example:
  $ assistant memory v3 eval-tally --verdicts .mv3/eval/verdicts.json --key .mv3/eval/key.json`,
        },
      ],
    },
    {
      name: "validate",
      description:
        "Check the concept-page store for dangling links, oversized pages, and parse failures (read-only)",
      helpText: `
Walks memory/concepts/ on disk and reports:
  - Page count and edge count
  - Dangling links: an edges: entry, a links: entry, or an inline
    [[wikilink]] whose target page does not exist (targets under skills/
    and cli-commands/ resolve against the registered capability catalog)
  - Oversized pages (over the configured per-page character cap)
  - Parse failures (malformed frontmatter)

Read-only. Exits non-zero if anything is reported. Works on every memory
tier, including before memory.v3.live is set, so it
doubles as the pre-flip check for a migration.

Examples:
  $ assistant memory validate`,
    },
    {
      name: "ingest",
      description:
        "Batch-ingest staged concept pages directly into memory (bypasses the consolidation buffer)",
      options: [
        {
          flags: "--dir <path>",
          description:
            "Directory of staged .md pages; slug = relative path minus .md, with forward slashes",
        },
        {
          flags: "--file <path>",
          description:
            "JSON manifest file: an array of { slug, content } objects",
        },
        {
          flags: "--dry-run",
          description: "Validate and report without writing any pages",
        },
        {
          flags: "--overwrite",
          description:
            "Rewrite pages whose slug already exists (default: skip them)",
        },
        {
          flags: "--json",
          description: "Machine-readable compact JSON summary output",
        },
      ],
      helpText: `
Input sources (pick exactly one):
  --dir   Walks the directory recursively for .md files. Each file's slug is
          its relative path minus the .md extension, with forward slashes
          (people/alice.md becomes people/alice).
  --file  Reads a JSON manifest: an array of { slug, content } objects where
          content is the full page markdown (frontmatter + body).
  stdin   With neither flag, the same JSON manifest is read from stdin when
          it is piped (not a TTY).

Behavior:
  Writes fully-formed concept pages straight into memory/concepts/, bypassing
  the consolidation buffer. Pages whose slug already exists are skipped unless
  --overwrite is passed. Every page is validated and reported individually;
  invalid pages set a non-zero exit code without blocking valid ones. Requests
  are sent in batches of 200 pages. When the consolidation lock is held the
  command fails and names the holder; retry after the current writer finishes.
  Requires concept-page memory (memory.v3.live).

Examples:
  $ assistant memory ingest --dir .mv3/staging --dry-run
  $ assistant memory ingest --dir .mv3/staging --overwrite
  $ cat pages.json | assistant memory ingest --json`,
    },
    {
      name: "retrospective",
      description: "Run and inspect memory retrospectives (direct, no IPC)",
      helpText: `
Runs memory retrospectives directly against the workspace database — the CLI
process imports the retrospective machinery and calls it in-process, so no
running daemon is required.

Examples:
  $ assistant memory retrospective run <conversationId>
  $ assistant memory retrospective list
  $ assistant memory retrospective list --limit 20 --json`,
      subcommands: [
        {
          name: "run",
          description: "Run a fork-based retrospective on a conversation",
          arguments: [
            {
              name: "<conversationId>",
              description: "Source conversation to retrospective",
            },
          ],
          options: [
            {
              flags: "--json",
              description: "Emit raw JSON instead of a formatted summary",
            },
          ],
          helpText: `
Forks the source conversation through its latest message, persists a
retrospective instruction, and wakes the fork so the agent reviews the new
messages and calls \`remember\` on anything worth saving. Runs entirely in the
CLI process — no IPC round-trip to the daemon.

Examples:
  $ assistant memory retrospective run abc123`,
        },
        {
          name: "list",
          description: "List the most-recently-run retrospective state rows",
          options: [
            {
              flags: "--limit <n>",
              description: "Max rows to return (default 10, max 200)",
            },
            {
              flags: "--json",
              description: "Machine-readable compact JSON output",
            },
          ],
          helpText: `
Reads the memory_retrospective_state table directly from the workspace SQLite
database and prints the most-recently-run state rows, newest first. No daemon
required. Each row shows the source conversation ID, when the retrospective last
ran, how many memory entries are currently retained in the dedup log (capped at
100 entries / 8 KB — older entries are dropped as new ones arrive, so RETAINED
reflects the live dedup window, not a cumulative save count), and whether any
pass has yet succeeded (status "ok") or only failed attempts exist ("pending").

Examples:
  $ assistant memory retrospective list
  $ assistant memory retrospective list --limit 20
  $ assistant memory retrospective list --json`,
        },
      ],
    },
    {
      name: "worker",
      description: "Manage the memory jobs worker process (start/stop/status)",
      helpText: `
The memory worker processes embedding, consolidation, and cleanup jobs in a
separate OS process so they do not block the assistant's main event loop. The
daemon spawns it as a child process at startup, so it shows up in
\`assistant ps\`.

\`start\` and \`stop\` manage that process on demand (respawn or SIGTERM); the
worker is spun up by default at startup.

Examples:
  $ assistant memory worker start
  $ assistant memory worker status
  $ assistant memory worker stop`,
      subcommands: [
        {
          name: "start",
          description: "Spawn the memory worker process if it is not running",
          options: [
            {
              flags: "--json",
              description: "Emit raw JSON instead of a formatted summary",
            },
          ],
        },
        {
          name: "stop",
          description: "SIGTERM the memory worker process",
          options: [
            {
              flags: "--json",
              description: "Emit raw JSON instead of a formatted summary",
            },
          ],
        },
        {
          name: "status",
          description:
            "Report the memory worker process liveness and embedding-backend status",
          options: [
            {
              flags: "--json",
              description: "Emit raw JSON instead of a formatted summary",
            },
          ],
        },
      ],
    },
  ],
};
