import { beforeEach, describe, expect, test } from "bun:test";

import { ACTOR_PRINCIPALS } from "../runtime/auth/route-policy.js";
import { RouteError } from "../runtime/routes/errors.js";
import { ROUTES } from "../runtime/routes/telemetry-routes.js";
import type { RouteHandlerArgs } from "../runtime/routes/types.js";
import {
  pendingOutboxPayloads,
  resetOutboxTable,
  setShareAnalytics,
  setShareDiagnostics,
} from "../telemetry/__tests__/outbox-test-harness.js";
import type { OnboardingResearchTelemetryEvent } from "../telemetry/types.js";

function pendingPayloads(): Promise<OnboardingResearchTelemetryEvent[]> {
  return pendingOutboxPayloads<OnboardingResearchTelemetryEvent>(
    "onboarding_research",
  );
}

const route = ROUTES.find((r) => r.operationId === "telemetry_ingest");

function call(body: unknown) {
  if (!route) {
    throw new Error("route not found");
  }
  return route.handler({ body } as RouteHandlerArgs);
}

/** Well-formed onboarding_research `fields` (base fields stamped by the daemon). */
const VALID_FIELDS = {
  conversation_id: "conv-xyz",
  status: "done",
  self_reported_occupation: "engineer",
  claims: [{ claim: "Senior engineer", confidence: "confident", sources: [] }],
  claim_count: 1,
  claims_confident: 1,
  claims_maybe: 0,
  claims_guessing: 0,
  suggestions: [
    { suggestion: "I'll find 3 papers", prompt: "Find me 3 papers" },
  ],
  suggestion_count: 1,
  plugins: ["marketing-expert"],
  installed_plugins: ["marketing-expert", "web-research"],
};

const VALID_BODY = {
  type: "onboarding_research",
  fields: VALID_FIELDS,
};

describe("telemetry-routes: ingest", () => {
  beforeEach(async () => {
    setShareAnalytics(true);
    setShareDiagnostics(true);
    await resetOutboxTable();
  });

  test("route policy matches the other client-facing telemetry routes", () => {
    expect(route).toBeDefined();
    expect(route?.endpoint).toBe("telemetry/ingest");
    expect(route?.method).toBe("POST");
    expect(route?.policy?.allowedPrincipalTypes).toEqual(ACTOR_PRINCIPALS);
    expect(route?.policy?.requiredScopes).toEqual(["settings.write"]);
  });

  test("valid body is persisted to the outbox as a wire event", async () => {
    const result = await call(VALID_BODY);
    expect(result).toEqual({ id: expect.any(String) });

    const payloads = await pendingPayloads();
    expect(payloads.length).toBe(1);
    expect(payloads[0]).toMatchObject({
      type: "onboarding_research",
      conversation_id: "conv-xyz",
      status: "done",
      claim_count: 1,
      claims_confident: 1,
      suggestion_count: 1,
      plugins: ["marketing-expert"],
      installed_plugins: ["marketing-expert", "web-research"],
    });
    // Base fields are stamped by the daemon, not the client.
    expect(payloads[0]?.daemon_event_id).toEqual(expect.any(String));
    expect(payloads[0]?.recorded_at).toEqual(expect.any(Number));
    expect(payloads[0]?.assistant_version).toEqual(expect.any(String));
  });

  test("stamps a fresh daemon_event_id by default", async () => {
    await call(VALID_BODY);
    // No override → the collapse key falls back to the row id (a uuid), not the
    // conversation-scoped key.
    expect((await pendingPayloads())[0]?.daemon_event_id).not.toBe(
      "onboarding_research:conv-xyz",
    );
  });

  test("honors a client-supplied daemon_event_id collapse key", async () => {
    await call({
      ...VALID_BODY,
      daemon_event_id: "onboarding_research:conv-xyz",
    });
    expect((await pendingPayloads())[0]?.daemon_event_id).toBe(
      "onboarding_research:conv-xyz",
    );
  });

  test("returns skipped and persists nothing under the analytics opt-out", async () => {
    setShareAnalytics(false);
    expect(await call(VALID_BODY)).toEqual({ skipped: true });
    expect((await pendingPayloads()).length).toBe(0);
  });

  test("persists regardless of the diagnostics opt-out (rides analytics only)", async () => {
    setShareDiagnostics(false, "2000-01-01");
    expect(await call(VALID_BODY)).toEqual({ id: expect.any(String) });
    expect((await pendingPayloads()).length).toBe(1);
  });

  test("rejects a non-outbox (watermark) or unknown type", async () => {
    // `turn` is a real wire type but watermark-flushed, not outbox-backed, so it
    // has no ingest variant and a client can't inject it.
    await expect(call({ type: "turn", fields: {} })).rejects.toThrow(
      RouteError,
    );
    // An unknown type is rejected the same way.
    await expect(call({ type: "not_a_type", fields: {} })).rejects.toThrow(
      RouteError,
    );
    expect((await pendingPayloads()).length).toBe(0);
  });

  test("accepts any outbox-backed type, e.g. config_setting", async () => {
    const result = await call({
      type: "config_setting",
      fields: { config_key: "voice.provider", config_value: "elevenlabs" },
    });
    expect(result).toEqual({ id: expect.any(String) });

    const payloads = await pendingOutboxPayloads<{ config_key: string }>(
      "config_setting",
    );
    expect(payloads.length).toBe(1);
    expect(payloads[0]).toMatchObject({
      type: "config_setting",
      config_key: "voice.provider",
      config_value: "elevenlabs",
    });
  });

  test("rejects malformed fields (missing or mistyped) without persisting", async () => {
    // Missing the required derived counts.
    const {
      claim_count: _c,
      suggestion_count: _s,
      ...missingCounts
    } = VALID_FIELDS;
    await expect(
      call({ type: "onboarding_research", fields: missingCounts }),
    ).rejects.toThrow(RouteError);

    // Wrong type for a numeric field.
    await expect(
      call({
        type: "onboarding_research",
        fields: { ...VALID_FIELDS, claim_count: "one" },
      }),
    ).rejects.toThrow(RouteError);

    expect((await pendingPayloads()).length).toBe(0);
  });

  test("rejects a structurally invalid request body", async () => {
    await expect(call({ type: "onboarding_research" })).rejects.toThrow(
      RouteError,
    );
    await expect(call({ fields: VALID_FIELDS })).rejects.toThrow(RouteError);
    expect((await pendingPayloads()).length).toBe(0);
  });

  test("strips unknown fields keys (typed schema, not a passthrough record)", async () => {
    await call({
      type: "onboarding_research",
      fields: { ...VALID_FIELDS, bogus_extra: "nope" },
    });
    const payloads = await pendingPayloads();
    expect(payloads.length).toBe(1);
    expect(payloads[0]).not.toHaveProperty("bogus_extra");
  });
});
