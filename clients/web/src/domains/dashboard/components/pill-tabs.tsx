import {
  Tabs,
  type TabsListProps,
  type TabsTriggerProps,
} from "@vellumai/design-library";

/**
 * The dashboard's tab strip. The design system's `pills` variant has to be
 * named on the list and on every trigger, so this binds it once and every
 * strip in the page shares the same chip treatment.
 */
function PillTabsList(props: TabsListProps) {
  return <Tabs.List {...props} variant="pills" />;
}

function PillTabsTrigger(props: TabsTriggerProps) {
  return <Tabs.Trigger {...props} variant="pills" />;
}

export const PillTabs = {
  Root: Tabs.Root,
  List: PillTabsList,
  Trigger: PillTabsTrigger,
  Panel: Tabs.Panel,
} as const;
