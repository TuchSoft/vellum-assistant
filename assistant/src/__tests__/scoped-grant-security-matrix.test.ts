/**
 * Security test matrix for channel-agnostic scoped approval grants.
 *
 * This file covers scenarios NOT already tested in:
 *   - scoped-approval-grants.test.ts (CRUD, digest, basic consume semantics)
 *   - voice-scoped-grant-consumer.test.ts (voice bridge integration)
 *   - guardian-grant-minting.test.ts (grant minting on approval decisions)
 *
 * Additional scenarios tested here:
 *   6. Requester identity mismatch denied
 *   8. Concurrent consume attempts: only one succeeds
 *  12. Restart behavior remains fail-closed — grants stored in persistent DB
 *
 * Cross-reference:
 *   1. Voice happy path — voice-scoped-grant-consumer.test.ts
 *   2. Replay denied — scoped-approval-grants.test.ts + voice-scoped-grant-consumer.test.ts
 *   3. Tool mismatch denied — scoped-approval-grants.test.ts + voice-scoped-grant-consumer.test.ts
 *   4. Input mismatch denied — scoped-approval-grants.test.ts
 *   5. Execution-channel mismatch denied — scoped-approval-grants.test.ts
 *   7. Expired grant denied — scoped-approval-grants.test.ts
 *   9. Stale decision cannot mint extra grant — guardian-grant-minting.test.ts
 *  10. Informational ASK_GUARDIAN cannot mint grant — guardian-grant-minting.test.ts
 *  11. Guardian identity mismatch cannot mint grant — guardian-grant-minting.test.ts
 */

import { beforeEach, expect, test } from "bun:test";

import {
  _internal,
  type CreateScopedApprovalGrantParams,
} from "../approvals/scoped-approval-grants.js";
import { requireMainDb } from "../persistence/db-facade.js";
import { initializeDb } from "../persistence/db-init.js";
import { describePg } from "./pg-test-db.js";

const { consumeScopedApprovalGrantByToolSignature, createScopedApprovalGrant } =
  _internal;
import { computeToolApprovalDigest } from "../security/tool-approval-digest.js";

await initializeDb();

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
    scopeMode: "tool_signature",
    toolName: "bash",
    inputDigest: computeToolApprovalDigest("bash", { cmd: "ls" }),
    requestChannel: "telegram",
    decisionChannel: "telegram",
    expiresAt: futureExpiry,
    ...overrides,
  };
}

// ===========================================================================
// 6. Requester identity mismatch denied
// ===========================================================================

describePg("security matrix: requester identity mismatch", () => {
  beforeEach(async () => {
    await clearTables();
  });

  test("grant scoped to a specific requester cannot be consumed by a different requester", async () => {
    const digest = computeToolApprovalDigest("bash", { cmd: "ls" });
    await createScopedApprovalGrant(
      grantParams({
        toolName: "bash",
        inputDigest: digest,
        requesterExternalUserId: "user-alice",
      }),
    );

    // Attempt to consume as a different user
    const wrongUser = await consumeScopedApprovalGrantByToolSignature({
      toolName: "bash",
      inputDigest: digest,
      consumingRequestId: "c1",
      requesterExternalUserId: "user-bob",
    });
    expect(wrongUser.ok).toBe(false);

    // Correct user succeeds
    const correctUser = await consumeScopedApprovalGrantByToolSignature({
      toolName: "bash",
      inputDigest: digest,
      consumingRequestId: "c2",
      requesterExternalUserId: "user-alice",
    });
    expect(correctUser.ok).toBe(true);
  });

  test("grant with null requesterExternalUserId allows any requester (wildcard)", async () => {
    const digest = computeToolApprovalDigest("bash", { cmd: "ls" });
    await createScopedApprovalGrant(
      grantParams({
        toolName: "bash",
        inputDigest: digest,
        requesterExternalUserId: null,
      }),
    );

    // Any user can consume when requester is null (wildcard)
    const result = await consumeScopedApprovalGrantByToolSignature({
      toolName: "bash",
      inputDigest: digest,
      consumingRequestId: "c1",
      requesterExternalUserId: "user-anyone",
    });
    expect(result.ok).toBe(true);
  });

  test("consume without providing requester only matches grants with null requester", async () => {
    const digest = computeToolApprovalDigest("bash", { cmd: "ls" });

    // Grant scoped to a specific requester
    await createScopedApprovalGrant(
      grantParams({
        toolName: "bash",
        inputDigest: digest,
        requesterExternalUserId: "user-alice",
      }),
    );

    // Consume without specifying requester — should NOT match a requester-scoped grant
    const result = await consumeScopedApprovalGrantByToolSignature({
      toolName: "bash",
      inputDigest: digest,
      consumingRequestId: "c1",
      // No requesterExternalUserId provided
    });
    expect(result.ok).toBe(false);
  });
});

// ===========================================================================
// 8. Concurrent consume attempts: only one succeeds
// ===========================================================================

describePg("security matrix: concurrent consume (CAS)", () => {
  beforeEach(async () => {
    await clearTables();
  });

  test("only one of multiple concurrent consumers succeeds for the same grant", async () => {
    const digest = computeToolApprovalDigest("bash", { cmd: "rm -rf /" });
    await createScopedApprovalGrant(
      grantParams({
        toolName: "bash",
        inputDigest: digest,
      }),
    );

    // Simulate concurrent consumers racing to consume the same grant.
    // Since SQLite is synchronous in Bun, we simulate by issuing
    // back-to-back consume calls — the CAS mechanism ensures only the
    // first succeeds.
    const results: boolean[] = [];
    for (let i = 0; i < 5; i++) {
      const result = await consumeScopedApprovalGrantByToolSignature({
        toolName: "bash",
        inputDigest: digest,
        consumingRequestId: `concurrent-consumer-${i}`,
      });
      results.push(result.ok);
    }

    // Exactly one should succeed
    const successes = results.filter(Boolean);
    expect(successes.length).toBe(1);

    // The first consumer should win
    expect(results[0]).toBe(true);
  });

  test("with multiple matching grants, each consumer gets at most one grant", async () => {
    const digest = computeToolApprovalDigest("bash", { cmd: "ls" });

    // Create 3 grants for the same tool signature
    for (let i = 0; i < 3; i++) {
      await createScopedApprovalGrant(
        grantParams({
          toolName: "bash",
          inputDigest: digest,
        }),
      );
    }

    // 5 consumers compete for 3 grants
    const results: boolean[] = [];
    for (let i = 0; i < 5; i++) {
      const result = await consumeScopedApprovalGrantByToolSignature({
        toolName: "bash",
        inputDigest: digest,
        consumingRequestId: `consumer-${i}`,
      });
      results.push(result.ok);
    }

    // Exactly 3 should succeed (one per grant)
    const successes = results.filter(Boolean);
    expect(successes.length).toBe(3);

    // The last 2 should fail
    expect(results[3]).toBe(false);
    expect(results[4]).toBe(false);
  });
});

// ===========================================================================
// 12. Restart behavior remains fail-closed — grants stored in persistent DB
// ===========================================================================

describePg("security matrix: persistence and fail-closed behavior", () => {
  beforeEach(async () => {
    await clearTables();
  });

  test("grants survive DB re-initialization (simulating daemon restart)", async () => {
    const digest = computeToolApprovalDigest("bash", { cmd: "ls" });

    // Create a grant
    const grant = await createScopedApprovalGrant(
      grantParams({
        toolName: "bash",
        inputDigest: digest,
      }),
    );
    expect(grant.status).toBe("active");

    // Re-initialize the DB (simulates daemon restart — the SQLite file persists)
    await initializeDb();

    // The grant should still be consumable after restart
    const result = await consumeScopedApprovalGrantByToolSignature({
      toolName: "bash",
      inputDigest: digest,
      consumingRequestId: "post-restart-consumer",
    });
    expect(result.ok).toBe(true);
    expect(result.grant!.id).toBe(grant.id);
  });

  test("consumed grants remain consumed after DB re-initialization", async () => {
    const digest = computeToolApprovalDigest("bash", { cmd: "ls" });

    await createScopedApprovalGrant(
      grantParams({
        toolName: "bash",
        inputDigest: digest,
      }),
    );

    // Consume the grant
    const first = await consumeScopedApprovalGrantByToolSignature({
      toolName: "bash",
      inputDigest: digest,
      consumingRequestId: "pre-restart-consumer",
    });
    expect(first.ok).toBe(true);

    // Re-initialize the DB (simulates daemon restart)
    await initializeDb();

    // The consumed grant must NOT be consumable again after restart
    const second = await consumeScopedApprovalGrantByToolSignature({
      toolName: "bash",
      inputDigest: digest,
      consumingRequestId: "post-restart-consumer",
    });
    expect(second.ok).toBe(false);
  });

  test("no grants means fail-closed (deny by default)", async () => {
    // Empty grant table — no grants at all
    const digest = computeToolApprovalDigest("bash", {
      cmd: "dangerous-command",
    });

    const result = await consumeScopedApprovalGrantByToolSignature({
      toolName: "bash",
      inputDigest: digest,
      consumingRequestId: "consumer-1",
    });

    // Must fail closed — no grant = no permission
    expect(result.ok).toBe(false);
    expect(result.grant).toBeNull();
  });
});

// ===========================================================================
// Combined cross-scope invariants
// ===========================================================================

describePg("security matrix: cross-scope invariants", () => {
  beforeEach(async () => {
    await clearTables();
  });

  test("all scope fields must match simultaneously for consumption", async () => {
    const digest = computeToolApprovalDigest("bash", { cmd: "ls" });

    // Create a maximally-scoped grant
    await createScopedApprovalGrant(
      grantParams({
        toolName: "bash",
        inputDigest: digest,
        executionChannel: "phone",
        conversationId: "conv-123",
        callSessionId: "call-456",
        requesterExternalUserId: "user-alice",
      }),
    );

    // Each field mismatch should independently cause failure:

    // Wrong execution channel
    expect(
      (
        await consumeScopedApprovalGrantByToolSignature({
          toolName: "bash",
          inputDigest: digest,
          consumingRequestId: "c-chan",
          executionChannel: "telegram",
          conversationId: "conv-123",
          callSessionId: "call-456",
          requesterExternalUserId: "user-alice",
        })
      ).ok,
    ).toBe(false);

    // Wrong conversation
    expect(
      (
        await consumeScopedApprovalGrantByToolSignature({
          toolName: "bash",
          inputDigest: digest,
          consumingRequestId: "c-conv",
          executionChannel: "phone",
          conversationId: "conv-999",
          callSessionId: "call-456",
          requesterExternalUserId: "user-alice",
        })
      ).ok,
    ).toBe(false);

    // Wrong call session
    expect(
      (
        await consumeScopedApprovalGrantByToolSignature({
          toolName: "bash",
          inputDigest: digest,
          consumingRequestId: "c-call",
          executionChannel: "phone",
          conversationId: "conv-123",
          callSessionId: "call-999",
          requesterExternalUserId: "user-alice",
        })
      ).ok,
    ).toBe(false);

    // Wrong requester
    expect(
      (
        await consumeScopedApprovalGrantByToolSignature({
          toolName: "bash",
          inputDigest: digest,
          consumingRequestId: "c-user",
          executionChannel: "phone",
          conversationId: "conv-123",
          callSessionId: "call-456",
          requesterExternalUserId: "user-bob",
        })
      ).ok,
    ).toBe(false);

    // All fields match — succeeds
    expect(
      (
        await consumeScopedApprovalGrantByToolSignature({
          toolName: "bash",
          inputDigest: digest,
          consumingRequestId: "c-all",
          executionChannel: "phone",
          conversationId: "conv-123",
          callSessionId: "call-456",
          requesterExternalUserId: "user-alice",
        })
      ).ok,
    ).toBe(true);
  });
});
