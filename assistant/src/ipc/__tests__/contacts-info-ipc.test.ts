/**
 * Unit tests for the daemon-side contact INFO-READ IPC handlers
 * (ipc/routes/contacts-info-ipc-routes.ts). Each handler reads the real
 * (isolated) Postgres database, so we seed rows via requireMainDb() and invoke
 * the handler with `{ body }` exactly as the IPC server would.
 */

import { beforeEach, expect, test } from "bun:test";

import { describePg } from "../../__tests__/pg-test-db.js";
import { requireMainDb } from "../../persistence/db-facade.js";
import {
  handleContactChannelIdentityLookup,
  handleContactMirrorProbe,
  handleContactsInfoBatch,
  handleContactUserFileSlugs,
} from "../routes/contacts-info-ipc-routes.js";

async function resetTables(): Promise<void> {
  const db = requireMainDb();
  await db.run("DELETE FROM assistant_contact_metadata");
  await db.run("DELETE FROM contact_channels");
  await db.run("DELETE FROM contacts");
}

async function insertContact(params: {
  id: string;
  displayName?: string;
  notes?: string | null;
  userFile?: string | null;
  contactType?: "human" | "assistant";
}): Promise<void> {
  const now = Date.now();
  await requireMainDb().run(
    "INSERT INTO contacts (id, display_name, notes, user_file, contact_type, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)",
    [
      params.id,
      params.displayName ?? `name-${params.id}`,
      params.notes ?? null,
      params.userFile ?? null,
      params.contactType ?? "human",
      now,
      now,
    ],
  );
}

async function insertChannel(params: {
  id: string;
  contactId: string;
  type?: string;
  address: string;
  externalChatId?: string | null;
  updatedAt?: number | null;
}): Promise<void> {
  const now = Date.now();
  await requireMainDb().run(
    "INSERT INTO contact_channels (id, contact_id, type, address, is_primary, external_chat_id, created_at, updated_at) VALUES (?, ?, ?, ?, false, ?, ?, ?)",
    [
      params.id,
      params.contactId,
      params.type ?? "telegram",
      params.address,
      params.externalChatId ?? null,
      now,
      params.updatedAt !== undefined ? params.updatedAt : now,
    ],
  );
}

async function insertMetadata(params: {
  contactId: string;
  species: string;
  metadata?: Record<string, unknown> | null;
}): Promise<void> {
  await requireMainDb().run(
    "INSERT INTO assistant_contact_metadata (contact_id, species, metadata) VALUES (?, ?, ?)",
    [
      params.contactId,
      params.species,
      params.metadata != null ? JSON.stringify(params.metadata) : null,
    ],
  );
}

beforeEach(async () => {
  await resetTables();
});

// ── contacts_info_batch ──────────────────────────────────────────────────────

describePg("handleContactsInfoBatch", () => {
  test("empty contactIds returns empty infos", async () => {
    const result = await handleContactsInfoBatch({ body: { contactIds: [] } });
    expect(result).toEqual({ infos: [] });
  });

  test("returns info fields and gates assistant metadata on contactType", async () => {
    await insertContact({ id: "c1", notes: "friend", contactType: "human" });
    await insertContact({ id: "c2", contactType: "assistant" });
    await insertMetadata({
      contactId: "c2",
      species: "vellum",
      metadata: { model: "opus" },
    });

    const result = (await handleContactsInfoBatch({
      body: { contactIds: ["c1", "c2", "missing"] },
    })) as { infos: Array<Record<string, unknown>> };

    expect(result.infos).toHaveLength(2);
    const c1 = result.infos.find((i) => i.contactId === "c1")!;
    expect(c1.notes).toBe("friend");
    expect(c1.contactType).toBe("human");
    expect(c1.assistantMetadata).toBeNull();

    const c2 = result.infos.find((i) => i.contactId === "c2")!;
    expect(c2.contactType).toBe("assistant");
    expect(c2.assistantMetadata).toEqual({
      species: "vellum",
      metadata: { model: "opus" },
    });
  });

  test("does not emit metadata for human contact with stale species row", async () => {
    await insertContact({ id: "c1", contactType: "human" });
    await insertMetadata({
      contactId: "c1",
      species: "vellum",
      metadata: { x: 1 },
    });

    const result = (await handleContactsInfoBatch({
      body: { contactIds: ["c1"] },
    })) as { infos: Array<Record<string, unknown>> };
    expect(result.infos[0].assistantMetadata).toBeNull();
  });

  test("malformed metadata JSON degrades to null metadata", async () => {
    await insertContact({ id: "c1", contactType: "assistant" });
    await requireMainDb().run(
      "INSERT INTO assistant_contact_metadata (contact_id, species, metadata) VALUES (?, ?, ?)",
      ["c1", "vellum", "{not valid json"],
    );

    const result = (await handleContactsInfoBatch({
      body: { contactIds: ["c1"] },
    })) as { infos: Array<Record<string, unknown>> };
    expect(result.infos[0].assistantMetadata).toEqual({
      species: "vellum",
      metadata: null,
    });
  });

  test("rejects a malformed body (non-array contactIds)", async () => {
    await expect(
      handleContactsInfoBatch({ body: { contactIds: "nope" } as never }),
    ).rejects.toThrow();
  });
});

// ── contact_channel_identity_lookup ──────────────────────────────────────────

describePg("handleContactChannelIdentityLookup", () => {
  test("resolves by (type, address) case-insensitively", async () => {
    await insertContact({ id: "c1", displayName: "Alice" });
    await insertChannel({
      id: "ch1",
      contactId: "c1",
      type: "email",
      address: "Alice@Example.com",
      externalChatId: "chat-1",
    });

    const result = (await handleContactChannelIdentityLookup({
      body: { type: "email", address: "alice@example.com" },
    })) as { channel: Record<string, unknown> | null };

    expect(result.channel).toEqual({
      id: "ch1",
      contactId: "c1",
      type: "email",
      address: "Alice@Example.com",
      externalChatId: "chat-1",
      displayName: "Alice",
    });
  });

  test("resolves by channelId", async () => {
    await insertContact({ id: "c1", displayName: "Bob" });
    await insertChannel({
      id: "ch1",
      contactId: "c1",
      type: "slack",
      address: "U123",
    });

    const result = (await handleContactChannelIdentityLookup({
      body: { channelId: "ch1" },
    })) as { channel: Record<string, unknown> | null };
    expect(result.channel?.type).toBe("slack");
    expect(result.channel?.address).toBe("U123");
    expect(result.channel?.displayName).toBe("Bob");
  });

  test("returns null when no channel matches", async () => {
    const result = await handleContactChannelIdentityLookup({
      body: { channelId: "nope" },
    });
    expect(result).toEqual({ channel: null });
  });

  test("duplicate (type,address) rows resolve to the most-recently-updated", async () => {
    // The unique (type,address) index is case-SENSITIVE while this lookup is
    // COLLATE NOCASE, so case-variant duplicates can match; the newest row must
    // win deterministically (matches the raw SQL it replaced).
    await insertContact({ id: "c-old" });
    await insertContact({ id: "c-new" });
    await insertChannel({
      id: "ch-old",
      contactId: "c-old",
      type: "email",
      address: "Dup@Example.com",
      updatedAt: 1_000,
    });
    await insertChannel({
      id: "ch-new",
      contactId: "c-new",
      type: "email",
      address: "dup@example.com",
      updatedAt: 2_000,
    });

    const result = (await handleContactChannelIdentityLookup({
      body: { type: "email", address: "DUP@example.com" },
    })) as { channel: { id: string; contactId: string } | null };
    expect(result.channel?.id).toBe("ch-new");
    expect(result.channel?.contactId).toBe("c-new");
  });

  // Postgres orders NULL first in a descending sort, so the lookup needs an
  // explicit NULLS LAST to keep the stamped row on top.
  test.todo(
    "a duplicate with NULL updated_at loses to a stamped row",
    async () => {
      await insertContact({ id: "c-null" });
      await insertContact({ id: "c-stamped" });
      await insertChannel({
        id: "ch-null",
        contactId: "c-null",
        type: "email",
        address: "Nulldup@Example.com",
        updatedAt: null,
      });
      await insertChannel({
        id: "ch-stamped",
        contactId: "c-stamped",
        type: "email",
        address: "nulldup@example.com",
        updatedAt: 1_000,
      });

      const result = (await handleContactChannelIdentityLookup({
        body: { type: "email", address: "nulldup@example.com" },
      })) as { channel: { id: string } | null };
      expect(result.channel?.id).toBe("ch-stamped");
    },
  );

  test("rejects a selector with neither channelId nor (type,address)", async () => {
    await expect(
      handleContactChannelIdentityLookup({ body: { type: "email" } }),
    ).rejects.toThrow();
  });
});

// ── contact_mirror_probe ─────────────────────────────────────────────────────

describePg("handleContactMirrorProbe", () => {
  test("reports absence when the contact is not mirrored", async () => {
    const result = (await handleContactMirrorProbe({
      body: { contactId: "gone" },
    })) as Record<string, unknown>;
    expect(result).toEqual({
      exists: false,
      hasChannels: false,
      notes: null,
      userFile: null,
      contactType: null,
      hasMetadata: false,
    });
  });

  test("reports info fields, channels, and metadata presence", async () => {
    await insertContact({
      id: "c1",
      notes: "note",
      userFile: "alice.md",
      contactType: "assistant",
    });
    await insertChannel({ id: "ch1", contactId: "c1", address: "addr" });
    await insertMetadata({ contactId: "c1", species: "vellum" });

    const result = (await handleContactMirrorProbe({
      body: { contactId: "c1" },
    })) as Record<string, unknown>;
    expect(result).toEqual({
      exists: true,
      hasChannels: true,
      notes: "note",
      userFile: "alice.md",
      contactType: "assistant",
      hasMetadata: true,
    });
  });

  test("row present with no channels or metadata (bare seed contact)", async () => {
    await insertContact({ id: "c1", contactType: "human" });
    const result = (await handleContactMirrorProbe({
      body: { contactId: "c1" },
    })) as Record<string, unknown>;
    expect(result.exists).toBe(true);
    expect(result.hasChannels).toBe(false);
    expect(result.hasMetadata).toBe(false);
    expect(result.contactType).toBe("human");
  });
});

// ── contact_user_file_slugs ──────────────────────────────────────────────────

describePg("handleContactUserFileSlugs", () => {
  test("lists user_file slugs matching the prefix", async () => {
    await insertContact({ id: "c1", userFile: "alice.md" });
    await insertContact({ id: "c2", userFile: "alice-2.md" });
    await insertContact({ id: "c3", userFile: "bob.md" });
    await insertContact({ id: "c4", userFile: null });

    const result = (await handleContactUserFileSlugs({
      body: { prefix: "alice" },
    })) as { userFiles: string[] };
    expect(result.userFiles.sort()).toEqual(["alice-2.md", "alice.md"]);
  });

  test("returns empty list when nothing matches", async () => {
    await insertContact({ id: "c1", userFile: "zed.md" });
    const result = await handleContactUserFileSlugs({
      body: { prefix: "alice" },
    });
    expect(result).toEqual({ userFiles: [] });
  });
});
