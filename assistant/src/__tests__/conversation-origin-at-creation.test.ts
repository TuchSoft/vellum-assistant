/**
 * Conversation provenance is stated at creation.
 *
 * `createConversation` accepts the origin so the row is attributed from the
 * moment it exists, rather than being patched afterward by
 * `setConversationOriginChannelIfUnset` on the first inbound message. See
 * JARVIS-1466 for why the post-hoc path leaves the column in a third
 * "not yet attributed" state that different readers resolve in opposite
 * directions.
 *
 * The omitted-origin case is pinned deliberately: while call sites are being
 * migrated, omitting the argument has to behave exactly as it did before the
 * parameter existed, or migrating them stops being safe to do piecemeal.
 */

import { beforeEach, expect, test } from "bun:test";

import {
  createConversation,
  getConversationOriginChannel,
  setConversationOriginChannelIfUnset,
} from "../persistence/conversation-crud.js";
import { requireMainDb } from "../persistence/db-facade.js";
import { describePg } from "./pg-test-db.js";

/** The raw column, not the parsed accessor, so NULL stays distinguishable. */
async function rawOriginChannel(id: string): Promise<string | null> {
  const row = await requireMainDb().get<{ origin_channel: string | null }>(
    "SELECT origin_channel FROM conversations WHERE id = ?",
    [id],
  );
  return row?.origin_channel ?? null;
}

beforeEach(async () => {
  await requireMainDb().run("DELETE FROM conversations");
});

describePg("stating the origin at creation", () => {
  test("stamps a native conversation", async () => {
    const conv = await createConversation({
      title: "in-app",
      origin: "vellum",
    });

    expect(await rawOriginChannel(conv.id)).toBe("vellum");
  });

  test("stamps an external channel", async () => {
    const conv = await createConversation({
      title: "from-slack",
      origin: "slack",
    });

    expect(await rawOriginChannel(conv.id)).toBe("slack");
  });

  test("a stamped row is attributed before any message arrives", async () => {
    // The point of the change: the row is already correct, so nothing has to
    // run afterward to make it so.
    const conv = await createConversation({
      title: "from-slack",
      origin: "slack",
    });

    expect(await getConversationOriginChannel(conv.id)).toBe("slack");
  });
});

describePg("inheriting the origin from a parent", () => {
  test("a fork lands on its parent's channel", async () => {
    const parent = await createConversation({
      title: "parent",
      origin: "telegram",
    });

    const fork = await createConversation({
      title: "fork",
      origin: { inheritFrom: parent.id },
    });

    expect(await rawOriginChannel(fork.id)).toBe("telegram");
  });

  test("inheriting from a native parent stays native", async () => {
    const parent = await createConversation({
      title: "parent",
      origin: "vellum",
    });

    const fork = await createConversation({
      title: "fork",
      origin: { inheritFrom: parent.id },
    });

    expect(await rawOriginChannel(fork.id)).toBe("vellum");
  });

  test("a parent whose own origin is unset yields an unset origin", async () => {
    // Faithful inheritance, not an error. Most rows sit unattributed until a
    // message claims them or startup sweeps them, so treating this as a
    // failure would break the majority of forks and subagent spawns.
    const parent = await createConversation({ title: "unattributed-parent" });

    const fork = await createConversation({
      title: "fork",
      origin: { inheritFrom: parent.id },
    });

    expect(await rawOriginChannel(fork.id)).toBeNull();
  });

  test("a parent that does not exist fails the insert rather than defaulting", async () => {
    // Defaulting here would be a trust grant, not a cosmetic guess:
    // `recoverRestingTrustContext` recovers INTERNAL_GUARDIAN_TRUST_CONTEXT
    // for the native channel, so a fork of a remote conversation whose parent
    // we failed to read would come back as the guardian's own on every later
    // wake and boot-resume.
    await expect(async () => {
      await createConversation({
        title: "orphan",
        origin: { inheritFrom: "no-such-conversation" },
      });
    }).toThrow(/Cannot inherit conversation origin/);
  });

  test("a remote parent's fork does not become native", async () => {
    // The property that matters for trust, stated directly.
    const parent = await createConversation({
      title: "parent",
      origin: "slack",
    });

    const fork = await createConversation({
      title: "fork",
      origin: { inheritFrom: parent.id },
    });

    expect(await rawOriginChannel(fork.id)).not.toBe("vellum");
    expect(await rawOriginChannel(fork.id)).toBe("slack");
  });
});

describePg("callers that have not been migrated yet", () => {
  test("omitting the origin leaves the column unset", async () => {
    const conv = await createConversation({ title: "unmigrated" });

    expect(await rawOriginChannel(conv.id)).toBeNull();
  });

  test("attribution still claims an unstamped row", async () => {
    const conv = await createConversation({ title: "unmigrated" });

    await setConversationOriginChannelIfUnset(conv.id, "slack");

    expect(await rawOriginChannel(conv.id)).toBe("slack");
  });

  test("attribution does not overwrite an origin stated at creation", async () => {
    // The `isNull` guard is what makes stamping and attribution able to
    // coexist during the migration: a row that already knows its origin is
    // never re-claimed by a later message.
    const conv = await createConversation({
      title: "from-slack",
      origin: "slack",
    });

    await setConversationOriginChannelIfUnset(conv.id, "telegram");

    expect(await rawOriginChannel(conv.id)).toBe("slack");
  });
});
