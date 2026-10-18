import { ChevronDown, ChevronRight, Copy } from "lucide-react";
import { useEffect, useState, type ReactNode } from "react";

import type {
  LlmContextResponse,
  MemoryCandidate,
  MemoryRecallLog,
  MemoryV3Pool,
  MemoryV3PoolCandidate,
  MemoryV3SelectionLog,
  MemoryV3SelectionRow,
} from "@vellumai/assistant-api";
import { Card } from "@vellumai/design-library";

import { useCopyToClipboard } from "@/hooks/use-copy-to-clipboard";
import { useTranslation } from "@/i18n";

/**
 * Memory tab rendering V1 recall and/or the V3 selection.
 * When more than one is present a pill switcher lets the user toggle between
 * them; when only one is present it renders directly. The V3 section shows
 * what the v3 retriever selected — injected into context when v3 is the
 * assistant's live memory source, otherwise logged but not injected.
 */
type MemoryView = "recall" | "v3";

type MemoryTranslate = ReturnType<typeof useTranslation<"chat">>["t"];

export function MemoryTab({
  context,
}: {
  context: LlmContextResponse | undefined;
}): ReactNode {
  const { t } = useTranslation("chat");
  const recall = context?.memoryRecall ?? null;
  const v3 = context?.memoryV3Selection ?? null;
  const hasRecall = recall !== null;
  const hasV3 = v3 != null;

  const pills: { id: MemoryView; label: string; show: boolean }[] = [
    { id: "v3", label: t("memoryTab.pillMemoryV3"), show: hasV3 },
    { id: "recall", label: t("memoryTab.pillRecallV1"), show: hasRecall },
  ];
  const available = pills.filter((p) => p.show);

  const defaultView: MemoryView = hasV3 ? "v3" : "recall";
  const [view, setView] = useState<MemoryView>(defaultView);

  useEffect(() => {
    setView(hasV3 ? "v3" : "recall");
  }, [hasV3, hasRecall]);

  if (available.length === 0) {
    return <NoDataState t={t} />;
  }

  const activeView = available.some((p) => p.id === view)
    ? view
    : (available[0]?.id ?? "recall");

  return (
    <div className="flex h-full min-h-0 flex-col">
      {available.length > 1 && (
        <div
          className="flex gap-1 px-4 py-2"
          style={{ borderBottom: "1px solid var(--border-base)" }}
        >
          {available.map((p) => (
            <ViewPill
              key={p.id}
              label={p.label}
              active={activeView === p.id}
              onClick={() => setView(p.id)}
            />
          ))}
        </div>
      )}
      <div className="min-h-0 flex-1 overflow-y-auto">
        {activeView === "v3" && v3 != null ? (
          <MemoryV3Section selection={v3} t={t} />
        ) : recall != null ? (
          <MemoryRecallSection recall={recall} t={t} />
        ) : null}
      </div>
    </div>
  );
}

function ViewPill({
  label,
  active,
  onClick,
}: {
  label: string;
  active: boolean;
  onClick: () => void;
}): ReactNode {
  return (
    <button
      type="button"
      onClick={onClick}
      className="rounded-full px-3 py-1 text-label-medium-default transition-colors"
      style={{
        background: active ? "var(--surface-active)" : "var(--surface-overlay)",
        color: active ? "var(--content-default)" : "var(--content-secondary)",
        border: "none",
        cursor: "pointer",
      }}
    >
      {label}
    </button>
  );
}

function MemoryRecallSection({
  recall,
  t,
}: {
  recall: MemoryRecallLog;
  t: MemoryTranslate;
}): ReactNode {
  const missing = t("memoryTab.missingValue");

  if (!recall.enabled) {
    return (
      <div className="p-4">
        <SectionCard
          title={t("memoryTab.memoryDisabledTitle")}
          subtitle={recall.reason ?? t("memoryTab.memoryDisabledDefaultReason")}
        />
      </div>
    );
  }

  return (
    <div className="flex flex-col gap-4 p-4">
      <ScopeBanner
        title={t("memoryTab.turnLevelRecallTitle")}
        body={t("memoryTab.turnLevelRecallBody")}
      />

      <SectionCard
        title={t("memoryTab.statusTitle")}
        subtitle={t("memoryTab.statusSubtitle")}
      >
        <MetaGrid
          rows={[
            {
              label: t("memoryTab.statusLabel"),
              value: recall.degraded
                ? t("memoryTab.statusDegraded")
                : t("memoryTab.statusActive"),
            },
            {
              label: t("memoryTab.providerLabel"),
              value: recall.provider ?? t("memoryTab.unavailable"),
            },
            {
              label: t("memoryTab.modelLabel"),
              value: recall.model ?? t("memoryTab.unavailable"),
            },
            {
              label: t("memoryTab.totalLatencyLabel"),
              value:
                recall.latencyMs != null
                  ? t("memoryTab.latencyMs", { ms: recall.latencyMs })
                  : missing,
            },
          ]}
        />
      </SectionCard>

      <SectionCard
        title={t("memoryTab.retrievalFunnelTitle")}
        subtitle={t("memoryTab.retrievalFunnelSubtitle")}
      >
        <MetaGrid
          rows={[
            {
              label: t("memoryTab.semanticHitsLabel"),
              value:
                recall.semanticHits != null
                  ? fmt(recall.semanticHits)
                  : missing,
            },
            {
              label: t("memoryTab.afterMergeLabel"),
              value:
                recall.mergedCount != null ? fmt(recall.mergedCount) : missing,
            },
            {
              label: t("memoryTab.tier1Label"),
              value:
                recall.tier1Count != null ? fmt(recall.tier1Count) : missing,
            },
            {
              label: t("memoryTab.tier2Label"),
              value:
                recall.tier2Count != null ? fmt(recall.tier2Count) : missing,
            },
            {
              label: t("memoryTab.selectedLabel"),
              value:
                recall.selectedCount != null
                  ? fmt(recall.selectedCount)
                  : missing,
            },
            {
              label: t("memoryTab.injectedTokensLabel"),
              value:
                recall.injectedTokens != null
                  ? fmt(recall.injectedTokens)
                  : missing,
            },
          ]}
        />
      </SectionCard>

      <SectionCard title={t("memoryTab.searchDetailsTitle")}>
        <MetaGrid
          rows={[
            {
              label: t("memoryTab.hybridSearchLabel"),
              value:
                recall.hybridSearchLatencyMs != null
                  ? t("memoryTab.latencyMs", {
                      ms: recall.hybridSearchLatencyMs,
                    })
                  : missing,
            },
            {
              label: t("memoryTab.sparseVectorsLabel"),
              value:
                recall.sparseVectorUsed != null
                  ? recall.sparseVectorUsed
                    ? t("memoryTab.sparseUsed")
                    : t("memoryTab.sparseDenseOnly")
                  : missing,
            },
          ]}
        />
      </SectionCard>

      {recall.queryContext != null && (
        <SectionCard
          title={t("memoryTab.queryContextTitle")}
          subtitle={t("memoryTab.queryContextSubtitle")}
          copyText={recall.queryContext}
          t={t}
        >
          <CodeBlock text={recall.queryContext} />
        </SectionCard>
      )}

      {recall.topCandidates.length > 0 && (
        <SectionCard
          title={t("memoryTab.topCandidatesTitle")}
          subtitle={t("memoryTab.topCandidatesSubtitle", {
            count: recall.topCandidates.length,
          })}
        >
          <div className="flex flex-col gap-2">
            {[...recall.topCandidates]
              .sort((a, b) => b.score - a.score)
              .map((c, i) => (
                <CandidateRow key={`${i}-${c.nodeId}`} candidate={c} t={t} />
              ))}
          </div>
        </SectionCard>
      )}

      {recall.injectedText != null && (
        <SectionCard
          title={t("memoryTab.injectedMemoryContextTitle")}
          copyText={recall.injectedText}
          t={t}
        >
          <CodeBlock text={recall.injectedText} />
        </SectionCard>
      )}

      {recall.degraded && recall.degradation != null && (
        <SectionCard title={t("memoryTab.degradationTitle")}>
          <MetaGrid
            rows={[
              {
                label: t("memoryTab.reasonLabel"),
                value: recall.degradation.reason ?? t("memoryTab.unknown"),
              },
              {
                label: t("memoryTab.semanticUnavailableLabel"),
                value: recall.degradation.semanticUnavailable
                  ? t("memoryTab.yes")
                  : t("memoryTab.no"),
              },
              ...(recall.degradation.fallbackSources?.length
                ? [
                    {
                      label: t("memoryTab.fallbackSourcesLabel"),
                      value: recall.degradation.fallbackSources.join(", "),
                    },
                  ]
                : []),
            ]}
          />
        </SectionCard>
      )}
    </div>
  );
}

function CandidateRow({
  candidate,
  t,
}: {
  candidate: MemoryCandidate;
  t: MemoryTranslate;
}): ReactNode {
  return (
    <div
      className="flex items-start justify-between gap-3 rounded-md px-3 py-2"
      style={{ background: "var(--surface-base)" }}
    >
      <div className="flex min-w-0 flex-col gap-0.5">
        <code
          className="truncate text-body-small-default"
          style={{ color: "var(--content-default)" }}
        >
          {candidate.nodeId}
        </code>
        {candidate.type != null && <TypeChip label={candidate.type} />}
      </div>
      <div className="flex shrink-0 flex-col items-end gap-0.5">
        <span
          className="text-body-medium-default"
          style={{ color: "var(--content-default)" }}
        >
          {fmtScore(candidate.score)}
        </span>
        <span
          className="text-label-small-default"
          style={{ color: "var(--content-tertiary)" }}
        >
          {t("memoryTab.candidateScores", {
            semantic: fmtScore(candidate.semanticSimilarity),
            recency: fmtScore(candidate.recencyBoost),
          })}
        </span>
      </div>
    </div>
  );
}

function DisclosureCard({
  title,
  subtitle,
  children,
}: {
  title: string;
  subtitle: string;
  children: ReactNode;
}): ReactNode {
  const [expanded, setExpanded] = useState(false);

  return (
    <Card>
      <div className="flex flex-col gap-3 p-4">
        <button
          type="button"
          className="flex w-full items-start justify-between gap-2 text-left"
          style={{
            background: "none",
            border: "none",
            cursor: "pointer",
            padding: 0,
          }}
          onClick={() => setExpanded((v) => !v)}
          aria-expanded={expanded}
        >
          <span className="flex flex-col gap-0.5">
            <span
              className="text-body-medium-default"
              style={{ color: "var(--content-default)" }}
            >
              {title}
            </span>
            <span
              className="text-body-small-lighter"
              style={{ color: "var(--content-tertiary)" }}
            >
              {subtitle}
            </span>
          </span>
          <span
            className="shrink-0"
            style={{ color: "var(--content-secondary)" }}
          >
            {expanded ? (
              <ChevronDown size={14} aria-hidden />
            ) : (
              <ChevronRight size={14} aria-hidden />
            )}
          </span>
        </button>
        {expanded && children}
      </div>
    </Card>
  );
}

/** Collapsible config card for the v3 selection details. */
function CountPill({
  label,
  dotColor,
}: {
  label: string;
  dotColor?: string;
}): ReactNode {
  return (
    <span
      className="flex items-center gap-1.5 rounded-full px-2.5 py-1 text-label-medium-default"
      style={{
        background: "var(--surface-overlay)",
        color: "var(--content-secondary)",
      }}
    >
      {dotColor != null && (
        <span
          className="shrink-0 rounded-full"
          style={{ width: 6, height: 6, background: dotColor }}
          aria-hidden
        />
      )}
      {label}
    </span>
  );
}

function MemoryV3Section({
  selection,
  t,
}: {
  selection: MemoryV3SelectionLog;
  t: MemoryTranslate;
}): ReactNode {
  const coreCount = selection.selections.filter((s) =>
    s.source.startsWith("core"),
  ).length;
  const carryCount = selection.selections.filter(
    (s) => s.source === "carry-forward",
  ).length;

  // `selection.live` reflects whether v3 is the assistant's CURRENT live memory
  // source, not per-turn history. Persisted `memory_v3_selections` rows can be
  // inspected on an assistant without v3 rows, but
  // older rows survive), where the selection was logged but never injected.
  const live = selection.live;

  return (
    <div className="flex flex-col gap-4 p-4">
      <ScopeBanner
        title={
          live
            ? t("memoryTab.v3LiveInjectionTitle")
            : t("memoryTab.v3LoggedSelectionTitle")
        }
        body={
          live
            ? t("memoryTab.v3LiveInjectionBody")
            : t("memoryTab.v3LoggedSelectionBody")
        }
      />

      <div className="flex flex-wrap gap-2">
        <CountPill label={t("memoryTab.turnPill", { turn: selection.turn })} />
        <CountPill
          label={t("memoryTab.selectedPill", {
            count: fmt(selection.selections.length),
          })}
        />
        <CountPill label={t("memoryTab.corePill", { count: fmt(coreCount) })} />
        <CountPill
          label={t("memoryTab.carriedPill", { count: fmt(carryCount) })}
        />
      </div>

      <SectionCard
        title={t("memoryTab.selectedPagesTitle", {
          count: fmt(selection.selections.length),
        })}
        subtitle={t("memoryTab.selectedPagesSubtitle")}
      >
        {selection.selections.length > 0 ? (
          <div className="flex flex-col gap-1">
            {selection.selections.map((row) => (
              <V3SelectionRow key={row.slug} row={row} t={t} />
            ))}
          </div>
        ) : (
          <span
            className="text-body-medium-lighter"
            style={{ color: "var(--content-secondary)" }}
          >
            {t("memoryTab.noPagesSelected")}
          </span>
        )}
      </SectionCard>

      <V3CandidatePoolCard pool={selection.pool ?? null} t={t} />

      {selection.injectedText !== "" && (
        <SectionCard
          title={
            live
              ? t("memoryTab.injectedMemoryContextTitle")
              : t("memoryTab.loggedMemorySelectionTitle")
          }
          subtitle={
            live ? undefined : t("memoryTab.loggedMemorySelectionSubtitle")
          }
          copyText={selection.injectedText}
          t={t}
        >
          <CodeBlock text={selection.injectedText} />
        </SectionCard>
      )}
    </div>
  );
}

/**
 * A page slug with its matched-section heading (`slug § Heading`); `dimmed`
 * renders both in the secondary tones for a candidate that was not chosen.
 */
function V3SlugCode({
  slug,
  sectionHeading,
  dimmed = false,
}: {
  slug: string;
  sectionHeading: string | null | undefined;
  dimmed?: boolean;
}): ReactNode {
  return (
    <code
      className="min-w-0 flex-1 truncate text-body-small-default"
      style={{
        color: dimmed ? "var(--content-secondary)" : "var(--content-default)",
      }}
    >
      {slug}
      {sectionHeading ? (
        <span
          style={{
            color: dimmed
              ? "var(--content-tertiary)"
              : "var(--content-secondary)",
          }}
        >
          {` § ${sectionHeading}`}
        </span>
      ) : null}
    </code>
  );
}

function V3SelectionRow({
  row,
  t,
}: {
  row: MemoryV3SelectionRow;
  t: MemoryTranslate;
}): ReactNode {
  return (
    <div
      className="flex items-center justify-between gap-3 rounded-md px-3 py-2"
      style={{ background: "var(--surface-base)" }}
    >
      <V3SlugCode slug={row.slug} sectionHeading={row.sectionHeading} />
      <div className="shrink-0">
        <TypeChip label={formatV3Source(row.source, t)} />
      </div>
    </div>
  );
}

/** Display label for a v3 selection lane (`source`). */
function formatV3Source(source: string, t: MemoryTranslate): string {
  switch (source) {
    case "l1+l2":
      return t("memoryTab.v3SourceL1L2");
    case "core+l2":
      return t("memoryTab.v3SourceCore");
    case "carry-forward":
      return t("memoryTab.v3SourceCarried");
    case "needle":
      return t("memoryTab.v3SourceNeedle");
    default:
      return source;
  }
}

/**
 * The selector's full candidate pool for the turn: every stable-prefix card
 * and finder line it saw, collapsed behind a summary of pool size and pages
 * selected. A turn logged before pools were persisted shows the empty state;
 * a turn whose selector never ran and that pooled nothing (the injection
 * gate hard-skipped it, or nothing was pooled) says so instead of listing
 * candidates it never judged. A pool the selector never ran over but that
 * still holds candidates is the disabled-selector passthrough: every
 * candidate went through as a selection, so the list renders under a summary
 * saying no selector judged it.
 */
function V3CandidatePoolCard({
  pool,
  t,
}: {
  pool: MemoryV3Pool | null;
  t: MemoryTranslate;
}): ReactNode {
  if (pool == null || (!pool.selectorRan && pool.candidates.length === 0)) {
    return (
      <SectionCard title={t("memoryTab.candidatePoolTitle")}>
        <span
          className="text-body-medium-lighter"
          style={{ color: "var(--content-secondary)" }}
        >
          {pool == null
            ? t("memoryTab.candidatePoolNoneBody")
            : t("memoryTab.candidatePoolSelectorNotRunBody")}
        </span>
      </SectionCard>
    );
  }

  return (
    <DisclosureCard
      title={t("memoryTab.candidatePoolTitle")}
      subtitle={
        pool.selectorRan
          ? t("memoryTab.candidatePoolSubtitle", {
              poolSize: pool.poolSize,
              selectedCount: pool.selectedCount,
            })
          : t("memoryTab.candidatePoolPassthroughSubtitle", {
              poolSize: pool.poolSize,
            })
      }
    >
      <div className="flex flex-col gap-1">
        {pool.candidates.map((candidate, i) => (
          <V3PoolCandidateRow
            key={`${i}-${candidate.slug}`}
            candidate={candidate}
            t={t}
          />
        ))}
      </div>
    </DisclosureCard>
  );
}

/** One pooled candidate. Chosen rows carry a marker dot and chip and read in
 *  the default text color; unchosen rows are dimmed. */
function V3PoolCandidateRow({
  candidate,
  t,
}: {
  candidate: MemoryV3PoolCandidate;
  t: MemoryTranslate;
}): ReactNode {
  return (
    <div
      className="flex items-center gap-2 rounded-md px-3 py-2"
      style={{ background: "var(--surface-base)" }}
    >
      <span
        className="shrink-0 rounded-full"
        style={{
          width: 8,
          height: 8,
          background: candidate.chosen
            ? "var(--system-positive-strong)"
            : "var(--content-disabled)",
        }}
        aria-hidden
      />
      <V3SlugCode
        slug={candidate.slug}
        sectionHeading={candidate.sectionHeading}
        dimmed={!candidate.chosen}
      />
      {candidate.chosen && (
        <TypeChip label={t("memoryTab.candidatePoolChosenChip")} />
      )}
      <TypeChip label={formatV3Source(candidate.lane, t)} />
    </div>
  );
}

function ScopeBanner({
  title,
  body,
}: {
  title: string;
  body: string;
}): ReactNode {
  return (
    <div
      className="rounded-lg px-4 py-3"
      style={{ background: "var(--surface-overlay)" }}
    >
      <p
        className="text-body-medium-default"
        style={{ color: "var(--content-default)" }}
      >
        {title}
      </p>
      <p
        className="mt-1 text-body-medium-lighter"
        style={{ color: "var(--content-secondary)" }}
      >
        {body}
      </p>
    </div>
  );
}

function SectionCard({
  title,
  subtitle,
  copyText,
  children,
  t,
}: {
  title: string;
  subtitle?: string;
  copyText?: string;
  children?: ReactNode;
  t?: MemoryTranslate;
}): ReactNode {
  return (
    <Card>
      <div className="flex flex-col gap-3 p-4">
        <div className="flex items-start justify-between gap-2">
          <div className="flex flex-col gap-0.5">
            <span
              className="text-body-medium-default"
              style={{ color: "var(--content-default)" }}
            >
              {title}
            </span>
            {subtitle != null && subtitle !== "" && (
              <span
                className="text-label-medium-default"
                style={{ color: "var(--content-tertiary)" }}
              >
                {subtitle}
              </span>
            )}
          </div>
          {copyText != null && t != null && (
            <CopyButton text={copyText} t={t} />
          )}
        </div>
        {children}
      </div>
    </Card>
  );
}

function MetaGrid({
  rows,
}: {
  rows: { label: string; value: string }[];
}): ReactNode {
  return (
    <div className="flex flex-col gap-2">
      {rows.map(({ label, value }) => (
        <div key={label} className="flex items-baseline justify-between gap-3">
          <span
            className="shrink-0 text-label-medium-default"
            style={{ color: "var(--content-secondary)" }}
          >
            {label}
          </span>
          <span
            className="text-right text-body-medium-lighter"
            style={{ color: "var(--content-default)" }}
          >
            {value}
          </span>
        </div>
      ))}
    </div>
  );
}

function CodeBlock({ text }: { text: string }): ReactNode {
  return (
    <pre
      className="overflow-x-auto rounded-md p-3 text-body-small-default"
      style={{
        background: "var(--surface-base)",
        color: "var(--content-default)",
        whiteSpace: "pre-wrap",
        wordBreak: "break-word",
      }}
    >
      {text}
    </pre>
  );
}

function TypeChip({ label }: { label: string }): ReactNode {
  return (
    <span
      className="rounded px-1.5 py-0.5 text-label-small-default"
      style={{
        background: "var(--surface-base)",
        color: "var(--content-secondary)",
      }}
    >
      {label}
    </span>
  );
}

function CopyButton({
  text,
  t,
}: {
  text: string;
  t: MemoryTranslate;
}): ReactNode {
  const { copy, copied } = useCopyToClipboard({
    errorMessage: t("memoryTab.copyErrorMessage"),
  });

  const handleCopy = () => copy(text);

  return (
    <button
      type="button"
      onClick={handleCopy}
      title={copied ? t("memoryTab.copyTitleCopied") : t("memoryTab.copyTitle")}
      aria-label={
        copied
          ? t("memoryTab.copyAriaLabelCopied")
          : t("memoryTab.copyAriaLabel")
      }
      className="flex shrink-0 items-center gap-1 rounded px-2 py-1 text-label-medium-default transition-colors"
      style={{
        background: "var(--surface-overlay)",
        color: copied
          ? "var(--system-positive-strong)"
          : "var(--content-secondary)",
        border: "none",
        cursor: "pointer",
      }}
    >
      <Copy size={12} aria-hidden />
      {copied ? t("memoryTab.copyButtonCopied") : t("memoryTab.copyButtonCopy")}
    </button>
  );
}

function NoDataState({ t }: { t: MemoryTranslate }): ReactNode {
  return (
    <div className="flex h-full flex-col items-center justify-center gap-2 p-8 text-center">
      <p
        className="text-body-medium-default"
        style={{ color: "var(--content-default)" }}
      >
        {t("memoryTab.noDataTitle")}
      </p>
      <p
        className="max-w-sm text-label-medium-default"
        style={{ color: "var(--content-secondary)" }}
      >
        {t("memoryTab.noDataBody")}
      </p>
    </div>
  );
}

function fmt(n: number): string {
  return new Intl.NumberFormat().format(n);
}

function fmtScore(n: number): string {
  return n.toFixed(3);
}

