import * as RadixTabs from "@radix-ui/react-tabs";
import { type ComponentProps } from "react";

import { cn } from "../utils/cn";

// ---------------------------------------------------------------------------
// Root
// ---------------------------------------------------------------------------

export type TabsRootProps = ComponentProps<typeof RadixTabs.Root>;

function TabsRoot({ className, ref, ...rest }: TabsRootProps) {
  return (
    <RadixTabs.Root
      ref={ref}
      data-slot="tabs"
      className={className}
      {...rest}
    />
  );
}

// ---------------------------------------------------------------------------
// List
// ---------------------------------------------------------------------------

export type TabsPlacement = "top" | "bottom";

/**
 * The row's visual treatment. `underline` is the ruled row with an active
 * indicator on the edge; `pills` is a borderless cluster of rounded chips for
 * dense tab strips inside cards.
 */
export type TabsVariant = "underline" | "pills";

export interface TabsListProps extends ComponentProps<typeof RadixTabs.List> {
  /**
   * The edge the row sits on. `bottom` moves the list's rule and every
   * trigger's active indicator to the row's top edge, for a row mounted under
   * its panel. The consumer owns the DOM order. Ignored by `pills`.
   */
  placement?: TabsPlacement;
  /**
   * `underline` (default) draws the row's rule and the active indicator.
   * `pills` drops both for a rounded chip row. Pair it with the same variant
   * on every trigger.
   */
  variant?: TabsVariant;
}

function TabsList({
  className,
  placement = "top",
  variant = "underline",
  ref,
  ...rest
}: TabsListProps) {
  return (
    <RadixTabs.List
      ref={ref}
      data-slot="tabs-list"
      data-placement={placement}
      data-variant={variant}
      className={cn(
        "group/tabs-list flex items-center",
        variant === "pills"
          ? "gap-1"
          : cn(
              placement === "bottom" ? "border-t" : "border-b",
              "border-[var(--border-base)]",
            ),
        className,
      )}
      {...rest}
    />
  );
}

// ---------------------------------------------------------------------------
// Trigger
// ---------------------------------------------------------------------------

export interface TabsTriggerProps
  extends ComponentProps<typeof RadixTabs.Trigger> {
  /** Must match the enclosing {@link TabsList}'s variant. */
  variant?: TabsVariant;
}

function TabsTrigger({
  className,
  variant = "underline",
  ref,
  ...rest
}: TabsTriggerProps) {
  return (
    <RadixTabs.Trigger
      ref={ref}
      data-slot="tabs-trigger"
      className={cn(
        "inline-flex cursor-pointer items-center gap-1.5 whitespace-nowrap text-body-medium-default outline-none keyboard-focus:ring-2 keyboard-focus:ring-[var(--ring)] keyboard-focus:ring-offset-0",
        variant === "pills"
          ? [
              "rounded-full px-3 py-1.5 text-[var(--content-tertiary)] transition-colors",
              "hover:bg-[var(--surface-hover)] hover:text-[var(--content-default)]",
              "data-[state=active]:bg-[var(--surface-active)] data-[state=active]:text-[var(--content-default)]",
            ]
          : [
              "relative -mb-px border-b-2 border-transparent bg-transparent px-2.5 py-[7px]",
              // A bottom-placed row draws its indicator on the top edge, overlapping the list's rule there.
              "group-data-[placement=bottom]/tabs-list:mb-0 group-data-[placement=bottom]/tabs-list:-mt-px",
              "group-data-[placement=bottom]/tabs-list:border-b-0 group-data-[placement=bottom]/tabs-list:border-t-2",
              "text-[var(--content-tertiary)] transition-colors",
              "hover:bg-[var(--surface-hover)] hover:text-[var(--content-default)]",
              "data-[state=active]:border-[var(--primary-base)] data-[state=active]:text-[var(--content-default)]",
              "data-[state=active]:hover:bg-transparent",
            ],
        "disabled:cursor-not-allowed disabled:text-[var(--content-disabled)]",
        "disabled:hover:bg-transparent disabled:hover:text-[var(--content-disabled)]",
        className,
      )}
      {...rest}
    />
  );
}

// ---------------------------------------------------------------------------
// Panel
// ---------------------------------------------------------------------------

export type TabsPanelProps = ComponentProps<typeof RadixTabs.Content>;

function TabsPanel({ className, ref, ...rest }: TabsPanelProps) {
  return (
    <RadixTabs.Content
      ref={ref}
      data-slot="tabs-panel"
      className={cn(
        "outline-none keyboard-focus:ring-2 keyboard-focus:ring-[var(--ring)] keyboard-focus:ring-offset-0",
        className,
      )}
      {...rest}
    />
  );
}

// ---------------------------------------------------------------------------
// Compound export
// ---------------------------------------------------------------------------

const Tabs = {
  Root: TabsRoot,
  List: TabsList,
  Trigger: TabsTrigger,
  Panel: TabsPanel,
} as const;

export { Tabs, TabsRoot, TabsList, TabsTrigger, TabsPanel };
