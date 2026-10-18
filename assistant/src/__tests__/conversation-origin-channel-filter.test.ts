import { beforeEach, expect, test } from "bun:test";

import { createConversation } from "../persistence/conversation-crud.js";
import { ensureGroupMigrationAsync } from "../persistence/conversation-group-migration.js";
import { listConversations } from "../persistence/conversation-queries.js";
import { requireMainDb } from "../persistence/db-facade.js";
import { describePg } from "./pg-test-db.js";

await ensureGroupMigrationAsync();

/**
 * `originChannel` is what lets each sidebar channel card fetch its own rows,
 * and what lets the Chats card ask for the ones no channel claimed.
 *
 * The asymmetry under test: `origin_channel` is deliberately NULL at insert so
 * an inbound message can claim the conversation for its channel, and migration
 * 288 settles the unclaimed ones to 'vellum' at daemon startup. So NULL means
 * "not yet attributed", and between one boot and the next it is what most rows
 * carry. Reading `vellum` strictly would leave every one of them in no section
 * at all: not native, not any channel.
 */
describePg("listConversations originChannel filter", () => {
  beforeEach(async () => {
    const raw = requireMainDb();
    await raw.run("DELETE FROM conversations");
  });

  /** Set `origin_channel` directly; `createConversation` leaves it unset. */
  async function stamp(
    id: string,
    originChannel: string | null,
  ): Promise<void> {
    await requireMainDb().run(
      "UPDATE conversations SET origin_channel = ? WHERE id = ?",
      [originChannel, id],
    );
  }

  async function listedIds(originChannel: string): Promise<string[]> {
    return (
      await listConversations({ originChannel } as Parameters<
        typeof listConversations
      >[0])
    ).map((c) => c.id);
  }

  test("vellum matches rows that were never attributed", async () => {
    await createConversation({ id: "conv-unattributed", source: "user" });
    await stamp("conv-unattributed", null);

    expect(await listedIds("vellum")).toEqual(["conv-unattributed"]);
  });

  test("vellum matches rows explicitly stamped vellum", async () => {
    await createConversation({ id: "conv-native", source: "user" });
    await stamp("conv-native", "vellum");

    expect(await listedIds("vellum")).toEqual(["conv-native"]);
  });

  /* The whole point: an unattributed row and a stamped native row are the same
     section. Asserting both are returned together, rather than each alone,
     is what fails if the predicate goes back to a strict equality. */
  test("vellum returns unattributed and stamped rows together", async () => {
    await createConversation({ id: "conv-native", source: "user" });
    await stamp("conv-native", "vellum");
    await createConversation({ id: "conv-unattributed", source: "user" });
    await stamp("conv-unattributed", null);

    expect((await listedIds("vellum")).sort()).toEqual([
      "conv-native",
      "conv-unattributed",
    ]);
  });

  test("vellum does not claim a row belonging to a channel", async () => {
    await createConversation({ id: "conv-slack", source: "user" });
    await stamp("conv-slack", "slack");

    expect(await listedIds("vellum")).toEqual([]);
  });

  /* Only `vellum` is tolerant. A row is claimed for a channel by that channel
     alone, so there is no ambiguity for the others to absorb - and a tolerant
     `slack` would pull every unattributed row into the Slack card. */
  test("a channel matches exactly and never absorbs unattributed rows", async () => {
    await createConversation({ id: "conv-slack", source: "user" });
    await stamp("conv-slack", "slack");
    await createConversation({ id: "conv-unattributed", source: "user" });
    await stamp("conv-unattributed", null);

    expect(await listedIds("slack")).toEqual(["conv-slack"]);
  });
});
