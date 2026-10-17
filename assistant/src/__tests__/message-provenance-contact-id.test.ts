import { beforeEach, expect, setDefaultTimeout, test } from "bun:test";
setDefaultTimeout(30_000);

import { actorAuthorProvenance } from "../daemon/message-provenance.js";
import type { TrustContext } from "../daemon/trust-context-types.js";
import {
  addMessage,
  createConversation,
  getMessageById,
  parseMessageMetadata,
  provenanceFromTrustContext,
} from "../persistence/conversation-crud.js";
import { requireMainDb } from "../persistence/db-facade.js";
import { describePg } from "./pg-test-db.js";

const ALICE: TrustContext = {
  sourceChannel: "slack",
  trustClass: "trusted_contact",
  requesterIdentifier: "@alice",
  requesterContactId: "contact-alice",
};

async function persistWith(
  role: "user" | "assistant",
  metadata: Record<string, unknown>,
): Promise<ReturnType<typeof parseMessageMetadata>> {
  const conversation = await createConversation("provenance-contact-id");
  const row = await addMessage(conversation.id, role, "hello", { metadata });
  const stored = await getMessageById(row.id, conversation.id);
  return parseMessageMetadata(stored?.metadata ?? null);
}

describePg("message provenance contact id", () => {
  beforeEach(async () => {
    const db = requireMainDb();
    await db.run(`DELETE FROM messages`);
    await db.run(`DELETE FROM conversations`);
  });

  test("a person's own row names them as its author", async () => {
    const metadata = await persistWith("user", {
      ...provenanceFromTrustContext(ALICE),
      ...actorAuthorProvenance(ALICE),
    });

    expect(metadata?.provenanceTrustClass).toBe("trusted_contact");
    expect(metadata?.provenanceContactId).toBe("contact-alice");
  });

  test("a row written during their turn carries the turn's trust but no author", async () => {
    // The assistant's replies, tool results, and notices are stamped with the
    // turn's provenance alone.
    const metadata = await persistWith(
      "assistant",
      provenanceFromTrustContext(ALICE),
    );

    expect(metadata?.provenanceTrustClass).toBe("trusted_contact");
    expect(metadata?.provenanceContactId).toBeUndefined();
  });

  test("an actor with no resolved contact names no author", () => {
    expect(
      actorAuthorProvenance({ sourceChannel: "slack", trustClass: "unknown" }),
    ).toEqual({});
    expect(actorAuthorProvenance(undefined)).toEqual({});
  });
});
