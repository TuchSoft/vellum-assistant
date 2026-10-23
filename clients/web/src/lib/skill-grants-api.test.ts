/**
 * Gateway skill grant client.
 *
 * The gateway is mocked at the shared client boundary so the tests pin the
 * request shape (path encoding, body, query) and the response validation the
 * settings card relies on.
 */

import { afterEach, describe, expect, mock, test } from "bun:test";

import { client } from "@/generated/gateway/client.gen";
import {
  deleteSkillGrant,
  listSkillGrants,
  putSkillGrant,
  type SkillGrant,
} from "@/lib/skill-grants-api";
import { ApiError } from "@/utils/api-errors";

const GRANT: SkillGrant = {
  skillId: "long-run",
  versionHash: "v1:abc123",
  capabilities: ["host_exec", "vetted"],
  grantedBy: "defaults",
  createdAt: 1,
  updatedAt: 2,
};

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

describe("skill grants client", () => {
  const originalGet = client.get;
  const originalPut = client.put;
  const originalDelete = client.delete;

  afterEach(() => {
    client.get = originalGet;
    client.put = originalPut;
    client.delete = originalDelete;
  });

  test("lists grants and validates the payload", async () => {
    const calls: unknown[] = [];
    client.get = mock(async (options: unknown) => {
      calls.push(options);
      return {
        data: { grants: [GRANT] },
        error: null,
        response: jsonResponse({}),
      };
    }) as typeof client.get;

    const grants = await listSkillGrants();

    expect(grants).toEqual([GRANT]);
    expect(calls).toEqual([
      expect.objectContaining({ url: "/v1/permissions/skill-grants" }),
    ]);
  });

  test("rejects an unreadable list payload", async () => {
    client.get = mock(async () => ({
      data: { grants: [{ skillId: "long-run" }] },
      error: null,
      response: jsonResponse({}),
    })) as typeof client.get;

    await expect(listSkillGrants()).rejects.toThrow(ApiError);
  });

  test("surfaces the gateway error message", async () => {
    client.get = mock(async () => ({
      data: undefined,
      error: { error: "Internal server error" },
      response: jsonResponse({ error: "Internal server error" }, 500),
    })) as typeof client.get;

    await expect(listSkillGrants()).rejects.toThrow("Internal server error");
  });

  test("writes a grant with the encoded skill id", async () => {
    const calls: unknown[] = [];
    client.put = mock(async (options: unknown) => {
      calls.push(options);
      return {
        data: { grant: { ...GRANT, capabilities: ["host_exec"] } },
        error: null,
        response: jsonResponse({}),
      };
    }) as typeof client.put;

    const grant = await putSkillGrant({
      skillId: "org/repo skill",
      versionHash: "v1:abc123",
      capabilities: ["host_exec"],
    });

    expect(grant.capabilities).toEqual(["host_exec"]);
    expect(calls).toEqual([
      expect.objectContaining({
        url: "/v1/permissions/skill-grants/org%2Frepo%20skill",
        body: {
          versionHash: "v1:abc123",
          capabilities: ["host_exec"],
          grantedBy: "settings-ui",
        },
      }),
    ]);
  });

  test("revokes a grant with the version in the query string", async () => {
    const calls: unknown[] = [];
    client.delete = mock(async (options: unknown) => {
      calls.push(options);
      return {
        data: undefined,
        error: null,
        response: new Response(null, { status: 204 }),
      };
    }) as typeof client.delete;

    await deleteSkillGrant("long-run", "v1:abc123");

    expect(calls).toEqual([
      expect.objectContaining({
        url: "/v1/permissions/skill-grants/long-run",
        query: { versionHash: "v1:abc123" },
      }),
    ]);
  });

  test("treats a failed revoke as an error", async () => {
    client.delete = mock(async () => ({
      data: undefined,
      error: { error: "Forbidden" },
      response: jsonResponse({ error: "Forbidden" }, 403),
    })) as typeof client.delete;

    await expect(deleteSkillGrant("long-run", "v1:abc123")).rejects.toThrow(
      "Forbidden",
    );
  });
});
