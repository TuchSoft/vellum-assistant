/**
 * Wake a conversation's agent loop with an opportunity hint.
 *
 * POST /v1/conversations/wake
 */

import { z } from "zod";

import { getConversation } from "../../persistence/conversation-crud.js";
import { getSchedule } from "../../schedule/schedule-store.js";
import { getLogger } from "../../util/logger.js";
import { wakeAgentForOpportunity } from "../agent-wake.js";
import { ACTOR_PRINCIPALS } from "../auth/route-policy.js";
import { NotFoundError } from "./errors.js";
import type { RouteDefinition } from "./types.js";

const log = getLogger("wake-conversation-routes");

const WakeConversationBody = z.object({
  conversationId: z.string().min(1),
  hint: z.string().min(1),
  source: z.string().default("cli"),
  // Dispatch the wake and return before the agent turn finishes. Honored only
  // for a `local` caller (see handler): a remote `actor` runs synchronously so
  // its response keeps carrying the turn's outcome.
  background: z.boolean().optional(),
  // Honored only for a `local` caller (see handler) — a remote `actor` could
  // otherwise attribute its wake's cost to an arbitrary firing.
  cronRunId: z.string().min(1).optional(),
  // Runs the turn on this schedule's pinned inference profile. Honored only for
  // a `local` caller (see handler): a remote `actor` could otherwise run turns
  // under an arbitrary schedule's profile and spend the owner's money.
  scheduleId: z.string().min(1).optional(),
  // Persist the trigger as a background event rather than an ephemeral hint, so
  // repeated wakes stay prompt-cache-friendly.
  persist: z.boolean().optional(),
  // Untrusted third-party data, fenced so the model treats it as data rather
  // than instructions. Only meaningful alongside `persist`.
  externalContent: z.string().optional(),
});

export const ROUTES: RouteDefinition[] = [
  {
    operationId: "wake_conversation",
    endpoint: "conversations/wake",
    method: "POST",
    policy: {
      requiredScopes: ["chat.write"],
      allowedPrincipalTypes: ACTOR_PRINCIPALS,
    },
    summary: "Wake a conversation",
    description:
      "Invoke the agent loop for a conversation with an opportunity hint.",
    tags: ["conversations"],
    requestBody: WakeConversationBody,
    responseBody: z.object({
      invoked: z.boolean(),
      producedToolCalls: z.boolean(),
      reason: z.string().optional(),
      // Present and true when the wake was accepted for background execution
      // and this response returned before the turn ran.
      dispatched: z.boolean().optional(),
    }),
    handler: async ({ body, headers }) => {
      const {
        conversationId,
        hint,
        source,
        background,
        cronRunId,
        scheduleId,
        persist,
        externalContent,
      } = WakeConversationBody.parse(body);

      const conversation = getConversation(conversationId);
      if (!conversation) {
        throw new NotFoundError(`Conversation not found: ${conversationId}`);
      }

      // A local IPC caller holds the owner's authority for the wake, but the
      // wake imposes no trust class of its own: `clientless` makes the turn
      // derive `isInteractive: false` (mapped to the `background` policy
      // context) so a side-effecting tool that would prompt is denied instead of
      // stalling on an absent client, while the turn runs under the target
      // conversation's own resting trust (`wakeAgentForOpportunity` recovers
      // it), so a wake never changes the permission model it lands in. A remote
      // `actor` (reachable via the gateway) stays `unknown`. The body's
      // `cronRunId` is trusted only from a local caller.
      const isLocal = headers?.["x-vellum-principal-type"] === "local";

      // A script-mode schedule hands off to the agent loop through this route,
      // so the schedule's pinned profile has to be applied here for the woken
      // turn to run on the model the schedule was created under.
      //
      // The pin applies per turn rather than as a durable conversation pin,
      // and it wins over the target conversation's own pin for turns the
      // schedule triggers. That matters because a script may wake any
      // conversation it names, not only the `scheduled` one it created:
      // waking an interactive chat runs that one turn on the schedule's
      // profile, while the user's own replies keep using their selection.
      // A schedule with no pin resolves as any other turn does.
      const scheduleProfile =
        isLocal && scheduleId
          ? (getSchedule(scheduleId)?.inferenceProfile ?? null)
          : null;

      const wakeOptions: Parameters<typeof wakeAgentForOpportunity>[0] = {
        conversationId,
        hint,
        source,
        ...(isLocal ? { clientless: true } : {}),
        ...(isLocal && cronRunId ? { cronRunId } : {}),
        ...(scheduleProfile ? { forceOverrideProfile: scheduleProfile } : {}),
        ...(persist ? { persistTriggerAsEvent: true } : {}),
        ...(externalContent !== undefined
          ? { untrustedOutput: { content: externalContent, source: "webhook" } }
          : {}),
      };

      // Background dispatch hands the wake to the agent loop without awaiting
      // the turn, so the caller returns before the turn's runtime can exceed
      // its transport budget. The turn keeps running in the daemon and its
      // outcome is observable through the conversation, not this response.
      // Honored only for a `local` caller (see `isLocal` above).
      if (background && isLocal) {
        void wakeAgentForOpportunity(wakeOptions).catch((err) => {
          log.warn(
            { err, conversationId },
            "wake_conversation: background dispatch failed",
          );
        });
        return { invoked: false, producedToolCalls: false, dispatched: true };
      }

      const result = await wakeAgentForOpportunity(wakeOptions);
      // Pin the wire shape to the declared responseBody: WakeResult carries
      // in-process diagnostics (exitReason) beyond this route's contract.
      return {
        invoked: result.invoked,
        producedToolCalls: result.producedToolCalls,
        ...(result.reason !== undefined ? { reason: result.reason } : {}),
      };
    },
  },
];
