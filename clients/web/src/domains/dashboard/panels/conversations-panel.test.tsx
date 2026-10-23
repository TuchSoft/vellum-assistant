import { describe, expect, mock, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";

import * as reactRouter from "react-router";

mock.module("react-router", () => ({
  ...reactRouter,
  useNavigate: () => () => {},
}));

mock.module("@/hooks/conversation-queries", () => ({
  useConversationListQuery: () => ({
    conversations: [],
    isLoading: false,
    hasData: true,
  }),
}));

mock.module("@/stores/conversation-store", () => ({
  useConversationStore: {
    use: {
      processingConversationIds: () => new Set<string>(),
      attentionConversationIds: () => new Set<string>(),
    },
  },
}));

const { ConversationsPanel } = await import("./conversations-panel");

describe("ConversationsPanel", () => {
  test("an empty tab states it instead of drawing nothing", () => {
    const html = renderToStaticMarkup(
      <ConversationsPanel assistantId="assistant-1" filter="active" />,
    );
    expect(html).toContain("No conversations are working right now.");
  });
});
