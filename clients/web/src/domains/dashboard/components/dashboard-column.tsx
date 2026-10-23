import type { ReactNode } from "react";

import { cn } from "@vellumai/design-library";

export interface DashboardColumnProps {
  title: string;
  children: ReactNode;
  /**
   * Rendered behind the column's content and clipped by its bottom edge, for
   * the assistant avatar the central column carries.
   */
  decoration?: ReactNode;
  className?: string;
}

/**
 * One of the dashboard's top-row columns: a glassy tile with a small caps
 * title, the column's tab strip, and its panels. The content layer sits above
 * `decoration` so the avatar can be clipped by the tile without covering the
 * rows.
 */
export function DashboardColumn({
  title,
  children,
  decoration,
  className,
}: DashboardColumnProps) {
  return (
    <section
      className={cn(
        "relative flex min-h-0 flex-col overflow-hidden rounded-3xl border border-[var(--border-base)] bg-[var(--card-feature-bg,var(--card-bg))] p-4 backdrop-blur-[32px]",
        className,
      )}
    >
      <h2 className="text-label-small-default uppercase tracking-[0.14em] text-[var(--content-tertiary)]">
        {title}
      </h2>
      <div className="relative z-[1] mt-3 flex min-h-0 flex-1 flex-col">
        {children}
      </div>
      {decoration}
    </section>
  );
}
