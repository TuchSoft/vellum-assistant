/**
 * The key store attributes a channel conversation when it materializes it.
 *
 * This is the principal inbound seam: a new Slack, Telegram, or phone
 * conversation gets its row here, before the daemon's own creation path is
 * ever consulted. Stamping only in `createConversation` therefore misses the
 * case that matters most, which is why these cases exist separately.
 *
 * The trust assertion at the end is the one worth protecting. `origin_channel`
 * is what `recoverRestingTrustContext` reads, and the native channel recovers
 * INTERNAL_GUARDIAN_TRUST_CONTEXT on every later wake and boot-resume. A
 * remote conversation that reached this seam unattributed, or attributed as
 * native, would resume as the guardian's own.
 */

import { beforeEach, expect, test } from "bun:test";

import { recoverRestingTrustContext } from "../daemon/conversation-resting-trust.js";
import { setConversationOriginChannelIfUnset } from "../persistence/conversation-crud.js";
import { getOrCreateConversation } from "../persistence/conversation-key-store.js";
import { requireMainDb } from "../persistence/db-facade.js";
import { describePg } from "./pg-test-db.js";

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

describePg("materializing a conversation from a channel key", () => {
  test("stamps the channel at creation, before any message", async () => {
    const { conversationId, created } = await getOrCreateConversation(
      "default:slack:slack",
      { origin: "slack" },
    );

    expect(created).toBe(true);
    expect(await rawOriginChannel(conversationId)).toBe("slack");
  });

  test("the first message does not change what creation established", async () => {
    // Attribution is guarded on `IS NULL`, so a row attributed at creation is
    // never re-claimed. Before and after the first message agree.
    const { conversationId } = await getOrCreateConversation(
      "default:slack:slack",
      { origin: "slack" },
    );
    const atCreation = await rawOriginChannel(conversationId);

    await setConversationOriginChannelIfUnset(conversationId, "telegram");

    expect(await rawOriginChannel(conversationId)).toBe(atCreation);
    expect(await rawOriginChannel(conversationId)).toBe("slack");
  });

  test("reusing an existing key does not re-attribute it", async () => {
    const first = await getOrCreateConversation("default:slack:slack", {
      origin: "slack",
    });

    const second = await getOrCreateConversation("default:slack:slack", {
      origin: "vellum",
    });

    expect(second.created).toBe(false);
    expect(second.conversationId).toBe(first.conversationId);
    expect(await rawOriginChannel(first.conversationId)).toBe("slack");
  });

  test("a caller that states no origin leaves the column unset", async () => {
    const { conversationId } = await getOrCreateConversation("some:other:key");

    expect(await rawOriginChannel(conversationId)).toBeNull();
  });
});

describePg("what the attribution protects", () => {
  test("a channel conversation recovers no resting trust", async () => {
    // The property the whole change exists to hold. Driven through the
    // creation seam rather than a raw column write, so it fails if creation
    // ever stops attributing the row.
    const { conversationId } = await getOrCreateConversation(
      "default:slack:slack",
      { origin: "slack" },
    );

    expect(await recoverRestingTrustContext(conversationId)).toBeNull();
  });

  test("a native conversation still recovers guardian trust", async () => {
    // The other half: attributing at creation must not withdraw trust from
    // the guardian's own conversations, or every local wake regresses.
    const { conversationId } = await getOrCreateConversation("native-key", {
      origin: "vellum",
    });

    expect(await recoverRestingTrustContext(conversationId)).not.toBeNull();
  });
});
