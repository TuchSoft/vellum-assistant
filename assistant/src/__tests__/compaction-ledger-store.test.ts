import { beforeEach, expect, setDefaultTimeout, test } from "bun:test";

import { eq } from "drizzle-orm";

import {
  appendCompactionEvent,
  forkCompactionLedger,
  getLatestCompactionEventAtOrBefore,
} from "../persistence/compaction-ledger-store.js";
import { requireMainDb } from "../persistence/db-facade.js";
import {
  conversationCompactionEvents,
  conversations,
} from "../persistence/pg-schema/index.js";
import { describePg } from "./pg-test-db.js";

async function reset(): Promise<void> {
  const db = requireMainDb();
  await db.orm.delete(conversationCompactionEvents);
  await db.orm.delete(conversations);
}

async function makeConversation(id: string): Promise<void> {
  const now = Date.now();
  await requireMainDb()
    .orm.insert(conversations)
    .values({ id, title: id, createdAt: now, updatedAt: now });
}

async function forkEventsFor(conversationId: string) {
  return requireMainDb()
    .orm.select()
    .from(conversationCompactionEvents)
    .where(eq(conversationCompactionEvents.conversationId, conversationId));
}

describePg("compaction-ledger-store", () => {
  beforeEach(reset);

  test("getLatestCompactionEventAtOrBefore returns the newest event at-or-before the cutoff", async () => {
    await makeConversation("conv");
    await appendCompactionEvent("conv", {
      compactedAt: 100,
      summary: "s100",
      compactedMessageCount: 1,
    });
    await appendCompactionEvent("conv", {
      compactedAt: 200,
      summary: "s200",
      compactedMessageCount: 3,
    });
    await appendCompactionEvent("conv", {
      compactedAt: 300,
      summary: "s300",
      compactedMessageCount: 5,
    });

    expect(await getLatestCompactionEventAtOrBefore("conv", 50)).toBeNull();
    expect(
      (await getLatestCompactionEventAtOrBefore("conv", 100))
        ?.compactedMessageCount,
    ).toBe(1);
    expect(
      (await getLatestCompactionEventAtOrBefore("conv", 250))
        ?.compactedMessageCount,
    ).toBe(3);
    expect(
      (await getLatestCompactionEventAtOrBefore("conv", 999))
        ?.compactedMessageCount,
    ).toBe(5);
    expect(await getLatestCompactionEventAtOrBefore("conv", null)).toBeNull();
  });

  test("getLatestCompactionEventAtOrBefore is scoped per conversation", async () => {
    await makeConversation("a");
    await makeConversation("b");
    await appendCompactionEvent("a", {
      compactedAt: 100,
      summary: "a",
      compactedMessageCount: 1,
    });

    expect(await getLatestCompactionEventAtOrBefore("b", 999)).toBeNull();
  });

  test("forkCompactionLedger copies only events at-or-before the boundary", async () => {
    await makeConversation("src");
    await makeConversation("fork");
    await appendCompactionEvent("src", {
      compactedAt: 100,
      summary: "s100",
      compactedMessageCount: 1,
    });
    await appendCompactionEvent("src", {
      compactedAt: 300,
      summary: "s300",
      compactedMessageCount: 5,
    });

    await forkCompactionLedger(requireMainDb(), "src", "fork", 200);

    const copied = await forkEventsFor("fork");
    expect(copied).toHaveLength(1);
    expect(copied[0]?.compactedAt).toBe(100);
    expect(copied[0]?.summary).toBe("s100");
  });

  test("forkCompactionLedger with a null boundary copies nothing", async () => {
    await makeConversation("src");
    await makeConversation("fork");
    await appendCompactionEvent("src", {
      compactedAt: 100,
      summary: "s100",
      compactedMessageCount: 1,
    });

    await forkCompactionLedger(requireMainDb(), "src", "fork", null);

    expect(await forkEventsFor("fork")).toHaveLength(0);
  });
});

setDefaultTimeout(30_000);
