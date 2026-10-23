import type { Meta, StoryObj } from "@storybook/react-vite";

import { SystemPanel } from "./system-panel";

const meta: Meta<typeof SystemPanel> = {
  title: "Dashboard/SystemPanel",
  component: SystemPanel,
  decorators: [
    (Story) => (
      <div className="w-[420px] bg-[var(--surface-base)] p-4">
        <Story />
      </div>
    ),
  ],
};

export default meta;

type Story = StoryObj<typeof SystemPanel>;

/** The six section doors, Memory included. */
export const Default: Story = {};
