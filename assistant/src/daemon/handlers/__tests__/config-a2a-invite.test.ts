/**
 * Tests for A2A invite creation handler.
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
import { getContact } from "../../../contacts/contact-store.js";
import { requireMainDb } from "../../../persistence/db-facade.js";
import { initializeDb } from "../../../persistence/db-init.js";
import { createA2AInvite, getA2AConfig } from "../config-a2a.js";

await initializeDb();

async function resetTables(): Promise<void> {
  const db = requireMainDb();
  await db.run("DELETE FROM a2a_invites");
  await db.run("DELETE FROM assistant_contact_metadata");
  await db.run("DELETE FROM contact_channels");
  await db.run("DELETE FROM contacts");
}

interface A2aInviteRow {
  id: string;
  contact_id: string;
  status: string;
  max_uses: number;
  use_count: number;
  expires_at: number;
}

async function getInviteRow(id: string): Promise<A2aInviteRow | null> {
  const db = requireMainDb();
  return await db.get<A2aInviteRow>("SELECT * FROM a2a_invites WHERE id = ?", [
    id,
  ]);
}

function setConfig(opts: {
  a2aEnabled?: boolean;
  publicBaseUrl?: string;
  ingressEnabled?: boolean;
}): void {
  const raw = loadRawConfig();
  if (opts.a2aEnabled !== undefined) {
    setNestedValue(raw, "a2a.enabled", opts.a2aEnabled);
  }
  if (opts.publicBaseUrl !== undefined) {
    setNestedValue(raw, "ingress.publicBaseUrl", opts.publicBaseUrl);
  }
  if (opts.ingressEnabled !== undefined) {
    setNestedValue(raw, "ingress.enabled", opts.ingressEnabled);
  }
  saveRawConfig(raw);
  invalidateConfigCache();
}

describePg("createA2AInvite", () => {
  beforeEach(async () => {
    await resetTables();
    setConfig({
      a2aEnabled: false,
      publicBaseUrl: "https://example.vellum.ai",
      ingressEnabled: true,
    });
  });

  test("returns success with inviteId, token, expiresAt, senderGatewayUrl", async () => {
    const result = await createA2AInvite({});
    expect(result.success).toBe(true);
    expect(result.inviteId).toBeDefined();
    expect(result.token).toBeDefined();
    expect(result.expiresAt).toBeDefined();
    expect(result.senderGatewayUrl).toBe("https://example.vellum.ai");
    expect(result.error).toBeUndefined();
  });

  test("creates invite in a2a_invites with status=active, max_uses=1", async () => {
    const result = await createA2AInvite({});
    expect(result.inviteId).toBeDefined();

    const invite = await getInviteRow(result.inviteId!);
    expect(invite).not.toBeNull();
    expect(invite!.status).toBe("active");
    expect(invite!.max_uses).toBe(1);
  });

  test("auto-enables A2A if not already on", async () => {
    // A2A starts disabled
    expect((await getA2AConfig()).enabled).toBe(false);

    const result = await createA2AInvite({});
    expect(result.success).toBe(true);

    // A2A should now be enabled
    expect((await getA2AConfig()).enabled).toBe(true);
  });

  test("creates placeholder contact with no channels, bound to invite via contactId", async () => {
    const result = await createA2AInvite({});
    expect(result.inviteId).toBeDefined();

    const invite = await getInviteRow(result.inviteId!);
    expect(invite).not.toBeNull();

    const contact = await getContact(invite!.contact_id);
    expect(contact).not.toBeNull();
    expect(contact!.displayName).toBe("Pending A2A invite");
    expect(contact!.channels).toHaveLength(0);
  });

  test("returns error when public base URL is not configured", async () => {
    setConfig({
      a2aEnabled: false,
      publicBaseUrl: "",
      ingressEnabled: true,
    });

    const result = await createA2AInvite({});
    expect(result.success).toBe(false);
    expect(result.error).toContain("public base URL");
  });

  test("custom expiry via expiresInHours", async () => {
    const before = Date.now();
    const result = await createA2AInvite({ expiresInHours: 24 });
    const after = Date.now();
    expect(result.success).toBe(true);

    const invite = await getInviteRow(result.inviteId!);
    expect(invite).not.toBeNull();

    const expectedMinMs = before + 24 * 60 * 60 * 1000;
    const expectedMaxMs = after + 24 * 60 * 60 * 1000;
    expect(invite!.expires_at).toBeGreaterThanOrEqual(expectedMinMs);
    expect(invite!.expires_at).toBeLessThanOrEqual(expectedMaxMs);
  });

  test("default expiry is 72 hours", async () => {
    const before = Date.now();
    const result = await createA2AInvite({});
    const after = Date.now();
    expect(result.success).toBe(true);

    const invite = await getInviteRow(result.inviteId!);
    expect(invite).not.toBeNull();

    const expectedMinMs = before + 72 * 60 * 60 * 1000;
    const expectedMaxMs = after + 72 * 60 * 60 * 1000;
    expect(invite!.expires_at).toBeGreaterThanOrEqual(expectedMinMs);
    expect(invite!.expires_at).toBeLessThanOrEqual(expectedMaxMs);
  });
});
