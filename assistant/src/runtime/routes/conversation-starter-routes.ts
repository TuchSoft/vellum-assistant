/**
 * Route handlers for conversation starter endpoints.
 *
 * Conversation starter chips are permanently disabled by custom patch 06:
 * the list endpoint returns an empty set and never enqueues a generation
 * job, so no LLM call happens for this feature. DELETE is kept for API
 * compatibility so stale rows persisted by earlier versions can still be
 * removed.
 */

import { and, eq } from "drizzle-orm";
import { z } from "zod";

import { requireMainDb } from "../../persistence/db-facade.js";
import { ACTOR_PRINCIPALS } from "../auth/route-policy.js";
import { NotFoundError } from "./errors.js";
import type { RouteDefinition, RouteHandlerArgs } from "./types.js";

const starterItemSchema = z.object({
  id: z.string(),
  label: z.string(),
  prompt: z.string(),
  category: z.string().nullable(),
  batch: z.number().int(),
});

type StarterItem = z.infer<typeof starterItemSchema>;

/**
 * Stale-after TTL for a conversation starter batch. Kept exported for API
 * compatibility; generation is disabled, so nothing refreshes against it.
 */
export const CONVERSATION_STARTERS_STALE_TTL_MS = 4 * 60 * 60 * 1000;

/**
 * Re-order starters so adjacent items have distinct categories wherever
 * possible. Within each category, preserve the original (batch-desc) order.
 * This is deterministic; same input always produces the same output.
 */
export function orderStrongestFirst<T extends StarterItem>(items: T[]): T[] {
  if (items.length <= 1) {
    return items;
  }

  const byCategory = new Map<string, T[]>();
  for (const item of items) {
    const cat = item.category ?? "other";
    let group = byCategory.get(cat);
    if (!group) {
      group = [];
      byCategory.set(cat, group);
    }
    group.push(item);
  }

  const sortedGroups = [...byCategory.entries()]
    .sort((a, b) => b[1].length - a[1].length)
    .map(([, group]) => ({ items: group, idx: 0 }));

  const result: T[] = [];
  const seenCategories = new Set<string>();
  let lastCategory: string | null = null;

  while (result.length < items.length) {
    let picked = false;
    const availableGroups = sortedGroups.filter(
      (group) => group.idx < group.items.length,
    );

    const unseenGroups = availableGroups.filter((group) => {
      const category = group.items[group.idx]?.category ?? "other";
      return category !== lastCategory && !seenCategories.has(category);
    });

    const nextGroups =
      unseenGroups.length > 0
        ? unseenGroups
        : availableGroups.filter((group) => {
            const category = group.items[group.idx]?.category ?? "other";
            return category !== lastCategory;
          });

    for (const group of nextGroups) {
      if (group.idx >= group.items.length) {
        continue;
      }
      const candidate = group.items[group.idx];
      const cat = candidate.category ?? "other";
      result.push(candidate);
      group.idx++;
      seenCategories.add(cat);
      lastCategory = cat;
      picked = true;
      break;
    }

    if (!picked) {
      for (const group of availableGroups) {
        if (group.idx < group.items.length) {
          const candidate = group.items[group.idx];
          const cat = candidate.category ?? "other";
          result.push(candidate);
          group.idx++;
          seenCategories.add(cat);
          lastCategory = cat;
          picked = true;
          break;
        }
      }
    }

    if (!picked) {
      break;
    }
  }

  return result;
}

// ---------------------------------------------------------------------------
// Handlers
// ---------------------------------------------------------------------------

function handleListConversationStarters(_args: RouteHandlerArgs) {
  // Permanently disabled (custom patch 06): never serve starter chips and
  // never enqueue a generation job, so no LLM call happens for this feature.
  // Rows persisted by earlier versions are left untouched but are never
  // listed.
  return { starters: [], total: 0, status: "empty" };
}

async function handleDeleteConversationStarter({
  pathParams = {},
}: RouteHandlerArgs) {
  const starterId = pathParams.id;
  const db = requireMainDb();
  const starters = db.schema.conversationStarters;
  const existing = await db.orm
    .select({ id: starters.id })
    .from(starters)
    .where(and(eq(starters.id, starterId), eq(starters.cardType, "chip")))
    .limit(1);

  if (existing.length === 0) {
    throw new NotFoundError(`Conversation starter not found: ${starterId}`);
  }

  await db.orm
    .delete(starters)
    .where(and(eq(starters.id, starterId), eq(starters.cardType, "chip")));

  return { deleted: true, id: starterId };
}

// ---------------------------------------------------------------------------
// Route definitions
// ---------------------------------------------------------------------------

export const ROUTES: RouteDefinition[] = [
  {
    operationId: "conversation_starters_list",
    endpoint: "conversation-starters",
    method: "GET",
    policy: {
      requiredScopes: ["chat.read"],
      allowedPrincipalTypes: ACTOR_PRINCIPALS,
    },
    handler: handleListConversationStarters,
    summary: "List conversation starters",
    description:
      "Return conversation starter chips, ordered for category diversity.",
    tags: ["conversation-starters"],
    queryParams: [
      {
        name: "limit",
        type: "integer",
        description: "Max starters to return (1–20, default 4)",
      },
      {
        name: "offset",
        type: "integer",
        description: "Pagination offset (default 0)",
      },
    ],
    responseBody: z.object({
      starters: z
        .array(starterItemSchema)
        .describe("Ordered list of starter chips"),
      total: z.number().int().describe("Total number of available starters"),
      status: z
        .enum(["ready", "refreshing", "empty", "generating"])
        .describe("One of: ready, refreshing, empty, generating"),
    }),
  },
  {
    operationId: "conversation_starters_delete",
    endpoint: "conversation-starters/:id",
    method: "DELETE",
    policy: {
      requiredScopes: ["chat.write"],
      allowedPrincipalTypes: ACTOR_PRINCIPALS,
    },
    handler: handleDeleteConversationStarter,
    summary: "Delete conversation starter",
    description:
      "Remove a generated conversation starter chip from the current starter set.",
    tags: ["conversation-starters"],
    responseBody: z.object({
      deleted: z.boolean(),
      id: z.string(),
    }),
    additionalResponses: {
      "404": {
        description: "Conversation starter not found",
      },
    },
  },
];
