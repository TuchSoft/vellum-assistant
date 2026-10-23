import type { Meta, StoryObj } from "@storybook/react-vite";

import { RunPanel } from "./run-panel";

const meta: Meta<typeof RunPanel> = {
  title: "Dashboard/RunPanel",
  component: RunPanel,
  decorators: [
    (Story) => (
      <div className="w-[420px] bg-[var(--surface-base)] p-4">
        <Story />
      </div>
    ),
  ],
};

export default meta;

type Story = StoryObj<typeof RunPanel>;

/** The long-runs tab before its backend exists. */
export const Default: Story = {};
