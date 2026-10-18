import { beforeEach, expect, test } from "bun:test";

import {
  _internal,
  type CreateScopedApprovalGrantParams,
  expireScopedApprovalGrants,
  revokeScopedApprovalGrantsForContext,
} from "../approvals/scoped-approval-grants.js";
import { requireMainDb } from "../persistence/db-facade.js";
import { describePg } from "./pg-test-db.js";

const {
  consumeScopedApprovalGrantByRequestId,
  consumeScopedApprovalGrantByToolSignature,
  createScopedApprovalGrant,
} = _internal;
import {
  canonicalJsonSerialize,
  computeToolApprovalDigest,
} from "../security/tool-approval-digest.js";

async function clearTables(): Promise<void> {
  const db = requireMainDb();
  await db.orm.delete(db.schema.scopedApprovalGrants);
}

// ---------------------------------------------------------------------------
// Helper to build grant params with sensible defaults
// ---------------------------------------------------------------------------

function grantParams(
  overrides: Partial<CreateScopedApprovalGrantParams> = {},
): CreateScopedApprovalGrantParams {
  const futureExpiry = Date.now() + 60_000;
  return {
    scopeMode: "request_id",
    requestChannel: "telegram",
    decisionChannel: "telegram",
    expiresAt: futureExpiry,
    ...overrides,
  };
}

// ===========================================================================
// SCOPE MODE: request_id
// ===========================================================================

describePg("scoped-approval-grants / request_id scope", () => {
  beforeEach(async () => {
    await clearTables();
  });

  test("create and consume by request_id succeeds", async () => {
    const grant = await createScopedApprovalGrant(
      grantParams({ scopeMode: "request_id", requestId: "req-1" }),
    );
    expect(grant.status).toBe("active");
    expect(grant.requestId).toBe("req-1");

    const result = await consumeScopedApprovalGrantByRequestId(
      "req-1",
      "consumer-1",
    );
    expect(result.ok).toBe(true);
    expect(result.grant).not.toBeNull();
    expect(result.grant!.status).toBe("consumed");
    expect(result.grant!.consumedByRequestId).toBe("consumer-1");
  });

  test("second consume of same grant fails (one-time use)", async () => {
    await createScopedApprovalGrant(
      grantParams({ scopeMode: "request_id", requestId: "req-2" }),
    );

    const first = await consumeScopedApprovalGrantByRequestId(
      "req-2",
      "consumer-a",
    );
    expect(first.ok).toBe(true);

    const second = await consumeScopedApprovalGrantByRequestId(
      "req-2",
      "consumer-b",
    );
    expect(second.ok).toBe(false);
    expect(second.grant).toBeNull();
  });

  test("consume fails when no matching grant exists", async () => {
    const result = await consumeScopedApprovalGrantByRequestId(
      "nonexistent",
      "consumer-x",
    );
    expect(result.ok).toBe(false);
  });

  test("expired grant cannot be consumed", async () => {
    const pastExpiry = Date.now() - 1_000;
    await createScopedApprovalGrant(
      grantParams({
        scopeMode: "request_id",
        requestId: "req-expired",
        expiresAt: pastExpiry,
      }),
    );

    const result = await consumeScopedApprovalGrantByRequestId(
      "req-expired",
      "consumer-1",
    );
    expect(result.ok).toBe(false);
  });
});

// ===========================================================================
// SCOPE MODE: tool_signature
// ===========================================================================

describePg("scoped-approval-grants / tool_signature scope", () => {
  beforeEach(async () => {
    await clearTables();
  });

  test("create and consume by tool signature succeeds", async () => {
    const digest = computeToolApprovalDigest("bash", { cmd: "ls" });
    const grant = await createScopedApprovalGrant(
      grantParams({
        scopeMode: "tool_signature",
        toolName: "bash",
        inputDigest: digest,
      }),
    );
    expect(grant.status).toBe("active");
    expect(grant.toolName).toBe("bash");

    const result = await consumeScopedApprovalGrantByToolSignature({
      toolName: "bash",
      inputDigest: digest,
      consumingRequestId: "consumer-1",
    });
    expect(result.ok).toBe(true);
    expect(result.grant!.status).toBe("consumed");
  });

  test("second consume of tool_signature grant fails", async () => {
    const digest = computeToolApprovalDigest("bash", { cmd: "rm -rf" });
    await createScopedApprovalGrant(
      grantParams({
        scopeMode: "tool_signature",
        toolName: "bash",
        inputDigest: digest,
      }),
    );

    const first = await consumeScopedApprovalGrantByToolSignature({
      toolName: "bash",
      inputDigest: digest,
      consumingRequestId: "c1",
    });
    expect(first.ok).toBe(true);

    const second = await consumeScopedApprovalGrantByToolSignature({
      toolName: "bash",
      inputDigest: digest,
      consumingRequestId: "c2",
    });
    expect(second.ok).toBe(false);
  });

  test("mismatched input digest fails consume", async () => {
    const digest = computeToolApprovalDigest("bash", { cmd: "ls" });
    await createScopedApprovalGrant(
      grantParams({
        scopeMode: "tool_signature",
        toolName: "bash",
        inputDigest: digest,
      }),
    );

    const wrongDigest = computeToolApprovalDigest("bash", { cmd: "pwd" });
    const result = await consumeScopedApprovalGrantByToolSignature({
      toolName: "bash",
      inputDigest: wrongDigest,
      consumingRequestId: "c1",
    });
    expect(result.ok).toBe(false);
  });

  test("mismatched tool name fails consume", async () => {
    const digest = computeToolApprovalDigest("bash", { cmd: "ls" });
    await createScopedApprovalGrant(
      grantParams({
        scopeMode: "tool_signature",
        toolName: "bash",
        inputDigest: digest,
      }),
    );

    const result = await consumeScopedApprovalGrantByToolSignature({
      toolName: "python",
      inputDigest: digest,
      consumingRequestId: "c1",
    });
    expect(result.ok).toBe(false);
  });

  test("context constraint: executionChannel must match non-null grant field", async () => {
    const digest = computeToolApprovalDigest("bash", { cmd: "ls" });
    await createScopedApprovalGrant(
      grantParams({
        scopeMode: "tool_signature",
        toolName: "bash",
        inputDigest: digest,
        executionChannel: "telegram",
      }),
    );

    // Wrong channel
    const wrong = await consumeScopedApprovalGrantByToolSignature({
      toolName: "bash",
      inputDigest: digest,
      consumingRequestId: "c1",
      executionChannel: "phone",
    });
    expect(wrong.ok).toBe(false);

    // Correct channel
    const correct = await consumeScopedApprovalGrantByToolSignature({
      toolName: "bash",
      inputDigest: digest,
      consumingRequestId: "c2",
      executionChannel: "telegram",
    });
    expect(correct.ok).toBe(true);
  });

  test("null executionChannel on grant means any channel matches", async () => {
    const digest = computeToolApprovalDigest("bash", { cmd: "ls" });
    await createScopedApprovalGrant(
      grantParams({
        scopeMode: "tool_signature",
        toolName: "bash",
        inputDigest: digest,
        executionChannel: null,
      }),
    );

    const result = await consumeScopedApprovalGrantByToolSignature({
      toolName: "bash",
      inputDigest: digest,
      consumingRequestId: "c1",
      executionChannel: "phone",
    });
    expect(result.ok).toBe(true);
  });

  test("context constraint: conversationId must match non-null grant field", async () => {
    const digest = computeToolApprovalDigest("bash", { cmd: "ls" });
    await createScopedApprovalGrant(
      grantParams({
        scopeMode: "tool_signature",
        toolName: "bash",
        inputDigest: digest,
        conversationId: "conv-123",
      }),
    );

    // Mismatched
    const wrong = await consumeScopedApprovalGrantByToolSignature({
      toolName: "bash",
      inputDigest: digest,
      consumingRequestId: "c1",
      conversationId: "conv-999",
    });
    expect(wrong.ok).toBe(false);

    // Matched
    const correct = await consumeScopedApprovalGrantByToolSignature({
      toolName: "bash",
      inputDigest: digest,
      consumingRequestId: "c2",
      conversationId: "conv-123",
    });
    expect(correct.ok).toBe(true);
  });

  test("expired tool_signature grant cannot be consumed", async () => {
    const pastExpiry = Date.now() - 1_000;
    const digest = computeToolApprovalDigest("bash", { cmd: "ls" });
    await createScopedApprovalGrant(
      grantParams({
        scopeMode: "tool_signature",
        toolName: "bash",
        inputDigest: digest,
        expiresAt: pastExpiry,
      }),
    );

    const result = await consumeScopedApprovalGrantByToolSignature({
      toolName: "bash",
      inputDigest: digest,
      consumingRequestId: "c1",
    });
    expect(result.ok).toBe(false);
  });

  test("consume by tool signature only consumes one grant when multiple match", async () => {
    const digest = computeToolApprovalDigest("bash", { cmd: "ls" });

    // Create a wildcard grant (no executionChannel) and a channel-specific grant.
    // Both match when executionChannel='telegram', but only one should be consumed.
    const wildcardGrant = await createScopedApprovalGrant(
      grantParams({
        scopeMode: "tool_signature",
        toolName: "bash",
        inputDigest: digest,
        executionChannel: null,
      }),
    );
    const specificGrant = await createScopedApprovalGrant(
      grantParams({
        scopeMode: "tool_signature",
        toolName: "bash",
        inputDigest: digest,
        executionChannel: "telegram",
      }),
    );

    const result = await consumeScopedApprovalGrantByToolSignature({
      toolName: "bash",
      inputDigest: digest,
      consumingRequestId: "c1",
      executionChannel: "telegram",
    });
    expect(result.ok).toBe(true);
    // The most specific grant (channel-specific) should be consumed first
    expect(result.grant!.id).toBe(specificGrant.id);

    // The wildcard grant should still be active and consumable
    const second = await consumeScopedApprovalGrantByToolSignature({
      toolName: "bash",
      inputDigest: digest,
      consumingRequestId: "c2",
      executionChannel: "phone",
    });
    expect(second.ok).toBe(true);
    expect(second.grant!.id).toBe(wildcardGrant.id);
  });
});

// ===========================================================================
// Expiry semantics
// ===========================================================================

describePg("scoped-approval-grants / expiry", () => {
  beforeEach(async () => {
    await clearTables();
  });

  test("expireScopedApprovalGrants transitions active past-TTL grants to expired", async () => {
    const pastExpiry = Date.now() - 1_000;
    await createScopedApprovalGrant(
      grantParams({
        scopeMode: "request_id",
        requestId: "req-e1",
        expiresAt: pastExpiry,
      }),
    );
    await createScopedApprovalGrant(
      grantParams({
        scopeMode: "request_id",
        requestId: "req-e2",
        expiresAt: pastExpiry,
      }),
    );
    // Still active (future expiry)
    await createScopedApprovalGrant(
      grantParams({ scopeMode: "request_id", requestId: "req-alive" }),
    );

    const count = await expireScopedApprovalGrants();
    expect(count).toBe(2);

    // Verify the alive grant is still active
    const alive = await consumeScopedApprovalGrantByRequestId(
      "req-alive",
      "c1",
    );
    expect(alive.ok).toBe(true);
  });

  test("already-consumed grants are not affected by expiry sweep", async () => {
    const expiresAt = Date.now() + 60_000;
    await createScopedApprovalGrant(
      grantParams({
        scopeMode: "request_id",
        requestId: "req-consumed",
        expiresAt,
      }),
    );
    const consumed = await consumeScopedApprovalGrantByRequestId(
      "req-consumed",
      "c1",
      expiresAt - 1,
    );
    expect(consumed.ok).toBe(true);

    // Sweep after the grant's expiresAt. Status is consumed, so the active-only
    // expiry update must leave it alone.
    const count = await expireScopedApprovalGrants(expiresAt);
    expect(count).toBe(0);
  });
});

// ===========================================================================
// Revoke semantics
// ===========================================================================

describePg("scoped-approval-grants / revoke", () => {
  beforeEach(async () => {
    await clearTables();
  });

  test("revokeScopedApprovalGrantsForContext revokes active grants matching context", async () => {
    await createScopedApprovalGrant(
      grantParams({
        scopeMode: "request_id",
        requestId: "req-r1",
        callSessionId: "call-1",
      }),
    );
    await createScopedApprovalGrant(
      grantParams({
        scopeMode: "request_id",
        requestId: "req-r2",
        callSessionId: "call-1",
      }),
    );
    await createScopedApprovalGrant(
      grantParams({
        scopeMode: "request_id",
        requestId: "req-r3",
        callSessionId: "call-2",
      }),
    );

    const count = await revokeScopedApprovalGrantsForContext({
      callSessionId: "call-1",
    });
    expect(count).toBe(2);

    // Revoked grant cannot be consumed
    const revoked = await consumeScopedApprovalGrantByRequestId("req-r1", "c1");
    expect(revoked.ok).toBe(false);

    // Unaffected grant is still consumable
    const alive = await consumeScopedApprovalGrantByRequestId("req-r3", "c1");
    expect(alive.ok).toBe(true);
  });

  test("revoked grants cannot be consumed", async () => {
    await createScopedApprovalGrant(
      grantParams({
        scopeMode: "request_id",
        requestId: "req-revoke",
        conversationId: "conv-1",
      }),
    );

    await revokeScopedApprovalGrantsForContext({ conversationId: "conv-1" });

    const result = await consumeScopedApprovalGrantByRequestId(
      "req-revoke",
      "c1",
    );
    expect(result.ok).toBe(false);
  });

  test("revokeScopedApprovalGrantsForContext throws when no context filters are provided", async () => {
    // Create a grant to ensure the guard is not based on empty results
    await createScopedApprovalGrant(
      grantParams({
        scopeMode: "request_id",
        requestId: "req-guard",
        callSessionId: "call-guard",
      }),
    );

    // Empty object: all fields undefined
    await expect(revokeScopedApprovalGrantsForContext({})).rejects.toThrow(
      "revokeScopedApprovalGrantsForContext requires at least one context filter",
    );

    // The grant should still be active (not revoked)
    const result = await consumeScopedApprovalGrantByRequestId(
      "req-guard",
      "c1",
    );
    expect(result.ok).toBe(true);
  });
});

// ===========================================================================
// tool-approval-digest: canonical serialization + hash
// ===========================================================================

describePg("tool-approval-digest", () => {
  test("canonicalJsonSerialize sorts keys recursively", async () => {
    const obj = { z: 1, a: { c: 3, b: 2 } };
    const serialized = canonicalJsonSerialize(obj);
    expect(serialized).toBe('{"a":{"b":2,"c":3},"z":1}');
  });

  test("canonicalJsonSerialize handles arrays (order preserved)", async () => {
    const obj = { items: [3, 1, 2], name: "test" };
    const serialized = canonicalJsonSerialize(obj);
    expect(serialized).toBe('{"items":[3,1,2],"name":"test"}');
  });

  test("canonicalJsonSerialize handles null values", async () => {
    const obj = { a: null, b: "hello" };
    const serialized = canonicalJsonSerialize(obj);
    expect(serialized).toBe('{"a":null,"b":"hello"}');
  });

  test("canonicalJsonSerialize handles nested arrays of objects", async () => {
    const obj = {
      list: [
        { z: 1, a: 2 },
        { y: 3, b: 4 },
      ],
    };
    const serialized = canonicalJsonSerialize(obj);
    expect(serialized).toBe('{"list":[{"a":2,"z":1},{"b":4,"y":3}]}');
  });

  test("computeToolApprovalDigest is deterministic", async () => {
    const d1 = computeToolApprovalDigest("bash", {
      cmd: "ls -la",
      cwd: "/tmp",
    });
    const d2 = computeToolApprovalDigest("bash", {
      cwd: "/tmp",
      cmd: "ls -la",
    });
    expect(d1).toBe(d2);
  });

  test("computeToolApprovalDigest differs for different inputs", async () => {
    const d1 = computeToolApprovalDigest("bash", { cmd: "ls" });
    const d2 = computeToolApprovalDigest("bash", { cmd: "pwd" });
    expect(d1).not.toBe(d2);
  });

  test("computeToolApprovalDigest differs for different tool names", async () => {
    const d1 = computeToolApprovalDigest("bash", { cmd: "ls" });
    const d2 = computeToolApprovalDigest("python", { cmd: "ls" });
    expect(d1).not.toBe(d2);
  });

  test("computeToolApprovalDigest is stable across key orderings (deeply nested)", async () => {
    const d1 = computeToolApprovalDigest("tool", {
      config: { nested: { z: 1, a: 2 }, top: true },
      name: "test",
    });
    const d2 = computeToolApprovalDigest("tool", {
      name: "test",
      config: { top: true, nested: { a: 2, z: 1 } },
    });
    expect(d1).toBe(d2);
  });
});
