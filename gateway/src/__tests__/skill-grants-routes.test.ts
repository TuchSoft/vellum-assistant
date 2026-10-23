/**
 * Tests for the skill capability grant HTTP handlers.
 *
 * The handlers are driven directly, following the auto-approve threshold
 * tests. Authorization (scope enforcement) is covered by the source-level
 * assertion in `skill-grants-route-auth.test.ts`.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";

import {
  getGatewayDb,
  initGatewayDb,
  resetGatewayDb,
} from "../db/connection.js";
import { skillGrants } from "../db/schema.js";
import {
  createSkillGrantDeleteHandler,
  createSkillGrantGetHandler,
  createSkillGrantListHandler,
  createSkillGrantPutHandler,
} from "../http/routes/skill-grants.js";
import "./test-preload.js";

beforeEach(async () => {
  resetGatewayDb();
  await initGatewayDb();
  getGatewayDb().delete(skillGrants).run();
});

afterEach(() => {
  resetGatewayDb();
});

function putRequest(skillId: string, body?: unknown): Request {
  return new Request(
    `http://localhost/v1/permissions/skill-grants/${skillId}`,
    {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    },
  );
}

function deleteRequest(skillId: string, versionHash?: string): Request {
  const query = versionHash
    ? `?versionHash=${encodeURIComponent(versionHash)}`
    : "";
  return new Request(
    `http://localhost/v1/permissions/skill-grants/${skillId}${query}`,
    { method: "DELETE" },
  );
}

describe("GET /v1/permissions/skill-grants", () => {
  test("returns an empty list when nothing is granted", async () => {
    const res = await createSkillGrantListHandler()(
      new Request("http://localhost/v1/permissions/skill-grants"),
    );

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ grants: [] });
  });

  test("returns every grant after a write", async () => {
    await createSkillGrantPutHandler()(
      putRequest("long-run", {
        versionHash: "hash-1",
        capabilities: ["host_exec"],
      }),
      ["long-run"],
    );

    const res = await createSkillGrantListHandler()(
      new Request("http://localhost/v1/permissions/skill-grants"),
    );
    const body = (await res.json()) as { grants: Array<{ skillId: string }> };

    expect(body.grants).toHaveLength(1);
    expect(body.grants[0]?.skillId).toBe("long-run");
  });
});

describe("GET /v1/permissions/skill-grants/:skillId", () => {
  test("returns only the requested skill's grants", async () => {
    const put = createSkillGrantPutHandler();
    await put(
      putRequest("long-run", { versionHash: "hash-1", capabilities: [] }),
      ["long-run"],
    );
    await put(
      putRequest("other", { versionHash: "hash-1", capabilities: [] }),
      ["other"],
    );

    const res = await createSkillGrantGetHandler()(
      new Request("http://localhost/v1/permissions/skill-grants/long-run"),
      ["long-run"],
    );
    const body = (await res.json()) as { grants: Array<{ skillId: string }> };

    expect(res.status).toBe(200);
    expect(body.grants.map((g) => g.skillId)).toEqual(["long-run"]);
  });

  test("returns an empty list for a skill with no grant", async () => {
    const res = await createSkillGrantGetHandler()(
      new Request("http://localhost/v1/permissions/skill-grants/unknown"),
      ["unknown"],
    );

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ grants: [] });
  });

  test("rejects a skill id containing a path separator", async () => {
    const res = await createSkillGrantGetHandler()(
      new Request("http://localhost/v1/permissions/skill-grants/..%2Fetc"),
      ["..%2Fetc"],
    );

    expect(res.status).toBe(400);
  });
});

describe("PUT /v1/permissions/skill-grants/:skillId", () => {
  test("grants capabilities and normalizes their order", async () => {
    const res = await createSkillGrantPutHandler()(
      putRequest("long-run", {
        versionHash: "hash-1",
        capabilities: ["vetted", "host_exec", "vetted"],
        grantedBy: "guardian-1",
      }),
      ["long-run"],
    );

    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      grant: { capabilities: string[]; grantedBy: string | null };
    };
    expect(body.grant.capabilities).toEqual(["host_exec", "vetted"]);
    expect(body.grant.grantedBy).toBe("guardian-1");
  });

  test("rejects a missing versionHash", async () => {
    const res = await createSkillGrantPutHandler()(
      putRequest("long-run", { capabilities: ["host_exec"] }),
      ["long-run"],
    );

    expect(res.status).toBe(400);
    expect(((await res.json()) as { error: string }).error).toContain(
      "versionHash",
    );
  });

  test("rejects a capability outside the contract", async () => {
    const res = await createSkillGrantPutHandler()(
      putRequest("long-run", {
        versionHash: "hash-1",
        capabilities: ["auto_approve_low_risk"],
      }),
      ["long-run"],
    );

    expect(res.status).toBe(400);
  });

  test("rejects a non-JSON body", async () => {
    const res = await createSkillGrantPutHandler()(
      new Request("http://localhost/v1/permissions/skill-grants/long-run", {
        method: "PUT",
        body: "not json",
      }),
      ["long-run"],
    );

    expect(res.status).toBe(400);
  });

  test("rejects a blank skill id", async () => {
    const res = await createSkillGrantPutHandler()(
      putRequest("%20", {
        versionHash: "hash-1",
        capabilities: ["host_exec"],
      }),
      ["%20"],
    );

    expect(res.status).toBe(400);
  });
});

describe("DELETE /v1/permissions/skill-grants/:skillId", () => {
  test("removes the grant and is idempotent", async () => {
    await createSkillGrantPutHandler()(
      putRequest("long-run", {
        versionHash: "hash-1",
        capabilities: ["host_exec"],
      }),
      ["long-run"],
    );

    const handler = createSkillGrantDeleteHandler();
    const first = await handler(deleteRequest("long-run", "hash-1"), [
      "long-run",
    ]);
    expect(first.status).toBe(204);

    const second = await handler(deleteRequest("long-run", "hash-1"), [
      "long-run",
    ]);
    expect(second.status).toBe(204);

    const list = await createSkillGrantListHandler()(
      new Request("http://localhost/v1/permissions/skill-grants"),
    );
    expect(await list.json()).toEqual({ grants: [] });
  });

  test("requires versionHash", async () => {
    const res = await createSkillGrantDeleteHandler()(
      deleteRequest("long-run"),
      ["long-run"],
    );

    expect(res.status).toBe(400);
    expect(((await res.json()) as { error: string }).error).toContain(
      "versionHash",
    );
  });
});
