import type { ReactNode } from "react";

/**
 * The dashboard's top row: three equal columns that collapse to one on a
 * narrow viewport. The second row (projects) is owned by the page.
 */
export function DashboardGrid({ children }: { children: ReactNode }) {
  return (
    <div className="grid min-h-0 flex-1 grid-cols-1 gap-3 lg:grid-cols-3">
      {children}
    </div>
  );
}
