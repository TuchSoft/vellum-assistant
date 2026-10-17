import {
  afterAll,
  beforeEach,
  expect,
  mock,
  setDefaultTimeout,
  test,
} from "bun:test";
setDefaultTimeout(30_000);

mock.module("../config/env.js", () => ({
  isHttpAuthDisabled: () => true,
  hasUngatedHttpAuthDisabled: () => false,
  getGatewayInternalBaseUrl: () => "http://127.0.0.1:7830",
  getGatewayPort: () => 7830,
  getRuntimeHttpPort: () => 7821,
  getRuntimeHttpHost: () => "127.0.0.1",
  getRuntimeGatewayOriginSecret: () => undefined,
  getIngressPublicBaseUrl: () => undefined,
  setIngressPublicBaseUrl: () => {},
}));

import {
  batchSetConversationPlacement,
  createConversation,
  updateConversationTitle,
} from "../persistence/conversation-crud.js";
import { requireMainDb } from "../persistence/db-facade.js";
import { RuntimeHttpServer } from "../runtime/http-server.js";
import { resetDbForTesting } from "./db-test-helpers.js";
import { describePg } from "./pg-test-db.js";

type ConversationSummary = {
  id: string;
  title: string;
  displayOrder?: number | null;
  isPinned?: boolean;
  forkParent?: {
    conversationId: string;
    messageId: string;
    title: string;
  };
};

describePg("conversation lineage in HTTP reads", () => {
  let server: RuntimeHttpServer | null = null;

  beforeEach(async () => {
    await server?.stop();
    server = null;
    await clearTables();
  });

  afterAll(async () => {
    await server?.stop();
    resetDbForTesting();
  });

  test("GET /v1/conversations returns forkParent for surviving parents", async () => {
    const { child, parent } = await seedForkedConversation();
    await startServer();

    const response = await fetch(url("/conversations"));
    expect(response.status).toBe(200);

    const body = (await response.json()) as {
      conversations: ConversationSummary[];
      hasMore: boolean;
    };
    const listedChild = body.conversations.find((item) => item.id === child.id);

    expect(listedChild).toMatchObject({
      id: child.id,
      title: child.title ?? "Untitled",
      forkParent: {
        conversationId: parent.id,
        messageId: "parent-msg-1",
        title: parent.title ?? "Untitled",
      },
    });
    expect(body.hasMore).toBe(false);
  });

  test("GET /v1/conversations/:id returns forkParent for surviving parents", async () => {
    const { child, parent } = await seedForkedConversation();
    await startServer();

    const response = await fetch(url(`/conversations/${child.id}`));
    expect(response.status).toBe(200);

    const body = (await response.json()) as {
      conversation: ConversationSummary;
    };

    expect(body.conversation).toMatchObject({
      id: child.id,
      title: child.title ?? "Untitled",
      forkParent: {
        conversationId: parent.id,
        messageId: "parent-msg-1",
        title: parent.title ?? "Untitled",
      },
    });
  });

  test("GET /v1/conversations/:id includes pin metadata when present", async () => {
    const conversation = await createConversation("Pinned conversation");
    await batchSetConversationPlacement([
      { id: conversation.id, isPinned: true },
    ]);
    await startServer();

    const response = await fetch(url(`/conversations/${conversation.id}`));
    expect(response.status).toBe(200);

    const body = (await response.json()) as {
      conversation: ConversationSummary;
    };

    expect(body.conversation).toMatchObject({
      id: conversation.id,
      title: conversation.title ?? "Untitled",
      isPinned: true,
    });
  });

  test("GET /v1/conversations/:id resolves the parent's current title at read time", async () => {
    const { child, parent } = await seedForkedConversation({
      parentTitle: "Original parent title",
    });
    await updateConversationTitle(parent.id, "Renamed parent title", 0);
    await startServer();

    const response = await fetch(url(`/conversations/${child.id}`));
    expect(response.status).toBe(200);

    const body = (await response.json()) as {
      conversation: ConversationSummary;
    };

    expect(body.conversation.forkParent).toEqual({
      conversationId: parent.id,
      messageId: "parent-msg-1",
      title: "Renamed parent title",
    });
  });

  test("deleted parents are omitted from list and detail responses", async () => {
    const { child, parent } = await seedForkedConversation();
    await requireMainDb().run("DELETE FROM conversations WHERE id = ?", [
      parent.id,
    ]);
    await startServer();

    const listResponse = await fetch(url("/conversations"));
    expect(listResponse.status).toBe(200);
    const listBody = (await listResponse.json()) as {
      conversations: ConversationSummary[];
    };
    const listedChild = listBody.conversations.find(
      (item) => item.id === child.id,
    );
    expect(listedChild).toBeDefined();
    expect(listedChild?.forkParent).toBeUndefined();

    const detailResponse = await fetch(url(`/conversations/${child.id}`));
    expect(detailResponse.status).toBe(200);
    const detailBody = (await detailResponse.json()) as {
      conversation: ConversationSummary;
    };
    expect(detailBody.conversation.forkParent).toBeUndefined();
  });

  async function clearTables(): Promise<void> {
    const db = requireMainDb();
    await db.run("DELETE FROM conversation_assistant_attention_state");
    await db.run("DELETE FROM external_conversation_bindings");
    await db.run("DELETE FROM conversation_keys");
    await db.run("DELETE FROM messages");
    await db.run("DELETE FROM conversations");
  }

  async function seedForkedConversation(opts?: { parentTitle?: string }) {
    const parent = await createConversation(
      opts?.parentTitle ?? "Parent conversation",
    );
    const child = await createConversation("Forked conversation");

    await requireMainDb().run(
      `
        UPDATE conversations
        SET fork_parent_conversation_id = ?, fork_parent_message_id = ?
        WHERE id = ?
      `,
      [parent.id, "parent-msg-1", child.id],
    );

    return { parent, child };
  }

  async function startServer(): Promise<void> {
    server = new RuntimeHttpServer({
      port: 0,
    });
    await server.start();
  }

  function url(pathname: string): string {
    if (!server) {
      throw new Error("server not started");
    }
    return `http://127.0.0.1:${server.actualPort}/v1${pathname}`;
  }
});
