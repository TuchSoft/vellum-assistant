/**
 * Skill capability grant endpoints.
 *
 * Reads and writes over the gateway-owned `skill_grants` store. Writes are the
 * only way a capability is ever granted: the assistant reaches the store
 * through a read-only IPC method, so widening a grant always came through
 * here, behind a `settings.write` token.
 *
 * A grant is identified by `(skillId, versionHash)`. The version hash is
 * required on write and on delete; reading by skill id returns every version
 * of that skill, which is what an editor needs to show the current state.
 */

import { SkillCapabilitySchema } from "@vellumai/service-contracts/skill-capabilities";
import { z } from "zod";

import {
  deleteSkillGrant,
  listSkillGrants,
  upsertSkillGrant,
} from "../../db/skill-grant-store.js";
import { getLogger } from "../../logger.js";
import { readJsonObjectBody } from "../route-helpers.js";

const log = getLogger("skill-grants");

const MAX_BODY_BYTES = 64 * 1024;

/**
 * Skill ids are directory basenames. Reject separators so an id can never
 * address a path outside the skills directory.
 */
const SkillIdSchema = z
  .string()
  .trim()
  .min(1)
  .max(200)
  .refine((value) => !value.includes("/") && !value.includes("\\"), {
    message: "skillId must not contain a path separator",
  });

const VersionHashSchema = z.string().trim().min(1).max(200);

const PutSkillGrantSchema = z.object({
  versionHash: VersionHashSchema,
  capabilities: z.array(SkillCapabilitySchema),
  grantedBy: z.string().trim().min(1).max(200).optional(),
});

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function decodePathParam(value: string | undefined): string | null {
  if (!value) return null;
  try {
    return decodeURIComponent(value);
  } catch {
    return null;
  }
}

function validationError(error: z.ZodError): Response {
  const first = error.issues[0];
  const path = first?.path.join(".");
  const message = first?.message ?? "invalid request body";
  return Response.json(
    { error: path ? `${path}: ${message}` : message },
    { status: 400 },
  );
}

function badRequest(message: string): Response {
  return Response.json({ error: message }, { status: 400 });
}

function internalError(err: unknown, message: string): Response {
  log.error({ err }, message);
  return Response.json({ error: "Internal server error" }, { status: 500 });
}

// ---------------------------------------------------------------------------
// GET /v1/permissions/skill-grants — every grant
// ---------------------------------------------------------------------------

export function createSkillGrantListHandler() {
  return async (_req: Request): Promise<Response> => {
    try {
      return Response.json({ grants: listSkillGrants() });
    } catch (err) {
      return internalError(err, "Failed to list skill grants");
    }
  };
}

// ---------------------------------------------------------------------------
// GET /v1/permissions/skill-grants/:skillId — every version of one skill
// ---------------------------------------------------------------------------

export function createSkillGrantGetHandler() {
  return async (_req: Request, params: string[]): Promise<Response> => {
    const skillId = decodePathParam(params[0]);
    const parsedSkillId = SkillIdSchema.safeParse(skillId);
    if (!parsedSkillId.success) {
      return badRequest(
        parsedSkillId.error.issues[0]?.message ?? "invalid skillId",
      );
    }

    try {
      return Response.json({
        grants: listSkillGrants({ skillId: parsedSkillId.data }),
      });
    } catch (err) {
      return internalError(err, "Failed to read skill grants");
    }
  };
}

// ---------------------------------------------------------------------------
// PUT /v1/permissions/skill-grants/:skillId — grant one skill version
// ---------------------------------------------------------------------------

export function createSkillGrantPutHandler() {
  return async (req: Request, params: string[]): Promise<Response> => {
    const skillId = decodePathParam(params[0]);
    const parsedSkillId = SkillIdSchema.safeParse(skillId);
    if (!parsedSkillId.success) {
      return badRequest(
        parsedSkillId.error.issues[0]?.message ?? "invalid skillId",
      );
    }

    const body = await readJsonObjectBody(req, MAX_BODY_BYTES);
    if (body instanceof Response) {
      return body;
    }

    const parsedBody = PutSkillGrantSchema.safeParse(body);
    if (!parsedBody.success) {
      return validationError(parsedBody.error);
    }

    try {
      const grant = upsertSkillGrant({
        skillId: parsedSkillId.data,
        versionHash: parsedBody.data.versionHash,
        capabilities: parsedBody.data.capabilities,
        grantedBy: parsedBody.data.grantedBy ?? null,
      });
      return Response.json({ grant });
    } catch (err) {
      return internalError(err, "Failed to write skill grant");
    }
  };
}

// ---------------------------------------------------------------------------
// DELETE /v1/permissions/skill-grants/:skillId?versionHash=…
// ---------------------------------------------------------------------------

export function createSkillGrantDeleteHandler() {
  return async (req: Request, params: string[]): Promise<Response> => {
    const skillId = decodePathParam(params[0]);
    const parsedSkillId = SkillIdSchema.safeParse(skillId);
    if (!parsedSkillId.success) {
      return badRequest(
        parsedSkillId.error.issues[0]?.message ?? "invalid skillId",
      );
    }

    const versionHash = new URL(req.url).searchParams.get("versionHash");
    const parsedVersionHash = VersionHashSchema.safeParse(versionHash);
    if (!parsedVersionHash.success) {
      return badRequest("versionHash is required");
    }

    try {
      deleteSkillGrant(parsedSkillId.data, parsedVersionHash.data);
      // 204 No Content — idempotent, succeeds even if no grant existed.
      return new Response(null, { status: 204 });
    } catch (err) {
      return internalError(err, "Failed to delete skill grant");
    }
  };
}
