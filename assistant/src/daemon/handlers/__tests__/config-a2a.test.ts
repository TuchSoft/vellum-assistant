/**
 * Tests for A2A config handler.
 *
 * Uses the real DB (via `initializeDb()`) and the test preload which sets
 * `VELLUM_WORKSPACE_DIR` to a per-file temp directory.
 */

import { beforeEach, expect, test } from "bun:test";

import { describePg } from "../../../__tests__/pg-test-db.js";
import {
  invalidateConfigCache,
  loadRawConfig,
  saveRawConfig,
  setNestedValue,
} from "../../../config/loader.js";
import { requireMainDb } from "../../../persistence/db-facade.js";
import { initializeDb } from "../../../persistence/db-init.js";
import { clearA2AConfig, getA2AConfig, setA2AConfig } from "../config-a2a.js";

await initializeDb();

async function resetTables(): Promise<void> {
  const db = requireMainDb();
  await db.run("DELETE FROM assistant_contact_metadata");
  await db.run("DELETE FROM contact_channels");
  await db.run("DELETE FROM contacts");
}

function setConfigEnabled(enabled: boolean): void {
  const raw = loadRawConfig();
  setNestedValue(raw, "a2a.enabled", enabled);
  saveRawConfig(raw);
  invalidateConfigCache();
}

describePg("getA2AConfig", () => {
  beforeEach(async () => {
    await resetTables();
    setConfigEnabled(false);
  });

  test("returns enabled: false when a2a is disabled", async () => {
    const result = await getA2AConfig();
    expect(result.success).toBe(true);
    expect(result.enabled).toBe(false);
    expect(result.activeConnections).toBe(0);
  });

  test("returns enabled: true when a2a is enabled", async () => {
    setConfigEnabled(true);
    const result = await getA2AConfig();
    expect(result.success).toBe(true);
    expect(result.enabled).toBe(true);
  });
});

describePg("setA2AConfig", () => {
  beforeEach(async () => {
    await resetTables();
    setConfigEnabled(false);
  });

  test("enables a2a in config", async () => {
    const result = await setA2AConfig();
    expect(result.success).toBe(true);
    expect(result.enabled).toBe(true);
  });

  test("is idempotent", async () => {
    await setA2AConfig();
    const result = await setA2AConfig();
    expect(result.success).toBe(true);
    expect(result.enabled).toBe(true);
  });
});

describePg("clearA2AConfig", () => {
  beforeEach(async () => {
    await resetTables();
    setConfigEnabled(true);
  });

  test("disables a2a in config", async () => {
    const result = clearA2AConfig();
    expect(result.success).toBe(true);
    expect(result.enabled).toBe(false);
  });
});
