/**
 * Conformance suite for the `contacts` slice on Postgres.
 *
 * `contact-store.ts` reads and writes `contacts`, `contact_channels`, and
 * `assistant_contact_metadata`, all on the `main` slot, through the async
 * `AsyncDb` facade. The suite covers the case-insensitive matching that
 * replaced SQLite's `COLLATE NOCASE` and runs against the process's Postgres
 * test schema, bootstrapped by `src/__tests__/pg-test-db.ts`.
 *
 * Gated on `VELLUM_PG_TEST_URL` (throwaway instance); with it unset the suite
 * skips.
 */

import { beforeEach, expect, test } from "bun:test";

import { describePg } from "../__tests__/pg-test-db.js";
import { requireMainDb } from "../persistence/db-facade.js";
import { initializeDb } from "../persistence/db-init.js";
import {
  deleteContact,
  findContactChannel,
  getAssistantContactMetadata,
  getContact,
  mergeContactMirror,
  searchContacts,
  upsertContact,
  upsertContactMirrorFull,
} from "./contact-store.js";

await initializeDb();

async function clearContacts(): Promise<void> {
  const db = requireMainDb();
  await db.run("DELETE FROM contact_channels");
  await db.run("DELETE FROM contacts");
  await db.run("DELETE FROM assistant_contact_metadata");
}

describePg("contact store (postgres)", () => {
  beforeEach(async () => {
    await clearContacts();
  });

  test("creates a contact with a channel and reads it back", async () => {
    const created = await upsertContact({
      displayName: "Alice",
      channels: [{ type: "email", address: "alice@example.com" }],
    });
    expect(created.created).toBe(true);
    expect(created.displayName).toBe("Alice");
    expect(created.channels).toHaveLength(1);

    const read = await getContact(created.id);
    expect(read?.displayName).toBe("Alice");
    expect(read?.channels[0]?.type).toBe("email");
  });

  test("matches channel addresses case-insensitively", async () => {
    const created = await upsertContact({
      displayName: "Bob",
      channels: [{ type: "telegram", address: "Bob-User" }],
    });

    const found = await findContactChannel({
      channelType: "telegram",
      address: "bob-user",
    });
    expect(found?.contact.id).toBe(created.id);
    expect(found?.channel.address).toBe("Bob-User");
  });

  test("searches by display name and channel address", async () => {
    await upsertContact({
      displayName: "Carol Example",
      channels: [{ type: "slack", address: "U_CAROL" }],
    });

    expect(
      (await searchContacts({ query: "carol" })).map((c) => c.displayName),
    ).toContain("Carol Example");
    expect(
      (await searchContacts({ channelAddress: "carol" })).map(
        (c) => c.displayName,
      ),
    ).toContain("Carol Example");
  });

  test("merges donor contacts, combining notes and reparenting channels", async () => {
    const keep = await upsertContact({
      displayName: "Keep",
      notes: "survivor note",
      channels: [{ type: "email", address: "keep@example.com" }],
    });
    const donor = await upsertContact({
      displayName: "Donor",
      notes: "donor note",
      channels: [{ type: "telegram", address: "donor-user" }],
    });

    await mergeContactMirror({
      keepContactId: keep.id,
      mergeContactId: donor.id,
      keepDisplayName: "Keep",
    });

    expect(await getContact(donor.id)).toBeNull();
    const merged = await getContact(keep.id);
    expect(merged?.notes).toContain("survivor note");
    expect(merged?.notes).toContain("donor note");
    expect(merged?.channels.map((ch) => ch.type).sort()).toEqual([
      "email",
      "telegram",
    ]);
  });

  test("upserts assistant metadata and deletes the contact", async () => {
    await upsertContactMirrorFull({
      contactId: "assistant-1",
      displayName: "Assistant",
      contactType: "assistant",
      assistantMetadata: {
        species: "vellum",
        metadata: { assistantId: "a-1" },
      },
    });

    const metadata = await getAssistantContactMetadata("assistant-1");
    expect(metadata?.species).toBe("vellum");
    expect(metadata?.metadata).toEqual({ assistantId: "a-1" });

    await deleteContact("assistant-1");
    expect(await getContact("assistant-1")).toBeNull();
  });
});
