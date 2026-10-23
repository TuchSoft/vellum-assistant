import type { Meta, StoryObj } from "@storybook/react-vite";

import { DashboardColumn } from "./dashboard-column";
import { PillTabs } from "./pill-tabs";

const meta: Meta<typeof DashboardColumn> = {
  title: "Dashboard/DashboardColumn",
  component: DashboardColumn,
  decorators: [
    (Story) => (
      <div className="h-[420px] w-[360px] bg-[var(--surface-base)] p-4">
        <Story />
      </div>
    ),
  ],
};

export default meta;

type Story = StoryObj<typeof DashboardColumn>;

/** The glassy tile with a pills strip and an empty panel. */
export const WithPills: Story = {
  args: {
    title: "Conversations",
    children: (
      <PillTabs.Root
        defaultValue="active"
        className="flex min-h-0 flex-1 flex-col"
      >
        <PillTabs.List>
          <PillTabs.Trigger value="active">Active</PillTabs.Trigger>
          <PillTabs.Trigger value="recent">Recent</PillTabs.Trigger>
          <PillTabs.Trigger value="unread">Unread</PillTabs.Trigger>
        </PillTabs.List>
        <PillTabs.Panel
          value="active"
          className="mt-3 text-body-small-lighter text-[var(--content-tertiary)]"
        >
          No conversations are working right now.
        </PillTabs.Panel>
      </PillTabs.Root>
    ),
  },
};
