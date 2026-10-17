import {
  afterAll,
  beforeEach,
  expect,
  setDefaultTimeout,
  test,
} from "bun:test";

import {
  createConversation,
  getConversation,
  setConversationEnabledPlugins,
} from "../persistence/conversation-crud.js";
import { requireMainDb } from "../persistence/db-facade.js";
import { initializeDb } from "../persistence/db-init.js";
import { ROUTES } from "../runtime/routes/conversation-management-routes.js";
import { BadRequestError, NotFoundError } from "../runtime/routes/errors.js";
import { buildConversationDetailResponse } from "../runtime/services/conversation-serializer.js";
import { resetDbForTesting } from "./db-test-helpers.js";
import { describePg } from "./pg-test-db.js";

await initializeDb();

const pluginsRoute = ROUTES.find(
  (r) => r.operationId === "conversations_by_id_enabledplugins_put",
)!;

async function clearTables(): Promise<void> {
  const db = requireMainDb();
  await db.run("DELETE FROM conversation_assistant_attention_state");
  await db.run("DELETE FROM external_conversation_bindings");
  await db.run("DELETE FROM conversation_keys");
  await db.run("DELETE FROM messages");
  await db.run("DELETE FROM conversations");
}

describePg("PUT /v1/conversations/:id/enabledplugins", () => {
  beforeEach(async () => {
    await clearTables();
  });

  afterAll(() => {
    resetDbForTesting();
  });

  test("persists a string[] scope and reflects it on the conversation", async () => {
    const conversation = await createConversation("enabledplugins-route");

    const result = await pluginsRoute.handler({
      pathParams: { id: conversation.id },
      body: { enabledPlugins: ["plugin-a", "plugin-b"] },
      headers: {},
    });

    expect(result).toMatchObject({
      conversationId: conversation.id,
      enabledPlugins: ["plugin-a", "plugin-b"],
    });
    expect((await getConversation(conversation.id))?.enabledPlugins).toEqual([
      "plugin-a",
      "plugin-b",
    ]);

    // The HTTP conversation-detail response (what the web `conversationsByIdGet`
    // reads) must also carry the scope, not just the internal DB getter.
    const detail = await buildConversationDetailResponse(conversation.id);
    expect(detail?.conversation.enabledPlugins).toEqual([
      "plugin-a",
      "plugin-b",
    ]);
  });

  test("detail response omits enabledPlugins by default and preserves an explicit []", async () => {
    const conversation = await createConversation(
      "enabledplugins-detail-shape",
    );

    // Default (no per-chat restriction): the field is omitted from the wire.
    expect(
      "enabledPlugins" in
        (await buildConversationDetailResponse(conversation.id))!.conversation,
    ).toBe(false);

    // Explicit empty scope (user cleared all optional plugins): preserved as [].
    await pluginsRoute.handler({
      pathParams: { id: conversation.id },
      body: { enabledPlugins: [] },
      headers: {},
    });
    expect(
      (await buildConversationDetailResponse(conversation.id))?.conversation
        .enabledPlugins,
    ).toEqual([]);
  });

  test("clears the scope to default when enabledPlugins is null", async () => {
    const conversation = await createConversation("enabledplugins-clear");

    await pluginsRoute.handler({
      pathParams: { id: conversation.id },
      body: { enabledPlugins: ["plugin-x"] },
      headers: {},
    });
    expect((await getConversation(conversation.id))?.enabledPlugins).toEqual([
      "plugin-x",
    ]);

    const result = await pluginsRoute.handler({
      pathParams: { id: conversation.id },
      body: { enabledPlugins: null },
      headers: {},
    });

    expect(result).toMatchObject({
      conversationId: conversation.id,
      enabledPlugins: null,
    });
    expect((await getConversation(conversation.id))?.enabledPlugins).toBeNull();
  });

  test("rejects a non-array, non-null body with BadRequestError", async () => {
    const conversation = await createConversation("enabledplugins-bad");

    await expect(
      pluginsRoute.handler({
        pathParams: { id: conversation.id },
        body: { enabledPlugins: "not-an-array" },
        headers: {},
      }),
    ).rejects.toThrow(BadRequestError);
    expect((await getConversation(conversation.id))?.enabledPlugins).toBeNull();
  });

  test("rejects an array containing a non-string with BadRequestError", async () => {
    const conversation = await createConversation("enabledplugins-bad-element");

    await expect(
      pluginsRoute.handler({
        pathParams: { id: conversation.id },
        body: { enabledPlugins: ["ok", 123] },
        headers: {},
      }),
    ).rejects.toThrow(BadRequestError);
    expect((await getConversation(conversation.id))?.enabledPlugins).toBeNull();
  });

  test("rejects a missing enabledPlugins field without clearing the scope", async () => {
    const conversation = await createConversation("enabledplugins-missing");
    // Seed an explicit scope, then send a body with no `enabledPlugins`.
    setConversationEnabledPlugins(conversation.id, ["plugin-a"]);

    await expect(
      pluginsRoute.handler({
        pathParams: { id: conversation.id },
        body: {},
        headers: {},
      }),
    ).rejects.toThrow(BadRequestError);
    // The existing scope must survive a malformed request (null is the only
    // explicit clear signal).
    expect((await getConversation(conversation.id))?.enabledPlugins).toEqual([
      "plugin-a",
    ]);
  });

  test("throws NotFoundError when the conversation does not exist", async () => {
    await expect(
      pluginsRoute.handler({
        pathParams: { id: "missing" },
        body: { enabledPlugins: [] },
        headers: {},
      }),
    ).rejects.toThrow(NotFoundError);
  });
});

setDefaultTimeout(30_000);
