/**
 * IPC routes for skill capability grants.
 *
 * Two methods, with deliberately different powers:
 *
 * - `get_skill_grants` reads the store. The assistant mounts the gateway IPC
 *   socket, so every method registered here is reachable from the daemon; this
 *   one is a read and answers fail-closed (an unreadable store resolves to an
 *   empty list, never an error the assistant could retry into a grant).
 * - `declare_skill_versions` says which skill versions the assistant currently
 *   has on disk. It is a write, but only of facts: the gateway applies its own
 *   defaults document to versions that have no decision yet and never touches
 *   an existing or revoked one. The assistant cannot name a capability through
 *   it, so the defaults stay the gateway's policy.
 *
 * Granting and revoking live on the scoped HTTP routes
 * (`http/routes/skill-grants.ts`) behind `settings.write`.
 */

import { z } from "zod";

import {
  skillIdSchema,
  versionHashSchema,
} from "../db/skill-grant-defaults.js";
import { seedSkillGrantsFromDefaults } from "../db/skill-grant-seed.js";
import { listSkillGrantsSafe } from "../db/skill-grant-store.js";
import { ipcRoute } from "./server.js";

const GetSkillGrantsSchema = z.object({
  skillId: z.string().trim().min(1).optional(),
  versionHash: z.string().trim().min(1).optional(),
});

/**
 * One declaration per installed skill. The cap is generous against the shipped
 * catalog (tens of skills) while keeping a single call bounded.
 */
const DeclareSkillVersionsSchema = z.object({
  skills: z
    .array(
      z.object({
        skillId: skillIdSchema,
        versionHash: versionHashSchema,
      }),
    )
    .max(500),
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
  ipcRoute({
    method: "declare_skill_versions",
    schema: DeclareSkillVersionsSchema,
    handler: (params) => seedSkillGrantsFromDefaults(params.skills),
  }),
];
