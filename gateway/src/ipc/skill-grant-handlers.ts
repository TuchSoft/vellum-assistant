/**
 * IPC route for reading skill capability grants.
 *
 * Read-only by design. The assistant mounts the gateway IPC socket, so every
 * method registered here is reachable from the daemon; granting lives on the
 * scoped HTTP routes (`http/routes/skill-grants.ts`) behind `settings.write`.
 * There is deliberately no IPC write method.
 *
 * The response is fail-closed: an unreadable store resolves to an empty list,
 * so the assistant denies every capability instead of receiving an error it
 * might treat as retryable.
 */

import { z } from "zod";

import { listSkillGrantsSafe } from "../db/skill-grant-store.js";
import { ipcRoute } from "./server.js";

const GetSkillGrantsSchema = z.object({
  skillId: z.string().trim().min(1).optional(),
  versionHash: z.string().trim().min(1).optional(),
});

export const skillGrantRoutes = [
  ipcRoute({
    method: "get_skill_grants",
    schema: GetSkillGrantsSchema,
    handler: (params) => ({
      grants: listSkillGrantsSafe({
        skillId: params.skillId,
        versionHash: params.versionHash,
      }),
    }),
  }),
];
