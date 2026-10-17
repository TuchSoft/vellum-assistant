/**
 * A credential-failure marker answers for itself whether it is still worth
 * showing a Connect card for.
 *
 * The question is always the same: is the credential this failure names still
 * the one a spawn would resolve? Nothing is remembered between the failure and
 * the read, and nothing has to run at the right moment for a repaired failure
 * to stop rendering, which is what a retirement sweep needed and what a daemon
 * restart used to lose.
 */

import { beforeEach, describe, expect, test } from "bun:test";

import { describePg } from "../../__tests__/pg-test-db.js";
import { requireMainDb } from "../../persistence/db-facade.js";
import { initializeDb } from "../../persistence/db-init.js";
import {
  acpAuthMarkerStillCurrent,
  claudeTokenDigest,
  claudeTokenRefusedByClaude,
  conversationHasCurrentAcpMarker,
  noteClaudeTokenRefused,
} from "../acp-auth-marker-store.js";

await initializeDb();

async function clearHistory(): Promise<void> {
  await requireMainDb().run("DELETE FROM acp_session_history");
}

async function insertHistoryRow(row: {
  id: string;
  parentConversationId?: string;
  status?: string;
  authErrorCode?: string | null;
  authErrorCredential?: string | null;
}): Promise<void> {
  const db = requireMainDb();
  await db.orm.insert(db.schema.acpSessionHistory).values({
    id: row.id,
    agentId: "claude",
    acpSessionId: "proto-old",
    parentConversationId: row.parentConversationId ?? "conv-1",
    startedAt: 1234,
    completedAt: 5678,
    status: row.status ?? "completed",
    stopReason: "end_turn",
    eventLogJson: "[]",
    cwd: "/tmp/proj",
    authErrorCode: row.authErrorCode ?? null,
    authErrorCredential: row.authErrorCredential ?? null,
  });
}

describe("acpAuthMarkerStillCurrent", () => {
  const REFUSED = claudeTokenDigest("sk-ant-oat-refused");
  const REPLACEMENT = claudeTokenDigest("sk-ant-oat-replacement");

  test("a marker naming the credential still in use is served", () => {
    expect(acpAuthMarkerStillCurrent(REFUSED, REFUSED)).toBe(true);
  });

  test("a marker naming a credential since replaced is withheld", () => {
    // The user completed Connect. The card exists to send them there, so it
    // has nothing left to say.
    expect(acpAuthMarkerStillCurrent(REFUSED, REPLACEMENT)).toBe(false);
  });

  test("a marker with no credential named is served", () => {
    // Predates the column, or came from a path that had no token to name. An
    // unknown credential is no evidence the failure was repaired, and this
    // path fails toward leaving the user a route back to auth.
    expect(acpAuthMarkerStillCurrent(null, REPLACEMENT)).toBe(true);
    expect(acpAuthMarkerStillCurrent(undefined, REPLACEMENT)).toBe(true);
  });

  test("an empty vault serves the marker rather than hiding it", () => {
    // Nothing replaced the refused token, so the failure it names still
    // stands.
    expect(acpAuthMarkerStillCurrent(REFUSED, undefined)).toBe(true);
  });

  test("the same answer however many times it is asked", () => {
    // No state advances on a read, so a second client asking gets what the
    // first did. The sweep this replaced could only be run once.
    expect(acpAuthMarkerStillCurrent(REFUSED, REPLACEMENT)).toBe(false);
    expect(acpAuthMarkerStillCurrent(REFUSED, REPLACEMENT)).toBe(false);
    expect(acpAuthMarkerStillCurrent(REFUSED, REFUSED)).toBe(true);
  });
});

describe("claudeTokenDigest", () => {
  test("is stable and does not carry the token", () => {
    const token = "sk-ant-oat-example";
    const digest = claudeTokenDigest(token);

    expect(digest).toBe(claudeTokenDigest(token));
    expect(digest).not.toContain(token);
    expect(digest).toHaveLength(32);
  });

  test("separates one alias's token from another's", () => {
    expect(claudeTokenDigest("sk-ant-oat-a")).not.toBe(
      claudeTokenDigest("sk-ant-oat-b"),
    );
  });
});

describePg("claudeTokenRefusedByClaude", () => {
  const CONFIG_TOKEN = "sk-ant-oat-from-config";
  const DIGEST = claudeTokenDigest(CONFIG_TOKEN);

  beforeEach(async () => {
    await clearHistory();
    await requireMainDb().run("DELETE FROM acp_refused_credentials");
  });

  test("reports a token Claude refused", async () => {
    await noteClaudeTokenRefused(DIGEST, 1000);

    expect(await claudeTokenRefusedByClaude(CONFIG_TOKEN)).toBe(true);
  });

  test("reports nothing for a token never refused", async () => {
    await noteClaudeTokenRefused(DIGEST, 1000);

    expect(await claudeTokenRefusedByClaude("sk-ant-oat-never-tried")).toBe(
      false,
    );
  });

  test("one alias's refused token says nothing about another's", async () => {
    // A global one-shot would let whichever alias prepared first consume the
    // record, discarding its own good token and re-trusting the bad one.
    await noteClaudeTokenRefused(DIGEST, 1000);

    expect(await claudeTokenRefusedByClaude("sk-ant-oat-other-alias")).toBe(
      false,
    );
  });

  test("survives clearing ACP session history", async () => {
    // Deleting a run must not change which credential the next spawn picks.
    // Held on the run row, a bulk clear (which sweeps failed rows too) would
    // put the revoked configured token back in play against the vault
    // replacement the user just connected.
    await noteClaudeTokenRefused(DIGEST, 1000);
    await insertHistoryRow({
      id: "run-refused",
      status: "failed",
      authErrorCode: "acp_claude_auth_required",
      authErrorCredential: DIGEST,
    });

    await clearHistory();

    expect(await claudeTokenRefusedByClaude(CONFIG_TOKEN)).toBe(true);
  });

  test("recording the same refusal twice is not an error", async () => {
    // Every retry of a revoked configured token refuses the same digest.
    await noteClaudeTokenRefused(DIGEST, 1000);
    await noteClaudeTokenRefused(DIGEST, 2000);

    expect(await claudeTokenRefusedByClaude(CONFIG_TOKEN)).toBe(true);
  });

  test("a run that carried no credential records nothing", async () => {
    await noteClaudeTokenRefused(undefined, 1000);

    expect(await claudeTokenRefusedByClaude(CONFIG_TOKEN)).toBe(false);
  });
});

describePg("conversationHasCurrentAcpMarker", () => {
  const REFUSED = claudeTokenDigest("sk-ant-oat-refused");

  beforeEach(async () => {
    await clearHistory();
  });

  test("false for a conversation that has never failed", async () => {
    expect(await conversationHasCurrentAcpMarker("conv-clean")).toBe(false);
  });

  test("true while a marker names the credential a spawn would resolve", async () => {
    // No vault token in this suite, so the resolver reports none and the
    // comparison treats an unknown as no evidence of repair.
    await insertHistoryRow({
      id: "run-marked",
      parentConversationId: "conv-marked",
      status: "failed",
      authErrorCode: "acp_claude_auth_required",
      authErrorCredential: REFUSED,
    });

    expect(await conversationHasCurrentAcpMarker("conv-marked")).toBe(true);
  });

  test("false for a conversation whose rows carry no marker", async () => {
    await insertHistoryRow({
      id: "run-plain",
      parentConversationId: "conv-plain",
      status: "completed",
    });

    expect(await conversationHasCurrentAcpMarker("conv-plain")).toBe(false);
  });

  test("scoped to its own conversation", async () => {
    await insertHistoryRow({
      id: "run-elsewhere",
      parentConversationId: "conv-other",
      status: "failed",
      authErrorCode: "acp_claude_auth_required",
      authErrorCredential: REFUSED,
    });

    expect(await conversationHasCurrentAcpMarker("conv-asked-about")).toBe(
      false,
    );
  });
});
