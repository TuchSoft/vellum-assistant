import { beforeEach, expect, mock, test } from "bun:test";

// The synchronous entry-name fold reads connections through the legacy
// drizzle handle, so this map backs that path while provider_connections
// rows back the async binding lookup.
const connectionRows = new Map<string, { name: string; provider: string }>([
  ["anthropic-personal", { name: "anthropic-personal", provider: "anthropic" }],
  ["local-ollama", { name: "local-ollama", provider: "ollama" }],
]);
mock.module("../../persistence/db-connection.js", () => ({
  getDb: () => ({}),
}));
mock.module("../../providers/inference/connections.js", () => ({
  getConnection: (_db: unknown, name: string) =>
    connectionRows.get(name) ?? null,
}));

import { describePg } from "../../__tests__/pg-test-db.js";
import { requireMainDb } from "../../persistence/db-facade.js";
import { VELLUM_MANAGED_CONNECTION_NAME } from "../../providers/vellum-model-routing.js";
import { completeCustomProfile } from "../profile-materialization.js";
import { LLMConfigBase, ProfileEntry } from "../schemas/llm.js";

async function seedConnection(name: string, provider: string): Promise<void> {
  const now = Date.now();
  await requireMainDb().run(
    `INSERT INTO provider_connections (name, provider, auth, created_at, updated_at)
     VALUES (?, ?, 'api_key', ?, ?)
     ON CONFLICT (name) DO UPDATE SET provider = excluded.provider`,
    [name, provider, now, now],
  );
}

beforeEach(async () => {
  await requireMainDb().run("DELETE FROM provider_connections");
  await seedConnection("anthropic-personal", "anthropic");
  await seedConnection("local-ollama", "ollama");
});

const fullDefault = LLMConfigBase.parse({
  provider: "anthropic",
  provider_connection: "anthropic-personal",
  model: "claude-opus-4-8",
  maxTokens: 64000,
  effort: "max",
  speed: "standard",
  verbosity: "medium",
  temperature: null,
  topP: null,
  thinking: { enabled: true, streamThinking: true },
  contextWindow: {
    enabled: true,
    maxInputTokens: 200000,
    overflowRecovery: { enabled: true, maxAttempts: 3 },
  },
});

describePg("completeCustomProfile", () => {
  test("clamps a filled maxTokens to the model's catalog output cap", async () => {
    const completed = await completeCustomProfile(fullDefault, {
      provider: "ollama",
      model: "llama3.2",
    });
    expect(completed.maxTokens).toBe(4096);
  });

  test("clamps a filled maxTokens for an entry-name provider via its row's kind", async () => {
    const completed = await completeCustomProfile(fullDefault, {
      provider: "local-ollama",
      model: "llama3.2",
    });
    expect(completed.maxTokens).toBe(4096);
  });

  test("never clamps an explicit maxTokens", async () => {
    const completed = await completeCustomProfile(fullDefault, {
      provider: "ollama",
      model: "llama3.2",
      maxTokens: 64000,
    });
    expect(completed.maxTokens).toBe(64000);
  });

  test("inherits omitted scalar fields from the default", async () => {
    const completed = await completeCustomProfile(fullDefault, {
      model: "claude-fable-5",
    });
    expect(completed.model).toBe("claude-fable-5");
    // The default's explicit binding is inherited IN the provider value
    // (the entries-model representation), never as a stamped binding.
    expect(completed.provider).toBe("anthropic-personal");
    expect(completed.provider_connection).toBeUndefined();
    expect(completed.maxTokens).toBe(64000);
    expect(completed.effort).toBe("max");
    expect(completed.speed).toBe("standard");
    expect(completed.verbosity).toBe("medium");
  });

  test("inherits non-null default sampling; never inherits logitBias or null sampling", async () => {
    const dflt = LLMConfigBase.parse({
      ...fullDefault,
      temperature: 0.7,
      topP: 0.9,
      logitBias: "suppress-cjk",
    });
    const completed = await completeCustomProfile(dflt, {
      model: "claude-fable-5",
    });
    expect(completed.temperature).toBe(0.7);
    expect(completed.topP).toBe(0.9);
    // The resolver deletes non-profile logitBias post-merge, unlike sampling.
    expect(completed.logitBias).toBeUndefined();
    const own = await completeCustomProfile(dflt, { temperature: 0.2 });
    expect(own.temperature).toBe(0.2);
    expect(own.topP).toBe(0.9);
    const nullDefaults = await completeCustomProfile(fullDefault, {});
    expect(nullDefaults.temperature).toBeUndefined();
    expect(nullDefaults.topP).toBeUndefined();
    // Explicit null differs from undefined: it clears the default's value.
    const explicitNull = await completeCustomProfile(dflt, {
      temperature: null,
    });
    expect(explicitNull.temperature).toBeNull();
  });

  test("merges partial nested thinking leaf-by-leaf", async () => {
    const completed = await completeCustomProfile(fullDefault, {
      thinking: { enabled: false },
    });
    expect(completed.thinking).toEqual({
      enabled: false,
      streamThinking: true,
    });
  });

  test("merges nested contextWindow leaves including overflowRecovery", async () => {
    const completed = await completeCustomProfile(fullDefault, {
      contextWindow: { overflowRecovery: { maxAttempts: 5 } },
    });
    expect(completed.contextWindow?.maxInputTokens).toBe(200000);
    expect(completed.contextWindow?.overflowRecovery?.maxAttempts).toBe(5);
    expect(completed.contextWindow?.overflowRecovery?.enabled).toBe(true);
  });

  test("inherits the default's binding as the entry name when the provider serves the model", async () => {
    const completed = await completeCustomProfile(fullDefault, {
      model: "claude-fable-5",
    });
    expect(completed.provider).toBe("anthropic-personal");
    expect(completed.provider_connection).toBeUndefined();
  });

  test("stamps the catalog owner for a model the default provider does not serve, and drops the default's connection", async () => {
    const completed = await completeCustomProfile(fullDefault, {
      model: "gpt-5.5",
    });
    expect(completed.provider).toBe("openai");
    // Provider-specific connections don't cross providers; dispatch
    // auto-resolves an absent connection.
    expect(completed.provider_connection).toBeUndefined();
  });

  test("routing-identity providers never receive a connection stamp", async () => {
    for (const provider of ["vellum", "chatgpt"] as const) {
      const completed = await completeCustomProfile(fullDefault, {
        provider,
        model: "claude-fable-5",
      });
      expect(completed.provider).toBe(provider);
      expect(completed.provider_connection).toBeUndefined();
    }
  });

  test("keeps an explicit provider_connection even when the provider is implied", async () => {
    const completed = await completeCustomProfile(fullDefault, {
      model: "gpt-5.5",
      provider_connection: "my-openai",
    });
    expect(completed.provider).toBe("openai");
    expect(completed.provider_connection).toBe("my-openai");
  });

  test("does not inherit the default's connection onto an explicit different provider", async () => {
    const completed = await completeCustomProfile(fullDefault, {
      provider: "openai",
      model: "gpt-5.4",
    });
    expect(completed.provider).toBe("openai");
    expect(completed.provider_connection).toBeUndefined();
  });

  test("a managed default's binding becomes the routing identity, never a stamped field", async () => {
    const managedDefault = LLMConfigBase.parse({
      ...fullDefault,
      provider_connection: VELLUM_MANAGED_CONNECTION_NAME,
    });
    const implied = await completeCustomProfile(managedDefault, {
      model: "gpt-5.5",
    });
    expect(implied.provider).toBe("vellum");
    expect(implied.provider_connection).toBeUndefined();

    const explicit = await completeCustomProfile(managedDefault, {
      provider: "openai",
      model: "gpt-5.4",
    });
    expect(explicit.provider).toBe("vellum");
    expect(explicit.provider_connection).toBeUndefined();
  });

  test("inherits the binding as the entry name even for a model unknown to the catalog", async () => {
    const completed = await completeCustomProfile(fullDefault, {
      model: "totally-custom-model",
    });
    expect(completed.provider).toBe("anthropic-personal");
    expect(completed.provider_connection).toBeUndefined();
  });

  test("a dangling default binding passes through as the legacy field", async () => {
    const dangling = LLMConfigBase.parse({
      ...fullDefault,
      provider_connection: "deleted-row",
    });
    const completed = await completeCustomProfile(dangling, {
      model: "claude-fable-5",
    });
    // Folding an unverifiable binding would hide it from the collapse
    // migration's dangling recovery; the legacy field keeps it visible.
    expect(completed.provider).toBe("anthropic");
    expect(completed.provider_connection).toBe("deleted-row");
  });

  test("a kind-disagreeing default binding passes through as the legacy field", async () => {
    connectionRows.set("mislabeled", {
      name: "mislabeled",
      provider: "openai",
    });
    await seedConnection("mislabeled", "openai");
    try {
      const mismatched = LLMConfigBase.parse({
        ...fullDefault,
        provider_connection: "mislabeled",
      });
      const completed = await completeCustomProfile(mismatched, {
        model: "claude-fable-5",
      });
      expect(completed.provider).toBe("anthropic");
      expect(completed.provider_connection).toBe("mislabeled");
    } finally {
      connectionRows.delete("mislabeled");
      await requireMainDb().run(
        "DELETE FROM provider_connections WHERE name = ?",
        ["mislabeled"],
      );
    }
  });

  test("a managed default binding is not inherited when the identity cannot serve the model", async () => {
    const managedDefault = LLMConfigBase.parse({
      ...fullDefault,
      provider_connection: VELLUM_MANAGED_CONNECTION_NAME,
    });
    const completed = await completeCustomProfile(managedDefault, {
      model: "totally-custom-model",
    });
    // Dispatch auto-resolves by vendor instead of pinning an unservable
    // managed route.
    expect(completed.provider).toBe("anthropic");
    expect(completed.provider_connection).toBeUndefined();
  });

  test("passes mix profiles through untouched", async () => {
    const mix: ProfileEntry = {
      label: "A/B",
      mix: [
        { profile: "a", weight: 1 },
        { profile: "b", weight: 1 },
      ],
    };
    expect(await completeCustomProfile(fullDefault, mix)).toBe(mix);
  });

  test("passes managed profiles through untouched", async () => {
    const managed: ProfileEntry = { source: "managed", topP: 0.9 };
    expect(await completeCustomProfile(fullDefault, managed)).toBe(managed);
  });

  test("preserves metadata fields", async () => {
    const completed = await completeCustomProfile(fullDefault, {
      source: "user",
      label: "Fast drafts",
      description: "cheap and quick",
      status: "disabled",
      model: "claude-haiku-4-5-20251001",
    });
    expect(completed.source).toBe("user");
    expect(completed.label).toBe("Fast drafts");
    expect(completed.description).toBe("cheap and quick");
    expect(completed.status).toBe("disabled");
  });

  test("is idempotent", async () => {
    const partials: ProfileEntry[] = [
      {},
      { model: "gpt-5.5" },
      { temperature: 0.3 },
      { thinking: { enabled: false }, maxTokens: 1234 },
    ];
    for (const partial of partials) {
      const once = await completeCustomProfile(fullDefault, partial);
      const twice = await completeCustomProfile(fullDefault, once);
      expect(twice).toEqual(once);
    }
  });

  test("completed entries still parse as ProfileEntry", async () => {
    const partials: ProfileEntry[] = [
      {},
      { model: "gpt-5.5" },
      { temperature: 0.3, label: "t" },
      { thinking: { enabled: false } },
    ];
    for (const partial of partials) {
      const completed = await completeCustomProfile(fullDefault, partial);
      expect(() => ProfileEntry.parse(completed)).not.toThrow();
    }
  });

  test("does not alias the default's nested objects", async () => {
    const completed = await completeCustomProfile(fullDefault, {});
    expect(completed.thinking).toEqual(fullDefault.thinking);
    expect(completed.thinking).not.toBe(fullDefault.thinking);
    expect(completed.contextWindow).not.toBe(fullDefault.contextWindow);
  });
});
