# Memory Plugin — Agent Instructions

Rules for code under `assistant/src/plugins/defaults/memory/` (`MEM/` below).
For the user-facing architecture narrative — what each tier does and how the
write and read paths fit together — read `assistant/docs/architecture/memory.md`
first. This file is the layering contract: where code goes, which names can
never be renamed, and how to retire a tier.

## Tier movement is one-way

**v1 and v2 are legacy. Assistants move v1 → v2 → v3 and never back.** There is
no supported path from v3 to an earlier tier, so "what happens when an assistant
returns to v1 (or v2)" is not a scenario this code serves.

That rules out a whole class of plausible-sounding work: reconciling state that
a lower tier would need, keeping a lower tier's derived data warm while a higher
tier is live, or postponing a lower tier's jobs so they survive a downgrade.
Review feedback will periodically ask for exactly that — the reasoning looks
sound in isolation, because the state genuinely is missing. Decline it and point
here. The correct fix for a lower tier's stale derived data is to delete the
lower tier (see the runbooks below), not to maintain it.

Two consequences worth stating plainly:

- The return-to-v1 path has been **removed**, not merely left vestigial: the
  `v1_entry_reconcile_done` checkpoint, its re-arm in `jobs-worker.ts`, the boot
  claim in `startup.ts`, and `reconcileCapabilityEmbeddings` in
  `graph/capability-seed.ts` are all gone. Do not reintroduce them. (A stale
  `v1_entry_reconcile_done` row may still sit in `memory_checkpoints` on an
  upgraded install; nothing reads it, so it is inert and needs no migration.)
- Gaps that only manifest after a downgrade are **not bugs**. Record them here
  if they are non-obvious; do not build machinery to close them.

## Directory / tier map

The plugin is layered into **tier directories** plus a **spine** that composes
them. Everything not listed as a tier directory is spine.

| Directory         | What lives there                                                                                                                                                                                                                                                                                                                                                                                                                  | Gate predicate            |
| ----------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------- |
| `substrate/`      | The shared concept-page substrate: `page-store`, `page-index`, `edge-index`, `qdrant`, `sim`, `sparse-bm25`, `spread`, `skill-store`, `cli-command-store`, `skill-content`, `cli-command-content`, `injected-block-slugs`, `static-context`, `boot-maintenance`, `frontmatter-sweep`, `consolidation-lock`, `consolidation-job`, `ingest`, `sweep-job`, `reembed-job`, `tuning`, `types`, `page-links`, `prompts/`.               | `usesConceptPageMemory()` |
| `v1/`             | The legacy PKB/graph engine: `pkb/`, `graph/` (retriever, triggers, scoring, serendipity, extraction, extraction-job, decay, consolidation, pattern-scan, narrative, bootstrap, injection, and the hybrid node-search half of `graph-search`), `jobs/embed-pkb-file.ts`, `job-handlers/{backfill,embedding,index-maintenance}.ts`, `pkb-schedule.ts`, `filing-jobs.ts`, `semantic-search.ts`, `identity-context.ts`, `README.md`. | `isMemoryV1Active()`      |
| `v3/`, `v3-eval/` | The v3 lanes, orchestrator, injectors, maintain job, and the eval siblings.                                                                                                                                                                                                                                                                                                                                                       | `isMemoryV3Live()`        |

`substrate/page-links` is the one owner of `links:`-entry and `[[wikilink]]`
parsing; every reader in any tier imports it (the same single-matcher rule
`buffer-format` follows for buffer entries, below). Do not add a second
wikilink matcher or `links:` splitter anywhere.

Everything else under the plugin root is **spine**:

- `graph/` — the **all-tier** legacy-graph store plus the tier dispatcher:
  `conversation-graph-memory.ts` (the v1 dispatch spine; also owns compaction
  eviction of v3 `everInjected` state and the injected-block strip identity), `store.ts`, `tool-handlers.ts`,
  `tools.ts`, `capability-seed.ts`, `in-context-tracker.ts`, `graph-search.ts`
  (node/trigger **embedding** plumbing — the v1 search half lives in
  `v1/graph/graph-search.ts`), `graph-memory-state-store.ts`, `types.ts`,
  `image-ref-utils.ts`. Despite the `memory_graph_*` naming, this directory is
  not v1: capability seeding writes graph nodes on every tier.
- `graph-topology/` — the backend-agnostic memory-graph view served to the web
  Memory tab (`build-memory-graph.ts`, `pending-buffer.ts`).
- Shared infra at the root: `logging`, `paths`, `embeddings`, `anisotropy`,
  `frontmatter`, `validation`, `llm-helpers`, `config`, `memory-db`,
  `host-utils`, `path-containment`, `prompt-override`, `memory-marker`,
  `buffer-format` (the sole owner of the `memory/buffer.md` entry format:
  the writer plus the one matcher every reader uses. It lives at the root
  precisely so `substrate/`, `graph/`, and `graph-topology/` can all reach it
  without a tier importing spine. Do not add a second matcher anywhere),
  `buffer-file` (the two writers of `memory/buffer.md`: the append every
  `remember()`-shaped path uses and the consume the consolidation job runs
  after a pass. Do not write the buffer from anywhere else, and never
  rewrite it from a read that is not inside `consumeBufferEntries`'s
  synchronous critical section), `memory-run-evidence` (readers of what a
  background memory run durably produced from its persisted messages; every
  job that gates a state transition on a verified write uses them),
  `segmenter`, `message-media`, `worker`, `worker-control`,
  `memory-recall-log-store`, `activation-session-store` (the onboarding
  activation rail — **not** a memory tier despite the name),
  `tail-reinjection-strip`, `task-memory-cleanup`, `conversation-memory-purge`,
  `conversation-memory-orphan-sweep`, `fork-conversation-memory`,
  `find-most-recent-retrospective-for`.
- The `memory-retrospective-*` family — tier-agnostic, gated on
  `memory.enabled` alone. The exceptions are
  `memory-retrospective-skill-card.ts` and `skill-update-receipt-job.ts` (one
  pending job collects a burst of background skill rewrites and announces it
  once it settles), whose upstream producers only fire when
  `isV3TierActive()` holds (memory on and v3 live).
- The rest of the spine: `startup.ts`, `jobs-worker.ts`, `job-handlers.ts`,
  `job-handler-registration.ts`, `indexer.ts`, `injectors.ts`, `tools.ts`,
  `hooks/`, `src/` (HTTP routes), `context-search/`.

### The layering rule

**Tier directories never import each other.** The only sanctioned edge is
`substrate/` upward: `v3/`/`v3-eval/` may import `substrate/`, and
`substrate/` imports no tier. `v1/` imports no tier at all.

**Multi-tier composition happens only at the spine.** A spine file that imports
from two or more tier directories is a composition point and must be on the
frozen `SPINE_ALLOWLIST`, which today is exactly:

```
graph-topology/build-memory-graph.ts
graph/conversation-graph-memory.ts
injectors.ts
job-handlers.ts
jobs-worker.ts
startup.ts
```

The list is frozen: new multi-tier composition belongs in one of these files,
and shrinking the list is how the deletion runbooks below retire an engine.
Inside them the tier arms carry `// V1 — delete with v1` / `// SUBSTRATE`
banners, so `grep -rn 'delete with v1' src/plugins/defaults/memory/` finds
every v1 arm.
Two conventions keep that grep honest, and both are load-bearing:

- **The banner phrase is exact.** `startup.ts` labels its sections
  `// ---- <tier> ... ----` rather than `// V1 …`, so its v1 labels spell out
  `— delete with v1` too (`// ---- v1 (legacy engine) — delete with v1 ----`);
  otherwise its three v1 blocks would be invisible to the grep.
- **Dispatch call sites are banner-marked, not just function bodies.** A v1
  helper is typically an `else` arm calling a banner-marked function
  (`jobs-worker.ts`'s `enqueueV1MaintenanceJobs`, `indexer.ts`'s
  `enqueueV1IndexTriggers`). Deleting only the marked bodies leaves the calls
  dangling, so the call sites carry their own banner.

`indexer.ts`, `injectors.ts`, and `context-search/sources/memory.ts` follow the
same convention even where the file touches a single tier.

**`injectors.ts` is the plugin's single injector entry point.** Its exported
`memoryInjectors` is the complete set `defaultMemoryPlugin` contributes —
including the v3 pair defined in `v3/injector.ts` — so `plugins/defaults/index.ts`
imports the array and nothing else. A new tier injector is added to that array,
never registered from the host.

**v3 injection invariants.** The mechanics are documented in the modules
that own them (`v3/injector.ts`, `v3/prune.ts`, `v3/ever-injected-store.ts`,
`v3/plugin-schema.ts`, `substrate/injected-block-slugs.ts`,
`hooks/injection-metadata.ts`); these are the rules an outside change must
not break.

- **The section is the unit.** Each turn the `memory-v3` injector renders
  every section selected for each selected page (its lead when the page was
  selected with no section; a capability slug renders its whole capability
  content) into one frozen `<memory>` block, net-new only: a
  `(conversation, slug, section key)` pair resident in
  `memory_v3_injected_sections` is never re-rendered. The key is
  `v3/types.ts`'s `sectionKey()` (`""` for the lead, the trimmed heading title
  otherwise, `title#<n>` for the n-th repeat of a heading and `~<n>` appended
  for the n-th chunk of an over-long section, with literal `#` and `~` in
  titles doubled so the encoding is a bijection), and `sectionRefId()` there
  is the one string encoding of a `(slug, key)` pair for keying maps and
  sets. Do not add another.
- **The block grammar has one owner.** `substrate/injected-block-slugs.ts`
  writes the `# memory/concepts/<slug>.md § <key>` section header (the bare
  page header for a lead), escapes every chunk body (`escapeInjectedBody`:
  one leading backslash on a line that would otherwise read as a boundary,
  so page or skill text can never forge one) and parses blocks
  (`parseInjectedSections`). The prune valve, the `loadFromDb` rehydration
  filter, the truncated-fork seed, and the retry anchor merge all read
  through it; do not add a second header matcher or chunk splitter. The one
  exception is `LEGACY_CARD_HEADER_REGEX` in the same file, the pre-stamp
  card grammar that `parseLegacyCards` alone reads for legacy blocks.
- **A block's format is explicit provenance, never inferred from its
  content.** The persisting build stamps `memoryV3InjectedBlockFormat`
  beside `memoryV3InjectedBlock`; a row is current exactly when its stamp
  equals the plugin's `MEMORY_V3_INJECTED_BLOCK_FORMAT`, and a row carrying
  the block without the stamp is legacy (`InjectedBlockFormat` in
  `v3/types.ts`). A legacy block is read with the card grammar of the build
  that rendered it (`filterLegacyCards`), each card under its lead ref
  `(slug, "")`: a card whose lead is tombstoned, or whose lead a current
  block re-injected after a prune, leaves; nothing else in it is parsed,
  pruned, counted, indexed, or fork-seeded, and it ages out at compaction.
- **A block claims its sections only through its commit.** The section
  record (`recordInjected`) and the prune-valve schedule ride the commit
  callback the block carries (`memoryV3Commit`), which runtime assembly
  invokes only where the block persists; re-entry, run-messages-replacement,
  and post-compaction assemblies attach blocks in memory only and claim
  nothing, so a turn's sections are recorded once.
- **Pointers are per message.** Sections re-selected while resident are
  listed, paths only, in the `memory-v3-pointer` injector's `<memory_pointer>`
  block, persisted under `memoryV3PointerBlock` on the user message that was
  sent with it and rehydrated with it; a fresh pointer is spliced only onto
  the new tail, no historical message is ever rewritten, and the hook's
  metadata update states the turn's layout including its deletions (a retry
  re-runs onto its anchor row). The legacy `memoryV3SpotlightBlock` is never
  written and rehydrates verbatim.
- **Pruning is tombstones plus filters, never a metadata rewrite.** The prune
  valve (`v3/prune.ts`, `memory.v3.prune`) evicts by each section row's own
  `last_selected_at` (the injector stamps every section a turn selects) with
  no lane exemptions, marks rows `pruned_at`, and strips the pruned sections
  from the live history and at rehydration; both filter points also keep only
  each section's newest persisted copy. The live strip owns a `<memory>`
  block by object identity (`markV3LiveBlock` / `isV3LiveBlock` in
  `v3/types.ts`), never by text, so a pre-cutover v2 block byte-identical to
  a v3 entry is left alone.
- **The store resets only behind a durable strip marker.** The reset
  (`clearConversation`, through `ConversationGraphMemory.onCompacted`) runs
  whenever the durable history is injection-stripped, not only when a summary
  lands: `resetInjectionLedgersForStrip` (in
  `daemon/conversation-agent-loop-handlers.ts`) runs it from the loop's
  `compaction_completed` dispatch on a run that compacted nothing and from
  `applyCompactionResult` on a real compaction, `/clean` runs it the same way,
  and every reset precedes the re-injection. The reset is gated on the
  `historyStrippedAt` marker being durable, since a reload with no marker
  rehydrates the frozen blocks the reset unclaimed: the loop's
  `history_stripped` dispatch writes the marker at the strip, a write that
  succeeds there counts for the pair, and when no write succeeds a run that
  compacted nothing keeps the store intact and commits the injected
  pre-compaction history instead (the dispatcher reports the outcome to the
  loop through its run's `injectionLedgerResets`, and the loop continues from
  the injected history), so residency and the live history agree either way.
  A compacted result has already lost its frozen blocks to the summary, so
  there, once the compaction commit has landed, the store resets even without
  the marker (a reload may rehydrate the
  kept tail's blocks unclaimed once, until the newest-copy filter retires them
  behind a re-injected copy), and a reset whose ledger clear fails reports
  that the same way a missing marker does.
- **The store is plugin-owned.** `memory_v3_injected_sections`,
  `memory_v3_pools`, `memory_v3_pool_inputs`, `memory_v3_pool_texts`, and
  the `section_key` column of `memory_v3_selections`
  are created by `v3/plugin-schema.ts` (`ensureMemoryV3PluginSchema` from the
  `init` hook, and each store's once-per-connection ensure on first use),
  never by the global migration chain, and every read goes through its
  fail-soft `memoryReader`, so an unavailable memory database degrades a
  store to no-ops rather than failing a turn or readiness. The superseded
  `memory_v3_ever_injected` has exactly one reader, the sections ensure's
  one-time copy of its rows into the section store as zero-byte lead entries
  (checkpoint `memory_v3_injected_sections:legacy_copy_done`, below), and
  two writers, the compaction reset (`clearConversation`) and the
  conversation purge, which delete a conversation's rows so no later copy
  re-imports leads whose blocks are gone.
- **Lanes and caps.** The finder lanes surface in a fixed order and only ever
  add lines; a page carries at most `memory.v3.finderSectionsPerPage` capped
  lines plus its entity and rare-term lines (the lane rules are under
  `memory_v3_pools` below).

Both rules are enforced by `__tests__/memory-tier-boundary-guard.test.ts`, which
also carries a reverse stale-exemption test: an allowlist entry whose multi-tier
import disappears fails loudly instead of lingering. Related guards:

- `src/__tests__/plugin-import-boundary-guard.test.ts` — relative-specifier
  baseline for the whole plugin tree.
- `src/__tests__/persistence-layering-guard.test.ts` — one-way
  memory → persistence direction. It holds **two** separate maps, and they mean
  opposite things:
  - `PERSISTENCE_TO_MEMORY_ALLOWLIST` — genuine tech debt, ratcheting to zero.
    Today it holds exactly one file, `persistence/conversation-crud.ts`
    (`fork-conversation-memory`, `indexer`).
  - `MIGRATION_REGISTRY_MEMORY_IMPORTS` — a **permanent** exception, not tech
    debt: `persistence/steps.ts` is the migration registry and references each
    migration in the domain that owns it, today
    `{"v1/graph/bootstrap"}`. Deleting v1 does not retire the exemption, it
    moves the **pointer**: the v1 runbook relocates `migrateToolCreatedItems`
    to a surviving home (the registration is append-only and must keep
    running), and this entry is repointed at that module — or drops out only
    if the function lands inside `persistence/` itself.
- `src/plugins/__tests__/plugin-state-boundary-guard.test.ts` — the
  grandfathered main-DB exception for this plugin (do not grow its surface).

## Which predicate gates what

All predicates live in `assistant/src/config/memory-v3-gate.ts`. **Nothing else
may read raw `memory.substrate.*` / `memory.v3.*` tier keys** — those reads are
a layering leak, and the boundary guard's `TIER_KEY_READ_ALLOWLIST` pins the
frozen (path, namespace) exemptions.

| Predicate               | True when                                                     | Gates                                                                             |
| ----------------------- | ------------------------------------------------------------- | --------------------------------------------------------------------------------- |
| `isMemoryEnabled`       | `memory.enabled !== false` (master switch, defaults on)       | the whole memory system, the retrospective family, the jobs worker's memory drain |
| `isMemoryV1Active`      | never while memory is on (the v1 tier is retired)             | everything under `v1/`, the v1 job handlers, the v1 maintenance/index triggers    |
| `usesConceptPageMemory` | `memory.enabled !== false`                                    | everything under `substrate/`, the graph tool handlers, the static `<info>` block |
| `isMemoryV3Live`        | `memory.v3.live === true`                                     | everything under `v3/`                                                            |
| `isV3TierActive`        | memory on AND v3 live (the v3 TIER — `memoryTier() === "v3"`) | `GET /memory-graph` + the `graph_supported` bit, AND procedural-memory-as-skills  |

The concept-page substrate is active whenever memory is on, so `v1/` never
runs on a memory-on assistant. Legacy code paths that key on
`!usesConceptPageMemory(config.memory)` therefore agree with
`isMemoryV1Active` in every state.

`assistant/src/config/memory-tier.ts`'s `memoryTier()` is fully DERIVED from
these predicates (`off` → `v3` → `v1`, in that precedence; the `v2` bucket is
retired and never returned), so the telemetry buckets and the runtime gates
can never disagree.
`persistence/jobs-store.ts`'s config-singleton `isMemoryEnabled()` delegates to
the gate predicate for the same reason.

## Config namespaces

| Namespace                | Role                                                                                                                                          |
| ------------------------ | --------------------------------------------------------------------------------------------------------------------------------------------- |
| `memory.enabled`         | Master switch. `false` turns the whole system off regardless of tier keys.                                                                    |
| `memory.substrate.*`     | **Override-only** substrate tuning. Fifteen keys, every one optional with no default.                                                         |
| `memory.v2.*`            | The v2 engine's own tunables (activation weights, router, rerank) **plus** the historical substrate twins that supply the effective defaults. |
| `memory.v3.*`            | v3 lane/orchestrator tuning, plus `memory.v3.live`.                                                                                           |
| `memory.retrospective.*` | Retrospective cadence and triggers — tier-agnostic.                                                                                           |

`substrate/tuning.ts`'s `resolveSubstrateTuning` is the substrate's **single
config choke point**: each key resolves as `memory.substrate.X ?? memory.v2.X`
(an explicit `null` on a nullable key counts as present and wins).
`spread_k` / `spread_hops` / `ann_candidate_limit` map onto `memory.v2.k` /
`memory.v2.hops` / `memory.v2.ann_candidate_limit`; every other key shares its
name with its twin.

The dense/sparse sum-to-1 invariant is checked once, in the substrate schema's
own refinement, over the resolved pair.

`memory.substrate` carries every shipped default, so it is the single config
surface for concept-page tuning. There is no legacy namespace to pair with and
no shadowing to report.

Workspace migration 135 copies explicitly-set NON-DEFAULT `memory.v2` substrate
tunables into `memory.substrate`. It skips loader-seeded defaults — including
`bm25_b`'s earlier `0.75` default — because raw presence in `config.json` is not
user intent (the loader serializes the fully-parsed config), and copying seeded
values would permanently pin those assistants when substrate defaults are
retuned.

## FROZEN NAMES

These names are durable or wire-visible. **Never rename them**, including
during a tier deletion — several are spelled `v2` but belong to the substrate,
which outlives the v2 engine.

### SQLite tables

Persisted rows; a rename orphans every existing install.

| Table                             | Owner                                                           |
| --------------------------------- | --------------------------------------------------------------- |
| `memory_graph_nodes`              | all-tier (`graph/store.ts`)                                     |
| `memory_graph_edges`              | all-tier                                                        |
| `memory_graph_triggers`           | all-tier                                                        |
| `memory_graph_node_edits`         | all-tier                                                        |
| `memory_segments`                 | v1 indexing                                                     |
| `memory_summaries`                | v1 indexing                                                     |
| `memory_embeddings`               | shared embedding cache                                          |
| `memory_checkpoints`              | shared (all durable checkpoints)                                |
| `memory_jobs`                     | shared job queue                                                |
| `memory_recall_logs`              | shared recall audit                                             |
| `conversation_graph_memory_state` | `graph/graph-memory-state-store.ts`                             |
| `activation_state`                | v2 per-conversation activation                                  |
| `memory_v2_activation_logs`       | v2 inspector/harness                                            |
| `memory_v2_injection_events`      | v2 scoring feedback                                             |
| `memory_v3_selections`            | v3 selection log (`section_key` column plugin-added, see below) |
| `memory_v3_pools`                 | v3 selector pool audit (plugin-created, see below)              |
| `memory_v3_pool_inputs`           | v3 selector input capture, opt-in (plugin-created, see below)   |
| `memory_v3_pool_texts`            | v3 pooled candidate texts by content hash, opt-in (see below)   |
| `memory_v3_injected_sections`     | v3 section dedup, prune bytes + recency (plugin-created, below) |
| `memory_v3_ever_injected`         | v3 card dedup (superseded, frozen)                              |
| `memory_retrospective_state`      | retrospective (tier-agnostic)                                   |
| `activation_sessions`             | onboarding activation rail                                      |

`memory_v3_pools`, `memory_v3_pool_inputs`, `memory_v3_pool_texts`, and
`memory_v3_injected_sections` are the plugin's own tables, created by the
plugin rather than by the global migration chain
(`v3/plugin-schema.ts`): the memory plugin's `init` hook ensures both on every
boot, and each store ensures again on the first use of a connection in its
process (the memory worker is a separate process), idempotently and fail-open,
so a memory database that cannot be opened degrades the stores to no-ops
instead of failing database readiness. The sections ensure adds the
`last_selected_at` column (the prune valve's recency stamp) to a table created
before it existed, and copies the legacy `memory_v3_ever_injected` rows in as
zero-byte lead entries, once per database: the first ensure that finds the
legacy table copies (`INSERT OR IGNORE`) and records
`memory_v3_injected_sections:legacy_copy_done`
in `memory_checkpoints`, later ensures skip on that record, and a ledger that
cannot be read skips the copy rather than repeating it. The compaction reset
(`clearConversation`) and the conversation purge delete a conversation's
legacy rows with its section rows, so a copy can never bring back leads whose
blocks compaction stripped. `memory_v3_selections` itself is created by migration
338, but its
`section_key` column is plugin-owned the same way: the selection log's writer
(`writeTurnLog`) and the inspector's reader (`v3/selection-log-store.ts`) add
it on the first use of a connection, and the `init` hook at boot. Every
selection row records one section per slug, the selection's first selected
section, as its `sectionKey` beside the title and ordinal (an inspector and
frecency record only; the prune valve's recency lives on the section store's
rows, see the v3 injection invariants above), and the inspector
resolves a row by that key first (exactly, so a repeated heading's other
occurrence is never substituted), falling back to title-then-ordinal only for
rows written before the column existed.

`memory_v3_pools` (`v3/pool-log-store.ts`) holds one row per turn: the
selector's full candidate pool (every stable-prefix card and finder line, in
pool order, with lane, matched section, and a per-line verdict) for the
inspector's Memory tab, plus `selector_ran`. A page carries one finder line
per distinct matched section, at most `memory.v3.finderSectionsPerPage` in
surfacing order (needle, dense, reply, span) plus its entity and rare-term
lines, and selecting a line selects that section; the selection log keeps
one row per slug, so the pool row is where the per-section verdicts live. A
turn whose selector never judged a pool persists it with `selector_ran = 0`:
an empty pool when the injection gate hard-skipped it or nothing was pooled,
and the pool as the selector was given it, stable-prefix cards chosen and
finder lines not, when the selector's provider failed and the orchestrator
kept that prefix unjudged. That turn writes no `memory_v3_selections` rows:
the hot set's frecency and the learned-edge graph read that table as
judgments, and an unjudged page is not one. A
turn that logged no selections is still reachable by its stamped
`message_id`, so the inspector shows negative verdicts too. The pool row and
the turn's `memory_v3_selections` rows are
written in one transaction (`writeTurnLog` in `v3/shadow-plugin.ts`), and a
turn observed again replaces both, so the pool's `chosen` flags and the
selection rows always describe the same observation. Rows are per-turn
diagnostics, roughly 10KB each, with no retention job; a conversation delete
purges them with the other conversation-keyed tables
(`conversation-memory-purge.ts`).

`memory_v3_pool_inputs` and `memory_v3_pool_texts` (`v3/pool-log-store.ts`,
written only under `memory.v3.poolLog.captureInput`, off by default) extend
the pool row with the selector's exact input, for offline selector
evaluation and training data. One `memory_v3_pool_inputs` row per turn
holds the context strings the selector was given (situation, recent context,
current message, the previous assistant reply), the selector prompt's
content hash, the gate reason, the keep-all flag, and the content hash of
every pooled candidate's rendered text in pool order, aligned index for
index with the pool row's `candidates_json` (pool position `i + 1` is the
number the selector saw candidate `i` under). `memory_v3_pool_texts` holds
each rendered text once by that hash: a stable-prefix card is its
pre-rendered card, a finder line is exactly the line the selector saw minus
its number (`renderFinderLine` in `v3/pool-select.ts`), and a card repeated
across turns is stored once. The input row is written in the transaction
that writes the pool and selection rows and purged with the conversation;
the texts table is page-derived and keyed by content, so it is never purged
per conversation.

**v3 finder lanes.** The per-turn finder lanes (`v3/orchestrate.ts`) surface
candidates in a fixed order, needle, dense, reply, span, entity, rare, then
edge and learned, and each only ever adds lines. The entity lane
(`v3/entity-lane.ts`, `memory.v3.entity`) and the rare-term lane
(`v3/rare-term-lane.ts`, `memory.v3.rareTerm`) key on one strong token rather
than the whole message: a distinctive `## ` heading token the message names,
and a query word rare across the corpus, which surfaces its top `perTerm`
sections by single-term BM25F (`SectionNeedle.df` and `scoreTerm`), rarest
words first up to `cap` per turn, with no token-shape filtering (a word the
corpus does not hold has df 0 and drops out on its own; bigram terms are never
eligible). Rare is corpus-relative: a word qualifies when its df is at most
`min(maxDf, max(1, floor(sectionCount * maxDfFraction)))` (defaults 12 and
0.002), so a corpus of 6,000 sections or more runs at `maxDf` and a corpus of
a few hundred sections counts only a word unique to one section as rare; an
absolute ceiling would make most ordinary words of a small corpus rare and
fill `cap` with noise every turn. Both are synchronous in-memory passes that
feed neither the injection gate nor the edge seeds, and pool through the same
`(page, section key)` dedupe as every other lane, so a section another lane
already pooled is a no-op. Both lanes' lines are outside the per-page cap
(`memory.v3.finderSectionsPerPage`), neither counted against it nor
displaced by it, because each lane runs after every lane that fills the cap
and a page already carrying that many bulk-theme lines would otherwise drop
exactly the line the lane exists to surface. The lanes' own caps bound what
they add instead (`entityCap` articles per turn for the entity lane,
`perTerm` and `cap` for the rare-term lane), so a page carries at most
`finderSectionsPerPage` capped lines plus its entity and rare lines,
`finderSectionsPerPage + entityCap + rareTerm.cap` in all. The entity lane runs
at every corpus size (the lean profile does not switch it off); the
rare-term lane runs only when the selector does (`v3/shadow-plugin.ts`
threads `rareTerm` only
with `selectorEnabled`), because rare lines are candidates for a judge, not
evidence strong enough to inject unjudged, and with the selector off every
pooled line is injected. A rare hit's pool line is
tagged `(rare: <word>)` with a keyword-in-context snippet centered on the
word, and its selection records `source = 'rare'`; the pool record and the
selection log carry the lane name with no other change.

### Job types (`memory_jobs.type`)

Persisted in job rows; unknown types either throw or get silently drained.

- Substrate: `memory_v2_consolidate`, `memory_v2_sweep`, `memory_v2_reembed`,
  `embed_concept_page`
- v2 engine: `memory_v2_migrate`, `memory_v2_activation_recompute`
- v3: `memory_v3_maintain`
- Retrospective: `memory_retrospective`, `memory_retrospective_sweep`,
  `skill_card_insert`, `skill_update_receipt`
- v1: `graph_extract`, `graph_decay`, `graph_consolidate`, `graph_pattern_scan`,
  `graph_narrative_refine`, `graph_bootstrap`, `embed_pkb_file`, `pkb_filing`,
  `pkb_compaction`, `rebuild_index`, `backfill`, `delete_qdrant_vectors`,
  `sweep_orphaned_graph_node_points`
- All-tier embedding: `embed_graph_node`, `graph_trigger_embed`,
  `embed_segment`, `embed_summary`, `embed_media`, `embed_attachment`
- Retired, still in the union: `memory_v3_consolidate`,
  `memory_v3_index_maintenance`, `memory_v3_edge_learning` (v3-rip casualties —
  handlers removed) and `conversation_analyze` — never enqueued, but they stay
  `MemoryJobType` members **and** `LEGACY_JOB_TYPES` members so pre-upgrade rows
  drain silently
- Retired, `LEGACY_JOB_TYPES` only (already out of the union):
  `memory_v2_rebuild_edges`, `memory_proc_distill`, and the pre-memory batch
  (`embed_item`, `extract_items`, `batch_extract`, `extract_entities`,
  `cleanup_stale_superseded_items`, `backfill_entity_relations`,
  `refresh_weekly_summary`, `refresh_monthly_summary`, `journal_carry_forward`,
  `generate_capability_cards`, `generate_thread_starters`)

Retired types are never deleted from the `MemoryJobType` union — they move to
`LEGACY_JOB_TYPES` in `jobs-worker.ts` so pre-upgrade rows drain instead of
throwing. Dropping a name from **either** list strands the persisted rows that
still carry it: the worker's dispatch falls through to
`Unknown memory job type: <type>` and the row fails forever instead of
completing. The `LEGACY_JOB_TYPES` set is therefore append-only in practice —
prune it only after you can prove no install still holds a pending row.

### Checkpoint keys (`memory_checkpoints.key`)

`GRAPH_MAINTENANCE_CHECKPOINTS` in `jobs-worker.ts`, plus the consolidation
failure record and the section re-embed high-water:

- `memory_v2_consolidate_last_run`, `memory_v3_maintain_last_run` — cadence
- `memory_v2_consolidate_failure_state` (`substrate/consolidation-job.ts`) —
  the consolidation backoff record
- `memory_v3_maintain:sections_embedded_through_ms`
  (`v3/section-dense-store.ts`'s `MAINTAIN_EMBED_HIGH_WATER_KEY`) — durable
  epoch-ms high-water of the last successful section re-embed pass; when it is
  absent the maintain job re-embeds EVERY page, so losing or renaming it forces
  a full rebuild. Distinct from the `memory_v3_maintain_last_run` cadence key
  despite the shared prefix
- `memory_v3_maintain:section_chunker_version`
  (`v3/section-dense-store.ts`'s `SECTION_CHUNKER_VERSION_KEY`, current value
  `SECTION_CHUNKER_VERSION`): the chunker version the stored section vectors
  were built with. `ensureSectionChunkerVersion` (run at dense lane init and
  by the maintain job and the backfill before an embed pass) clears the
  high-water above on a mismatch so the collection is rebuilt from every
  page, since point ids and dense hits key on `(article, ordinal)`. A store
  with no version on record counts as stale, not fresh, when a high-water or
  the pending marker below is on record or the collection already holds
  points; only an empty collection records the version with nothing to
  rebuild
- `memory_v3_maintain:section_rebuild_pending`
  (`v3/section-dense-store.ts`'s `SECTION_REBUILD_PENDING_KEY`): written
  before that high-water reset (the marker is the only signal that survives
  the reset, so an interruption between the two writes leaves the hold in
  place and the next check finishes the transition) and cleared by
  `commitSectionEmbedHighWater`, the commit that ends a zero-failure re-embed
  pass (the maintain job's and the backfill's). While it is set the dense lane
  serves no hits (`holdSectionDenseReadsUntilRebuilt` at lane init,
  `sectionDenseReadsHeld` on every dense read), the check that first reports
  it in this process (at lane init, or retried from the dense read path)
  enqueues `memory_v3_maintain` at once instead of waiting out the
  cadence key, and the maintain pass it names re-embeds every capability row
  the store holds (the change delta never names one) before its commit
  clears the marker: a stored row whose body renders empty in that process
  holds the commit until the deleted-page prune removes it, so the marker
  never clears over points built by the previous chunker. The pass runs in
  the memory worker, whose skill and CLI caches are never seeded, so a
  version rebuild there prunes every capability row (its page index lists
  none) and commits over a store with no capability points, which
  `backfill-sections` (run in the daemon, caches seeded) restores. A version
  check that throws (Qdrant unreachable for the collection
  probe, an unreadable ledger) holds dense reads as indeterminate: the hold
  ignores the marker's absence, which is what the failed check left unproven,
  and the dense read path (`settleSectionDenseReadHold`) retries the check at
  most once a minute (`SECTION_VERSION_CHECK_RETRY_MS`) until one completes,
  which marks the rebuild pending and kicks it, or releases the hold
- `memory_v3_injected_sections:legacy_copy_done`
  (`v3/plugin-schema.ts`'s `SECTIONS_LEGACY_COPY_DONE_KEY`): the legacy
  `memory_v3_ever_injected` rows were copied into
  `memory_v3_injected_sections` once on this database, and every later
  sections ensure skips the copy on it. Losing it repeats the copy, which is
  idempotent (`INSERT OR IGNORE`) and cannot resurrect a conversation the
  compaction reset or a purge cleared, since both delete its legacy rows too
- v1: `graph_maintenance:{decay,consolidate,pattern_scan,narrative}:last_run`,
  `pkb_filing_last_run`, `pkb_compaction_last_run`,
  `graph_bootstrap:*`, `memory:backfill:*`
- `retro_sweep:last_run` — retrospective sweep cadence

### On-disk / vector-store names

| Name                          | Where                                                                                    | Why frozen                                                                                                    |
| ----------------------------- | ---------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------- |
| `memory_v2_concept_pages`     | `substrate/qdrant.ts` `MEMORY_V2_COLLECTION`                                             | Qdrant collection on disk. **Duplicated** in `persistence/embeddings/embedding-identity.ts` — change neither. |
| `memory_v3_sections`          | `v3/section-dense-store.ts` `SECTION_COLLECTION`                                         | Qdrant collection on disk                                                                                     |
| `.memory-v2-reembed-required` | `substrate/qdrant.ts`                                                                    | on-disk sentinel read across upgrades                                                                         |
| `memory/.v2-state/`           | `getConsolidationLockPath` in `substrate/consolidation-lock.ts`, workspace migration 060 | persisted workspace path (consolidation lock, migration sentinel)                                             |

### Wire-visible strings

| Name                                                                                                                                                                  | Kind                                  | Why frozen                                                              |
| --------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------- | ----------------------------------------------------------------------- |
| `memory_v2_consolidation`                                                                                                                                             | `conversations.source` value          | persisted on every consolidation run                                    |
| `memory_retrospective`                                                                                                                                                | request origin / `TitleOrigin` member | the permission checker's skill-authoring auto-grant is scoped to it     |
| `skill-authored-card`                                                                                                                                                 | message kind                          | persisted on skill-card messages                                        |
| `memoryV2Consolidation`, `memoryRetrospective`                                                                                                                        | LLM call-site ids                     | logging/attribution buckets                                             |
| `memoryInjectedBlock`, `memoryV3InjectedBlock`, `memoryV3InjectedBlockFormat`, `memoryV3PointerBlock`, `memoryV3SpotlightBlock` (legacy, read-only), `memoryV3Commit` | message-metadata keys                 | persisted on messages; drives re-injection and the strip                |
| `memory-v2-static`                                                                                                                                                    | injector + block id                   | stable id for the static `<info>` block; persisted history may carry it |
| `MEMORY_V2_DISABLED`                                                                                                                                                  | error code                            | clients branch on it                                                    |
| `memory.v2.sweep`                                                                                                                                                     | notification job identifier           | surfaced in `activity.failed`                                           |

### HTTP surface

Operation ids and endpoints are published in `assistant/openapi.yaml` and
consumed by generated clients:

- `memory-items`, `memory-items/:id` (`listMemoryItems`, `getMemoryItem`,
  `createMemoryItem`, `updateMemoryItem`, `deleteMemoryItem`)
- `memory-nodes`, `memory-nodes/delete`, `memory-nodes/update`
  (`listMemoryNodes`, `deleteMemoryNode`, `updateMemoryNode`)
- `memory/remember` (`createMemory`), `memory/stats` (`getMemoryStats`)
- `memory-graph`, `memory-graph-node` (`getMemoryGraph`, `getMemoryGraphNode`)
- `memory/v2/*` — `backfill` (reembed only), `concept-page`,
  `list-concept-pages`, `reembed-skills`, `validate` (operation ids
  `memory_v2_*`; the namespace spelling is frozen wire surface)
- `memory/v3/*` — `backfill-sections`, `rebuild-index`
- `memory/ingest` (IPC method `memory_ingest`; the generated OpenAPI/HTTP
  operation id is `memory_ingest_post`): POST, deterministic batch
  concept-page ingestion
- `memory/worker/*`, `memory/eval/*`
- `consolidation/config`, `consolidation/run-now`, `consolidation/runs`
- `filing/config`, `filing/run-now` (v1)

### Telemetry

| Name                                                                          | Kind                 | Consumer            |
| ----------------------------------------------------------------------------- | -------------------- | ------------------- |
| `memory.enabled`, `memory.v3.live`                                            | config-setting keys  | platform dashboards |
| `memory_tier` check_name + `detail.tier` ∈ `off`/`v1`/`v2`/`v3`               | watchdog event       | platform dashboards |
| `memory_v3_injection_gate`, `memory_v3_selection`, `memory_retrospective_run` | watchdog check names | platform dashboards |

Renaming any of these silently breaks a dashboard rather than failing a build —
coordinate with the platform before touching them. The `memory_tier` contract
(check name plus the exact `off`/`v1`/`v2`/`v3` bucket strings) is specified in
`src/telemetry/AGENTS.md` — that is the authoritative statement; do not restate
its rules here.

### Log component names

`getLogger("<scope>")` tags every line the module emits with that scope, so a
scope name is **observable**: saved log queries, `vellum logs` filters, and
support runbooks grep on it. Renaming one does not fail a build and does not
lose data — it silently empties whatever was filtering on the old name. Not
frozen the way a table or a wire string is, but rename deliberately and expect
to update queries.

Two scopes changed in the tier split and are called out here so a stale query
is diagnosable:

| Module                       | Scope now           | Was                  |
| ---------------------------- | ------------------- | -------------------- |
| `substrate/boot-maintenance` | `boot-maintenance`  | `memory-v2-startup`  |
| `substrate/reembed-job`      | `memory-v2-reembed` | `memory-v2-backfill` |

The reembed job's lines moved from the shared `memory-v2-backfill` scope to a
dedicated one. Note that most substrate scopes keep their `memory-v2-*`
spelling (`memory-v2-qdrant`, `memory-v2-page-index`, `memory-v2-consolidate`,
`memory-v2-sweep`, …) — same rule as the frozen names above: the `v2` spelling
does not make them the v2 engine's, and they must not be renamed
opportunistically with it.

## Deletion runbook: v1

### Prerequisites that BLOCK deletion

Do not start until both are resolved. Each is a live all-tier dependency on
v1-era machinery.

1. **The graph node surface is all-tier.** `graph/store.ts`,
   `graph/capability-seed.ts`, and `graph/tool-handlers.ts` write and read
   `memory_graph_nodes` on **every** tier. The `handleListMemory` /
   `handleDeleteMemory` / `handleUpdateMemory` handlers are gated on
   `usesConceptPageMemory()` yet operate on that v1-era store — so the node
   surface (and the `memory-nodes` routes and `memory items` CLI over it) must
   be ported to the substrate or retired **before** v1 can go. Deleting `v1/`
   does not remove these tables.
2. **`graph/conversation-graph-memory.ts` owns all-tier duties.** Beyond the
   v1↔v2 dispatch it does compaction eviction of v2 activation rows and v3
   `everInjected` state (`onCompacted`), and it defines the injected-block strip
   identity that `daemon/conversation-runtime-assembly.ts` matches on. Those
   move to a tier-neutral home first.

### External consumers to repoint or retire

The steps below cover the plugin's own spine. These three production files sit
**outside** `MEM/` and import `v1/` directly, so a deletion that skips them
leaves broken imports and an unbuildable tree. Handle them in the same change,
before or alongside step 1.

1. **`runtime/routes/global-search-routes.ts`** → `semanticSearch` from
   `v1/semantic-search.ts`. **Retire the route arm.** It backs only
   `searchMemoriesSemantic`, the `deep=true` half of the `memories` category,
   and `semanticSearch` already returns `[]` on any concept-page assistant (its
   own `usesConceptPageMemory` early return), so the arm is dead on every
   non-v1 install. Delete `searchMemoriesSemantic` and its `deep` call site.
   Do **not** repoint it at the substrate: the sibling `searchMemoryItems` is a
   lexical scan of `memory_graph_nodes` — all-tier, and it keeps the category
   answering — while surfacing concept pages here is a new feature over a
   different id space (page slugs, not node ids) and belongs in its own change.
   Both the `deep` query parameter and the response `source` enum
   (`lexical` | `semantic`) are published in `assistant/openapi.yaml`: `deep`
   becomes a no-op and `semantic` an unreachable variant, and narrowing either
   is a separate, client-coordinated spec change.
2. **`tools/filesystem/write.ts`** → `enqueuePkbIndexJob` from
   `v1/jobs/embed-pkb-file.ts`. **Delete the call site.** It fire-and-forgets a
   PKB re-index after a `file_write` under `workspace/pkb/**.md`, and
   `enqueuePkbIndexJob` already returns `""` when `usesConceptPageMemory()`
   holds — the call is inert under the substrate. Drop the whole `pkbRoot` /
   `isInsidePkbRoot` try block; keep the local `isInsidePkbRoot` helper, which
   the apps-dir containment check earlier in the file still uses. There is no
   substrate equivalent to repoint to — concept pages are re-embedded by
   `jobs/embed-concept-page.ts` off the page-write path.
3. **`persistence/steps.ts`** → `migrateToolCreatedItems` from
   `v1/graph/bootstrap.ts`. **MOVE THIS FUNCTION — DO NOT DELETE IT.** It is a
   registered entry in the append-only migration list (slot "101b", between
   `migrateMemoryGraphImageRefs` and `migrateDropMemoryItemsTables`) that
   copies legacy `memory_items` rows into `memory_graph_nodes` — an all-tier
   table that outlives v1. Every fresh install replays the whole chain, so
   deleting the function strands those rows on upgrade paths and defeats
   `migrateDropMemoryItemsTables`'s "already migrated" safety check. Three
   things to preserve when moving it:
   - **The exported name.** Bare-function steps are identified by
     `Function.name` for checkpointing, and `migrateMoveMemoryGraphTablesToMemoryDb`
     names the string `"migrateToolCreatedItems"` in its `dependsOn`. Renaming
     it re-runs the migration on existing installs and breaks that dependency
     edge.
   - **Its position** in the ordered `steps.ts` list — it must still run before
     `migrateDropMemoryItemsTables`.
   - **The persistence-layering guard's exemption.**
     `assistant/src/__tests__/persistence-layering-guard.test.ts` maps
     `assistant/src/persistence/steps.ts` → `{"v1/graph/bootstrap"}` in
     **`MIGRATION_REGISTRY_MEMORY_IMPORTS`** — NOT in
     `PERSISTENCE_TO_MEMORY_ALLOWLIST`, which holds only
     `persistence/conversation-crud.ts`. Editing the wrong map leaves the
     exemption in place and fails the guard. The exemption itself is permanent
     (a migration registry referencing the domain that owns each step is the
     registry's job); what moves is the pointer. Repoint the entry at the new
     module, or drop it only if the function lands inside `persistence/`; the
     guard's stale-entry test fails on a left-behind exemption either way.

   The function reads and writes only `memory_items`, `memory_graph_nodes`, and
   its own memory checkpoint, so `persistence/migrations/` or the all-tier
   `graph/` are both viable homes. `bootstrap.ts`'s other exports
   (`bootstrapFromHistory`, `maybeEnqueueGraphBootstrap`) are genuinely v1 and
   go with the tier.

**Re-run the scan at deletion time** rather than trusting this list — consumers
accrue:
`grep -rnE '(from|import\() *"[^"]*v1/' assistant/src --include='*.ts' --include='*.tsx' --exclude-dir=__tests__ --exclude-dir=v1 | grep -v '\.test\.'`
(spine hits are the composition points the steps below already cover; anything
else is a new external consumer needing its own repoint-or-retire decision).

**Then re-run it WITHOUT the test exclusions** — drop `--exclude-dir=__tests__`
and the `grep -v '\.test\.'`. Test files import `v1/` too, and not all of them
are v1 tier tests that die with the tier; the non-tier ones get **repointed,
not deleted**. Today the test-only hits are:

- v1 tier tests, deleted with the tier: `src/__tests__/pkb-autoinject.test.ts`,
  `injection-block.test.ts`, `graph-extraction-event-date.test.ts`,
  `memory-identity-context-parity.test.ts`,
  `rebuild-index-graph-nodes.test.ts`, and
  `injector-pkb-v2-silenced.test.ts` (its subject is the v1 PKB pair being
  silenced under the substrate — keep its one tier-agnostic `now-md` case by
  moving it, rather than losing the coverage).
- **not** v1 tests — repoint: `src/__tests__/injector-chain.test.ts` and
  `src/__tests__/conversation-runtime-assembly.test.ts` both pull `getPkbRoot`
  from `v1/pkb/types.js` purely to place a temp workspace; they cover the
  injector chain and runtime assembly on every tier.
- a false positive: `MEM/__tests__/memory-tier-boundary-guard.test.ts` matches
  on `"./v1/a.js"`-style string literals in its own parser tests.

### Steps

1. Delete `MEM/v1/**` (including `v1/README.md` and `v1/graph/graph-search.ts`,
   the hybrid node-SEARCH half) — **after** `migrateToolCreatedItems` has been
   moved out of `v1/graph/bootstrap.ts` per the external-consumers section
   above. `graph/graph-search.ts` is the all-tier embedding plumbing and
   **stays**.
2. Delete `runtime/routes/filing-routes.ts` and drop its `ROUTES` entry from
   `runtime/routes/index.ts`.
3. Retire the `memory-items` route family (`MEM/src/memory-item-routes.ts`'s
   item half) and `cli/commands/memory/items.ts`. Re-verify callers at deletion
   time with `grep -rl 'memory-items' --exclude-dir=node_modules .` — today the
   only hits outside the assistant are the generated `assistant/openapi.yaml`
   and one web test (`clients/web/src/lib/api-interceptors.test.ts`); there are
   no hand-written web callers.
4. Remove the v1 arm of `graph/conversation-graph-memory.ts` (its
   `../v1/graph/injection.js` and `../v1/graph/retriever.js` imports and the
   branches they feed).
5. Remove the v1 branch of `context-search/sources/memory.ts` — it is the file's
   only non-substrate path (`searchGraphNodes` from `v1/graph/graph-search.ts`),
   so the source collapses to its `usesConceptPageMemory` early return.
6. Delete the v1 sections of the spine files. Every one is banner-marked, so
   `grep -rn 'delete with v1' src/plugins/defaults/memory/` is the authoritative
   list — it covers `startup.ts`'s `---- v1 (legacy engine) ----` section labels
   (which spell out the banner phrase for exactly this reason) and the dispatch
   call sites, not only the function bodies:
   `startup.ts` (**three** blocks — the v1 Qdrant ensure and the PKB reconcile,
   both covered by step 8, and the graph-bootstrap tail),
   `jobs-worker.ts` (`enqueueV1MaintenanceJobs` **and** the `else` arm
   that calls it), `job-handlers.ts`, `indexer.ts` (`enqueueV1IndexTriggers`
   **and** its call site), `injectors.ts` (the PKB injector pair). The same grep
   also returns `graph/conversation-graph-memory.ts` and
   `context-search/sources/memory.ts` — steps 4 and 5 above.
7. Delete `V1_QDRANT_JOB_TYPES` and the `SweepPostponedOffV1Error` postpone
   path in `jobs-worker.ts`, plus the v1 job handlers
   (`v1/job-handlers/{backfill,embedding,index-maintenance}.ts`) and their
   `job-handlers.ts` registrations. Move retired job types into
   `LEGACY_JOB_TYPES`; do NOT remove them from `MemoryJobType`.
8. Delete the v1 Qdrant collection lifecycle in `startup.ts` (the
   `config.memory.qdrant.collection` `ensureCollection` block and the PKB index
   reconcile). Both are gated on `!usesConceptPageMemory(config.memory)`, **not
   on `isMemoryV1Active`** — and `runMemoryStartup` has no memory-enabled guard
   of its own, so today they run on `memory.enabled: false` assistants too.
   Delete them outright rather than assuming step 9 already reaches them. Leave
   the lexical-messages collection alone — it is independent.
9. Collapse `isMemoryV1Active` call sites, then delete the predicate. Sweep for
   `!usesConceptPageMemory(...)` separately: it is the actual v1 gate in
   `startup.ts`, `jobs-worker.ts`, `indexer.ts`, and
   `context-search/sources/memory.ts`, and those arms collapse the other way
   (the substrate branch becomes unconditional).
10. Repoint or delete the tests pinned to v1 — the test-inclusive re-scan above
    lists the ones the import scan finds. The lane test
    (`src/__tests__/memory-jobs-worker-lanes.test.ts`) has already been
    repointed at surviving v3/substrate slow- and fast-lane jobs.
11. `memoryTier()`'s `"v1"` bucket becomes unreachable. **Coordinate with the
    platform telemetry dashboard before removing the bucket** — see
    `src/telemetry/AGENTS.md` for the `memory_tier` contract.
12. Shrink the boundary guard: drop `v1` from `TIER_DIRS` /
    `FORBIDDEN_TIER_IMPORTS`, and drop any `SPINE_ALLOWLIST` entry whose second
    tier was v1 (the reverse stale-exemption test will name them for you).

## Where to add new code

- New shared concept-page capability (retrieval, consolidation, page/edge
  storage, capability seeding) → `substrate/`.
- New lane, scorer, or injector behavior for the live engine → `v3/`.
- Tier-agnostic capture (retrospective, sweep triggers) → the plugin root.
- Multi-tier wiring → an existing spine composition point on the
  `SPINE_ALLOWLIST`; do not create a new one.
- **Never add to `v1/`.** It is in retirement; a new feature there is work
  that has to be deleted twice.
