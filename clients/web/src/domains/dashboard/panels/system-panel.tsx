import {
  Brain,
  FolderOpen,
  LayoutGrid,
  Radio,
  Users,
  Zap,
  type LucideIcon,
} from "lucide-react";
import { Link } from "react-router";

import {
  buildIdentitySections,
  type IdentitySection,
} from "@/utils/identity-sections";

/** The sections the System tab carries, in the order the dashboard shows. */
const SECTION_KEYS = [
  "superpowers",
  "library",
  "workspace",
  "contacts",
  "channels",
  "memory",
] as const;

const SECTION_ICONS: Record<string, LucideIcon> = {
  superpowers: Zap,
  library: LayoutGrid,
  workspace: FolderOpen,
  contacts: Users,
  channels: Radio,
  memory: Brain,
};

/**
 * The System tab's content: the six section cards that used to sit in the
 * overview's bottom strip, each a door to its page. Memory is one of them,
 * exactly as it was before it was retired.
 */
export function SystemPanel() {
  const byKey = new Map(
    buildIdentitySections().map((section) => [section.key, section]),
  );
  const sections = SECTION_KEYS.map((key) => byKey.get(key)).filter(
    (section): section is IdentitySection => section !== undefined,
  );

  return (
    <div className="grid grid-cols-2 gap-2">
      {sections.map((section) => {
        const Icon = SECTION_ICONS[section.key] ?? LayoutGrid;
        return (
          <Link
            key={section.key}
            to={section.to}
            className="group flex flex-col gap-1 rounded-2xl border border-[var(--border-base)] bg-[var(--card-bg,var(--surface-lift))] p-3 transition-colors hover:bg-[var(--card-hover,var(--surface-hover))]"
          >
            <span className="flex items-center gap-2">
              <Icon
                className="h-4 w-4 text-[var(--content-secondary)]"
                aria-hidden="true"
              />
              <span className="truncate text-body-small-emphasised text-[var(--content-default)]">
                {section.label}
              </span>
            </span>
            <span className="line-clamp-2 text-body-small-lighter text-[var(--content-tertiary)]">
              {section.description}
            </span>
          </Link>
        );
      })}
    </div>
  );
}
