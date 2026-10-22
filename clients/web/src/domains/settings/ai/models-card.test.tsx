/**
 * Call-site table behaviour: the alias dropdown offers gateway chat aliases,
 * the toggle writes the enabled flag, and a pin that disappeared from the
 * catalog renders as a degraded badge with the effective alias.
 *
 * The generated query module is stubbed so the card renders from fixtures and
 * the PATCH mutation records its variables instead of hitting the daemon.
 */

import { afterEach, describe, expect, mock, test } from "bun:test";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import {
  cleanup,
  fireEvent,
  render,
  screen,
} from "@testing-library/react";

const ASSISTANT_ID = "asst-test";

type CallSiteFixture = {
  id: string;
  displayName: string;
  description: string;
  domain: string;
  enabled: boolean;
  configuredModel: string | null;
  effectiveModel: string | null;
  degraded: boolean;
  reason: "call_site_alias_missing" | "catalog_empty" | null;
  model?: string;
  source?: string;
};

let callSiteData: {
  domains: { id: string; displayName: string }[];
  callSites: CallSiteFixture[];
  catalogAvailable: boolean;
};

const gatewayData = {
  models: [
    {
      alias: "main",
      label: "Main",
      supportsVision: false,
      supportsTools: true,
      mode: "chat" as const,
    },
    {
      alias: "fast",
      label: "Fast",
      supportsVision: false,
      supportsTools: true,
      mode: "chat" as const,
    },
    {
      alias: "embed",
      label: "Embeddings",
      supportsVision: false,
      supportsTools: false,
      mode: "embedding" as const,
    },
  ],
  source: "gateway" as const,
  fetchedAt: 1,
};

const mutateCalls: unknown[] = [];

mock.module("@/assistant/use-active-assistant-id", () => ({
  useActiveAssistantId: () => ASSISTANT_ID,
}));
mock.module("@/lib/sentry/capture-error", () => ({
  captureError: () => {},
}));
mock.module("@vellumai/design-library/components/toast", () => ({
  toast: { success: () => {}, error: () => {} },
}));
mock.module("@/generated/daemon/@tanstack/react-query.gen", () => ({
  configLlmCallsitesGetOptions: () => ({
    queryKey: ["call-sites-test"],
    queryFn: () => Promise.resolve(callSiteData),
    initialData: callSiteData,
  }),
  llmCatalogGetOptions: () => ({
    queryKey: ["llm-catalog-test"],
    queryFn: () => Promise.resolve(gatewayData),
    initialData: gatewayData,
  }),
  configLlmCallsitesGetSetQueryData: () => {},
  useConfigLlmCallsitesBySitePatchMutation: () => ({
    mutate: (variables: unknown) => {
      mutateCalls.push(variables);
    },
  }),
}));

const { ModelsCard } = await import("@/domains/settings/ai/models-card");

function renderCard() {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  return render(
    <QueryClientProvider client={queryClient}>
      <ModelsCard assistantId={ASSISTANT_ID} />
    </QueryClientProvider>,
  );
}

function openAliasDropdown(callSite: string): void {
  const trigger = screen.getByRole("combobox", {
    name: `Alias for ${callSite}`,
  });
  fireEvent.click(trigger);
}

function chooseOption(label: string): void {
  const option = Array.from(
    document.querySelectorAll<HTMLElement>('[role="option"]'),
  ).find((candidate) => candidate.textContent?.trim() === label);
  if (!option) {
    throw new Error(`expected option "${label}"`);
  }
  fireEvent.click(option);
}

describe("ModelsCard", () => {
  afterEach(() => {
    cleanup();
    mutateCalls.length = 0;
  });

  test("edits the alias through the call-site route", () => {
    callSiteData = {
      domains: [{ id: "chat", displayName: "Chat" }],
      catalogAvailable: true,
      callSites: [
        {
          id: "conversationTitle",
          displayName: "Conversation title",
          description: "Names a conversation",
          domain: "chat",
          enabled: true,
          configuredModel: "fast",
          effectiveModel: "fast",
          degraded: false,
          reason: null,
        },
      ],
    };
    renderCard();

    openAliasDropdown("Conversation title");
    const labels = Array.from(
      document.querySelectorAll<HTMLElement>('[role="option"]'),
    ).map((option) => option.textContent?.trim());
    expect(labels).toContain("Inherit (workspace default)");
    expect(labels).toContain("Main");
    expect(labels).not.toContain("Embeddings");

    chooseOption("Main");
    expect(mutateCalls).toEqual([
      {
        path: { assistant_id: ASSISTANT_ID, site: "conversationTitle" },
        body: { model: "main" },
      },
    ]);
  });

  test("toggling a call site off clears its alias in the same write", () => {
    callSiteData = {
      domains: [{ id: "chat", displayName: "Chat" }],
      catalogAvailable: true,
      callSites: [
        {
          id: "conversationTitle",
          displayName: "Conversation title",
          description: "Names a conversation",
          domain: "chat",
          enabled: true,
          configuredModel: "fast",
          effectiveModel: "fast",
          degraded: false,
          reason: null,
        },
      ],
    };
    renderCard();

    fireEvent.click(screen.getByLabelText("Enable Conversation title"));
    expect(mutateCalls).toEqual([
      {
        path: { assistant_id: ASSISTANT_ID, site: "conversationTitle" },
        body: { enabled: false, model: null },
      },
    ]);
  });

  test("shows a degraded badge with the effective alias", () => {
    callSiteData = {
      domains: [{ id: "chat", displayName: "Chat" }],
      catalogAvailable: true,
      callSites: [
        {
          id: "mainAgent",
          displayName: "Main agent",
          description: "The interactive turn",
          domain: "chat",
          enabled: true,
          configuredModel: "retired-alias",
          effectiveModel: "main",
          degraded: true,
          reason: "call_site_alias_missing",
        },
      ],
    };
    renderCard();

    expect(screen.getByText("Degraded, using main")).toBeTruthy();
    openAliasDropdown("Main agent");
    const labels = Array.from(
      document.querySelectorAll<HTMLElement>('[role="option"]'),
    ).map((option) => option.textContent?.trim());
    expect(labels).toContain("retired-alias (unavailable)");
  });
});
