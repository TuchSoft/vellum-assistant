/**
 * Tests for the conversation surface API — the explicit opt-in that promotes
 * a background/scheduled conversation into the default ("standard")
 * conversation listing so clients show it in the Recents sidebar grouping.
 *
 * Exercises:
 *  - POST /v1/conversations/:id/surface (set + clear, validation, 404)
 *  - GET  /v1/conversations default listing inclusion of surfaced rows
 *  - GET  /v1/conversations?conversationType=background|scheduled unchanged
 */

import { beforeEach, expect, mock, test } from "bun:test";

// Stub the event hub to avoid spinning up real SSE infrastructure.
mock.module("../../assistant-event-hub.js", () => ({
  assistantEventHub: {
    publish: async () => {},
    subscribe: () => () => {},
  },
  broadcastMessage: () => {},
}));

// Spy on the sync publish so we can assert the invalidation fires after a
// successful write without standing up the real broadcast machinery.
const publishedListAndMetadata: Array<{
  reason: string;
  conversationIds: string | string[];
}> = [];
mock.module("../../sync/resource-sync-events.js", () => ({
  publishConversationListChanged: () => {},
  publishConversationTitleChanged: () => {},
  publishConversationListAndMetadataChanged: (
    reason: string,
    conversationIds: string | string[],
  ) => {
    publishedListAndMetadata.push({ reason, conversationIds });
  },
}));

import { describePg } from "../../../__tests__/pg-test-db.js";
import {
  createConversation,
  getConversation,
} from "../../../persistence/conversation-crud.js";
import { requireMainDb } from "../../../persistence/db-facade.js";
import { ROUTES as CONVERSATION_LIST_ROUTES } from "../conversation-list-routes.js";
import { ROUTES as CONVERSATION_MANAGEMENT_ROUTES } from "../conversation-management-routes.js";
import { BadRequestError, NotFoundError } from "../errors.js";
import type { RouteDefinition } from "../types.js";

// ---------------------------------------------------------------------------
// DB bootstrap
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function findHandler(routes: RouteDefinition[], operationId: string) {
  const route = routes.find((r) => r.operationId === operationId);
  if (!route) {
    throw new Error(`Route ${operationId} not found`);
  }
  return route.handler;
}

const surfaceHandler = findHandler(
  CONVERSATION_MANAGEMENT_ROUTES,
  "surfaceConversation",
);
const listHandler = findHandler(CONVERSATION_LIST_ROUTES, "listConversations");
const reorderHandler = findHandler(
  CONVERSATION_MANAGEMENT_ROUTES,
  "reorderConversations",
);

interface SurfaceResponse {
  ok: boolean;
  conversationId: string;
  surfacedAt: number | null;
}

interface ConversationSummary {
  id: string;
  title: string;
  conversationType: string;
  surfacedAt?: number;
}

interface ListResponse {
  conversations: ConversationSummary[];
  nextOffset: number;
  hasMore: boolean;
}

async function clearConversations(): Promise<void> {
  await requireMainDb().run("DELETE FROM conversations");
}

async function seed(
  title: string,
  conversationType: "standard" | "background" | "scheduled",
): Promise<string> {
  return (await createConversation({ title, conversationType, source: "test" }))
    .id;
}

async function listIds(
  queryParams: Record<string, string> = {},
): Promise<string[]> {
  const response = (await listHandler({ queryParams })) as ListResponse;
  return response.conversations.map((c) => c.id);
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describePg("POST /v1/conversations/:id/surface", () => {
  beforeEach(async () => {
    await clearConversations();
    publishedListAndMetadata.length = 0;
  });

  test("surfaces a background conversation and returns the timestamp", async () => {
    const id = await seed("Background run", "background");
    const before = Date.now();
    const response = (await surfaceHandler({
      pathParams: { id },
      body: { surfaced: true },
    })) as SurfaceResponse;
    expect(response.ok).toBe(true);
    expect(response.conversationId).toBe(id);
    expect(response.surfacedAt).toBeGreaterThanOrEqual(before);
  });

  test("publishes a shape-changing list invalidation after the write", async () => {
    const id = await seed("Background run", "background");
    await surfaceHandler({ pathParams: { id }, body: { surfaced: true } });
    expect(publishedListAndMetadata).toEqual([
      { reason: "reordered", conversationIds: id },
    ]);
  });

  test("clearing returns surfacedAt null", async () => {
    const id = await seed("Background run", "background");
    await surfaceHandler({ pathParams: { id }, body: { surfaced: true } });
    const response = (await surfaceHandler({
      pathParams: { id },
      body: { surfaced: false },
    })) as SurfaceResponse;
    expect(response.surfacedAt).toBeNull();
  });

  test("404s for an unknown conversation id", async () => {
    await expect(
      surfaceHandler({
        pathParams: { id: crypto.randomUUID() },
        body: { surfaced: true },
      }),
    ).rejects.toThrow(NotFoundError);
  });

  test("400s when surfaced is missing or not a boolean", async () => {
    const id = await seed("Background run", "background");
    await expect(
      surfaceHandler({ pathParams: { id }, body: {} }),
    ).rejects.toThrow(BadRequestError);
    await expect(
      surfaceHandler({ pathParams: { id }, body: { surfaced: "yes" } }),
    ).rejects.toThrow(BadRequestError);
  });
});

describePg(
  "GET /v1/conversations — surfaced rows in the default listing",
  () => {
    beforeEach(async () => {
      await clearConversations();
      publishedListAndMetadata.length = 0;
    });

    test("background/scheduled rows stay out of the default listing until surfaced", async () => {
      const standardId = await seed("Standard chat", "standard");
      await seed("Background run", "background");
      await seed("Scheduled run", "scheduled");
      expect(await listIds()).toEqual([standardId]);
    });

    test("surfacing promotes a background conversation into the default listing", async () => {
      const standardId = await seed("Standard chat", "standard");
      const backgroundId = await seed("Background run", "background");
      await surfaceHandler({
        pathParams: { id: backgroundId },
        body: { surfaced: true },
      });

      const response = (await listHandler({ queryParams: {} })) as ListResponse;
      expect(response.conversations.map((c) => c.id).sort()).toEqual(
        [standardId, backgroundId].sort(),
      );
      const surfaced = response.conversations.find(
        (c) => c.id === backgroundId,
      )!;
      expect(surfaced.conversationType).toBe("background");
      expect(surfaced.surfacedAt).toBeGreaterThan(0);
      const standard = response.conversations.find((c) => c.id === standardId)!;
      expect(standard.surfacedAt).toBeUndefined();
    });

    test("surfacing promotes a scheduled conversation into the default listing", async () => {
      const scheduledId = await seed("Scheduled run", "scheduled");
      await surfaceHandler({
        pathParams: { id: scheduledId },
        body: { surfaced: true },
      });
      expect(await listIds()).toEqual([scheduledId]);
    });

    test("clearing the promotion removes the row from the default listing again", async () => {
      const backgroundId = await seed("Background run", "background");
      await surfaceHandler({
        pathParams: { id: backgroundId },
        body: { surfaced: true },
      });
      expect(await listIds()).toEqual([backgroundId]);

      await surfaceHandler({
        pathParams: { id: backgroundId },
        body: { surfaced: false },
      });
      expect(await listIds()).toEqual([]);
    });

    test("filtered background/scheduled listings keep returning surfaced rows", async () => {
      const backgroundId = await seed("Background run", "background");
      const scheduledId = await seed("Scheduled run", "scheduled");
      await surfaceHandler({
        pathParams: { id: backgroundId },
        body: { surfaced: true },
      });
      await surfaceHandler({
        pathParams: { id: scheduledId },
        body: { surfaced: true },
      });

      // "background" is the back-compat umbrella (background + scheduled).
      expect(
        (await listIds({ conversationType: "background" })).sort(),
      ).toEqual([backgroundId, scheduledId].sort());
      expect(await listIds({ conversationType: "scheduled" })).toEqual([
        scheduledId,
      ]);
    });

    test("moving a surfaced conversation to system:background clears the promotion", async () => {
      const backgroundId = await seed("Background run", "background");
      await surfaceHandler({
        pathParams: { id: backgroundId },
        body: { surfaced: true },
      });
      expect(await listIds()).toEqual([backgroundId]);

      // Move-to-Group sends only groupId/isPinned through the reorder
      // endpoint — the demotion out of Recents must happen in the same
      // server-side write, with no second API call from the client.
      await reorderHandler({
        body: {
          updates: [
            { conversationId: backgroundId, groupId: "system:background" },
          ],
        },
      });

      expect((await getConversation(backgroundId))?.surfacedAt).toBeNull();
      expect(await listIds()).toEqual([]);
      expect(await listIds({ conversationType: "background" })).toEqual([
        backgroundId,
      ]);
    });

    test("moving a surfaced conversation to system:scheduled clears the promotion", async () => {
      const scheduledId = await seed("Scheduled run", "scheduled");
      await surfaceHandler({
        pathParams: { id: scheduledId },
        body: { surfaced: true },
      });
      expect(await listIds()).toEqual([scheduledId]);

      await reorderHandler({
        body: {
          updates: [
            { conversationId: scheduledId, groupId: "system:scheduled" },
          ],
        },
      });

      expect((await getConversation(scheduledId))?.surfacedAt).toBeNull();
      expect(await listIds()).toEqual([]);
    });

    test("moving a surfaced conversation to a non-demoting group keeps the promotion", async () => {
      const backgroundId = await seed("Background run", "background");
      await surfaceHandler({
        pathParams: { id: backgroundId },
        body: { surfaced: true },
      });

      await reorderHandler({
        body: {
          updates: [{ conversationId: backgroundId, groupId: "system:all" }],
        },
      });

      expect((await getConversation(backgroundId))?.surfacedAt).toBeGreaterThan(
        0,
      );
    });

    test("archived surfaced rows stay out of the default (active) listing", async () => {
      const backgroundId = await seed("Background run", "background");
      await surfaceHandler({
        pathParams: { id: backgroundId },
        body: { surfaced: true },
      });
      await requireMainDb().run("UPDATE conversations SET archived_at = ?", [
        Date.now(),
      ]);
      expect(await listIds()).toEqual([]);
    });
  },
);
