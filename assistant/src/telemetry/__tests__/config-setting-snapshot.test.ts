import { beforeEach, describe, expect, test } from "bun:test";

import type { AssistantConfig } from "../../config/schema.js";
import {
  recordConfigSettingSnapshot,
  resetConfigSettingSnapshotForTesting,
} from "../config-setting-snapshot.js";
import {
  pendingOutboxPayloads,
  resetOutboxTable,
  setShareAnalytics,
} from "./outbox-test-harness.js";

function makeConfig(memoryEnabled: boolean, v3Live = false): AssistantConfig {
  return {
    memory: {
      enabled: memoryEnabled,
      v3: { live: v3Live },
    },
  } as AssistantConfig;
}

async function recordedPairs(): Promise<Array<[string, string]>> {
  const payloads = await pendingOutboxPayloads<{
    config_key: string;
    config_value: string;
  }>("config_setting");
  return payloads.map((event) => [event.config_key, event.config_value]);
}

describe("config-setting-snapshot", () => {
  beforeEach(async () => {
    setShareAnalytics(true);
    await resetOutboxTable();
    resetConfigSettingSnapshotForTesting();
  });

  test("records every tracked setting on the first snapshot", async () => {
    await recordConfigSettingSnapshot(makeConfig(true, false));

    expect((await recordedPairs()).sort()).toEqual([
      ["memory.enabled", "true"],
      ["memory.v3.live", "false"],
    ]);
  });

  test("repeated snapshots with unchanged values record nothing new", async () => {
    await recordConfigSettingSnapshot(makeConfig(true, false));
    await recordConfigSettingSnapshot(makeConfig(true, false));
    await recordConfigSettingSnapshot(makeConfig(true, false));

    expect(await recordedPairs()).toHaveLength(2);
  });

  test("a changed value records only the changed key", async () => {
    await recordConfigSettingSnapshot(makeConfig(true, false));
    await resetOutboxTable();

    await recordConfigSettingSnapshot(makeConfig(true, true));

    expect(await recordedPairs()).toEqual([["memory.v3.live", "true"]]);
  });

  test("memory.enabled is tracked and its flip is captured", async () => {
    await recordConfigSettingSnapshot(makeConfig(true, false));
    await resetOutboxTable();

    await recordConfigSettingSnapshot(makeConfig(false, false));

    expect(await recordedPairs()).toEqual([["memory.enabled", "false"]]);
  });

  test("unknown consent skips entirely — no rows, no memo", async () => {
    setShareAnalytics("unknown");
    await recordConfigSettingSnapshot(makeConfig(true, false));

    // A snapshot is re-derivable state (unlike outbox events), so nothing is
    // recorded while consent is unresolved...
    expect(await recordedPairs()).toHaveLength(0);

    // ...and nothing was memoized: once consent resolves, the next snapshot
    // records the complete current set.
    setShareAnalytics(true);
    await recordConfigSettingSnapshot(makeConfig(true, false));
    expect((await recordedPairs()).sort()).toEqual([
      ["memory.enabled", "true"],
      ["memory.v3.live", "false"],
    ]);
  });

  test("consent off drops the snapshot without poisoning the memo", async () => {
    setShareAnalytics(false);
    await recordConfigSettingSnapshot(makeConfig(true, false));
    expect(await recordedPairs()).toHaveLength(0);

    // A later opted-in snapshot records the full set — the opted-out attempt
    // must not have memoized the values (mirrors the reporter's flush retry
    // once consent resolves).
    setShareAnalytics(true);
    await recordConfigSettingSnapshot(makeConfig(true, false));
    expect(await recordedPairs()).toHaveLength(2);
  });

  test("re-opt-in after an opt-out re-records the full snapshot", async () => {
    // Recorded while opted in.
    await recordConfigSettingSnapshot(makeConfig(true, false));
    expect(await recordedPairs()).toHaveLength(2);
    await resetOutboxTable();

    // Opt out: the reporter's opt-out flush discards any pending rows, so the
    // memo must be cleared here too.
    setShareAnalytics(false);
    await recordConfigSettingSnapshot(makeConfig(true, false));
    expect(await recordedPairs()).toHaveLength(0);

    // Re-opt-in with the SAME config: the full snapshot re-records rather than
    // being skipped by a stale memo.
    setShareAnalytics(true);
    await recordConfigSettingSnapshot(makeConfig(true, false));
    expect((await recordedPairs()).sort()).toEqual([
      ["memory.enabled", "true"],
      ["memory.v3.live", "false"],
    ]);
  });

  test("a partial config skips missing keys instead of throwing", async () => {
    await recordConfigSettingSnapshot({} as AssistantConfig);
    expect(await recordedPairs()).toHaveLength(0);

    await recordConfigSettingSnapshot({
      memory: { enabled: true },
    } as AssistantConfig);
    expect(await recordedPairs()).toEqual([["memory.enabled", "true"]]);
  });
});
