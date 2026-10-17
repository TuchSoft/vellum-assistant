/**
 * Conformance suite for the `sequence` store on Postgres.
 *
 * The store reads and writes only `sequences` / `sequence_enrollments`, which
 * live on the `main` slot, so the async `AsyncDbFacade` is what lets the
 * store run unchanged. The suite runs against the process's Postgres test
 * schema, bootstrapped with the generated baseline by
 * `src/__tests__/pg-test-db.ts`.
 *
 * Gated on `VELLUM_PG_TEST_URL` (throwaway instance); with it unset the suite
 * skips.
 */

import { beforeEach, describe, expect, mock, test } from "bun:test";

// Keep the suite hermetic: `claimDueEnrollments` consults the quiescence
// lease; mock it open so claims always run.
mock.module("../../persistence/lifecycle-quiesce.js", () => ({
  isLifecycleQuiesced: async () => false,
}));

import { describePg } from "../../__tests__/pg-test-db.js";
import { requireMainDb } from "../../persistence/db-facade.js";
import {
  advanceEnrollment,
  claimDueEnrollments,
  countActiveEnrollments,
  createSequence,
  deleteSequence,
  enrollContact,
  exitEnrollment,
  findActiveEnrollmentsByEmail,
  getEnrollment,
  getSequence,
  listEnrollments,
  listSequences,
  updateSequence,
} from "../store.js";
import type { SequenceStep } from "../types.js";

/** Delete the slice's rows through the facade. */
async function clearTables(): Promise<void> {
  const db = requireMainDb();
  await db.run("DELETE FROM sequence_enrollments");
  await db.run("DELETE FROM sequences");
}

const testSteps: SequenceStep[] = [
  {
    index: 0,
    delaySeconds: 0,
    subjectTemplate: "Intro",
    bodyPrompt: "Write an intro email",
    replyInSameConversation: false,
    requireApproval: false,
  },
  {
    index: 1,
    delaySeconds: 86400,
    subjectTemplate: "Follow up",
    bodyPrompt: "Write a follow-up",
    replyInSameConversation: true,
    requireApproval: false,
  },
  {
    index: 2,
    delaySeconds: 259200,
    subjectTemplate: "Final check",
    bodyPrompt: "Write a final check-in",
    replyInSameConversation: true,
    requireApproval: true,
  },
];

describePg("sequence-store (postgres)", () => {
  beforeEach(async () => {
    await clearTables();
  });

  // ── Sequence CRUD ───────────────────────────────────────────────

  describe("createSequence", () => {
    test("creates a sequence with correct fields", async () => {
      const seq = await createSequence({
        name: "Investor outreach",
        description: "Reach out to investors",
        channel: "gmail",
        steps: testSteps,
      });

      expect(seq.id).toBeTruthy();
      expect(seq.name).toBe("Investor outreach");
      expect(seq.description).toBe("Reach out to investors");
      expect(seq.channel).toBe("gmail");
      expect(seq.steps).toHaveLength(3);
      expect(seq.steps[0].subjectTemplate).toBe("Intro");
      expect(seq.exitOnReply).toBe(true);
      expect(seq.status).toBe("active");
    });

    test("defaults exitOnReply to true", async () => {
      const seq = await createSequence({
        name: "Test",
        channel: "gmail",
        steps: testSteps,
      });
      expect(seq.exitOnReply).toBe(true);
    });

    test("allows overriding exitOnReply", async () => {
      const seq = await createSequence({
        name: "Test",
        channel: "gmail",
        steps: testSteps,
        exitOnReply: false,
      });
      expect(seq.exitOnReply).toBe(false);
    });
  });

  describe("getSequence", () => {
    test("returns sequence by id", async () => {
      const created = await createSequence({
        name: "Test",
        channel: "gmail",
        steps: testSteps,
      });
      const fetched = await getSequence(created.id);
      expect(fetched).toBeDefined();
      expect(fetched!.name).toBe("Test");
      expect(fetched!.steps).toHaveLength(3);
    });

    test("returns undefined for non-existent id", async () => {
      expect(await getSequence("non-existent")).toBeUndefined();
    });
  });

  describe("listSequences", () => {
    test("lists all sequences", async () => {
      await createSequence({ name: "A", channel: "gmail", steps: testSteps });
      await createSequence({ name: "B", channel: "email", steps: testSteps });
      expect(await listSequences()).toHaveLength(2);
    });

    test("filters by status", async () => {
      await createSequence({
        name: "Active",
        channel: "gmail",
        steps: testSteps,
      });
      const paused = await createSequence({
        name: "Paused",
        channel: "gmail",
        steps: testSteps,
      });
      await updateSequence(paused.id, { status: "paused" });

      expect(await listSequences({ status: "active" })).toHaveLength(1);
      expect(await listSequences({ status: "paused" })).toHaveLength(1);
    });
  });

  describe("updateSequence", () => {
    test("updates name and description", async () => {
      const seq = await createSequence({
        name: "Old",
        channel: "gmail",
        steps: testSteps,
      });
      const updated = await updateSequence(seq.id, {
        name: "New",
        description: "Updated",
      });
      expect(updated!.name).toBe("New");
      expect(updated!.description).toBe("Updated");
    });

    test("updates status", async () => {
      const seq = await createSequence({
        name: "Test",
        channel: "gmail",
        steps: testSteps,
      });
      const updated = await updateSequence(seq.id, { status: "paused" });
      expect(updated!.status).toBe("paused");
    });

    test("updates steps", async () => {
      const seq = await createSequence({
        name: "Test",
        channel: "gmail",
        steps: testSteps,
      });
      const newSteps = [testSteps[0]];
      const updated = await updateSequence(seq.id, { steps: newSteps });
      expect(updated!.steps).toHaveLength(1);
    });
  });

  describe("deleteSequence", () => {
    test("deletes sequence and cancels active enrollments", async () => {
      const seq = await createSequence({
        name: "Test",
        channel: "gmail",
        steps: testSteps,
      });
      await enrollContact({
        sequenceId: seq.id,
        contactEmail: "a@example.com",
      });
      await enrollContact({
        sequenceId: seq.id,
        contactEmail: "b@example.com",
      });

      await deleteSequence(seq.id);

      expect(await getSequence(seq.id)).toBeUndefined();
      // Enrollments should have been cascade-deleted
      expect(await listEnrollments({ sequenceId: seq.id })).toHaveLength(0);
    });
  });

  // ── Enrollment CRUD ─────────────────────────────────────────────

  describe("enrollContact", () => {
    test("creates enrollment with correct fields", async () => {
      const seq = await createSequence({
        name: "Test",
        channel: "gmail",
        steps: testSteps,
      });
      const enrollment = await enrollContact({
        sequenceId: seq.id,
        contactEmail: "investor@example.com",
        contactName: "Jane Doe",
        context: { company: "Acme Corp" },
      });

      expect(enrollment.id).toBeTruthy();
      expect(enrollment.sequenceId).toBe(seq.id);
      expect(enrollment.contactEmail).toBe("investor@example.com");
      expect(enrollment.contactName).toBe("Jane Doe");
      expect(enrollment.currentStep).toBe(0);
      expect(enrollment.status).toBe("active");
      expect(enrollment.nextStepAt).toBeTruthy();
      expect(enrollment.context).toEqual({ company: "Acme Corp" });
    });

    test("computes nextStepAt from first step delay", async () => {
      const seq = await createSequence({
        name: "Test",
        channel: "gmail",
        steps: testSteps,
      });
      const before = Date.now();
      const enrollment = await enrollContact({
        sequenceId: seq.id,
        contactEmail: "a@example.com",
      });
      const after = Date.now();

      // First step has delaySeconds: 0, so nextStepAt should be ~now
      expect(enrollment.nextStepAt).toBeGreaterThanOrEqual(before);
      expect(enrollment.nextStepAt).toBeLessThanOrEqual(after + 1);
    });

    test("throws for non-existent sequence", async () => {
      await expect(
        enrollContact({ sequenceId: "fake", contactEmail: "a@example.com" }),
      ).rejects.toThrow("Sequence not found");
    });

    test("throws for sequence with no steps", async () => {
      const seq = await createSequence({
        name: "Empty",
        channel: "gmail",
        steps: [],
      });
      // Steps are empty but stored as []
      await expect(
        enrollContact({ sequenceId: seq.id, contactEmail: "a@example.com" }),
      ).rejects.toThrow("Sequence has no steps");
    });
  });

  describe("listEnrollments", () => {
    test("filters by sequenceId", async () => {
      const s1 = await createSequence({
        name: "S1",
        channel: "gmail",
        steps: testSteps,
      });
      const s2 = await createSequence({
        name: "S2",
        channel: "gmail",
        steps: testSteps,
      });
      await enrollContact({ sequenceId: s1.id, contactEmail: "a@example.com" });
      await enrollContact({ sequenceId: s2.id, contactEmail: "b@example.com" });

      expect(await listEnrollments({ sequenceId: s1.id })).toHaveLength(1);
      expect(await listEnrollments({ sequenceId: s2.id })).toHaveLength(1);
    });

    test("filters by status", async () => {
      const seq = await createSequence({
        name: "Test",
        channel: "gmail",
        steps: testSteps,
      });
      const e1 = await enrollContact({
        sequenceId: seq.id,
        contactEmail: "a@example.com",
      });
      await enrollContact({
        sequenceId: seq.id,
        contactEmail: "b@example.com",
      });
      await exitEnrollment(e1.id, "completed");

      expect(await listEnrollments({ status: "active" })).toHaveLength(1);
      expect(await listEnrollments({ status: "completed" })).toHaveLength(1);
    });

    test("filters by contactEmail", async () => {
      const seq = await createSequence({
        name: "Test",
        channel: "gmail",
        steps: testSteps,
      });
      await enrollContact({
        sequenceId: seq.id,
        contactEmail: "a@example.com",
      });
      await enrollContact({
        sequenceId: seq.id,
        contactEmail: "b@example.com",
      });

      expect(
        await listEnrollments({ contactEmail: "a@example.com" }),
      ).toHaveLength(1);
    });
  });

  // ── Claim & Advance ─────────────────────────────────────────────

  describe("claimDueEnrollments", () => {
    test("claims enrollments with nextStepAt <= now", async () => {
      const seq = await createSequence({
        name: "Test",
        channel: "gmail",
        steps: testSteps,
      });
      await enrollContact({
        sequenceId: seq.id,
        contactEmail: "a@example.com",
      });

      // The first step has delay 0, so nextStepAt is ~now
      const claimed = await claimDueEnrollments(Date.now() + 1000);
      expect(claimed).toHaveLength(1);
      expect(claimed[0].contactEmail).toBe("a@example.com");
    });

    test("does not claim enrollments not yet due", async () => {
      const futureSteps: SequenceStep[] = [
        {
          index: 0,
          delaySeconds: 86400,
          subjectTemplate: "Future",
          bodyPrompt: "Later",
          replyInSameConversation: false,
          requireApproval: false,
        },
      ];
      const seq = await createSequence({
        name: "Future",
        channel: "gmail",
        steps: futureSteps,
      });
      await enrollContact({
        sequenceId: seq.id,
        contactEmail: "a@example.com",
      });

      const claimed = await claimDueEnrollments(Date.now());
      expect(claimed).toHaveLength(0);
    });

    test("optimistic locking prevents double-claiming", async () => {
      const seq = await createSequence({
        name: "Test",
        channel: "gmail",
        steps: testSteps,
      });
      await enrollContact({
        sequenceId: seq.id,
        contactEmail: "a@example.com",
      });

      const now = Date.now() + 1000;
      const first = await claimDueEnrollments(now);
      const second = await claimDueEnrollments(now);

      expect(first).toHaveLength(1);
      expect(second).toHaveLength(0);
    });

    test("respects limit parameter", async () => {
      const seq = await createSequence({
        name: "Test",
        channel: "gmail",
        steps: testSteps,
      });
      await enrollContact({
        sequenceId: seq.id,
        contactEmail: "a@example.com",
      });
      await enrollContact({
        sequenceId: seq.id,
        contactEmail: "b@example.com",
      });
      await enrollContact({
        sequenceId: seq.id,
        contactEmail: "c@example.com",
      });

      const claimed = await claimDueEnrollments(Date.now() + 1000, 2);
      expect(claimed).toHaveLength(2);
    });

    test("does not claim paused enrollments", async () => {
      const seq = await createSequence({
        name: "Test",
        channel: "gmail",
        steps: testSteps,
      });
      const enrollment = await enrollContact({
        sequenceId: seq.id,
        contactEmail: "a@example.com",
      });
      await exitEnrollment(enrollment.id, "cancelled");

      const claimed = await claimDueEnrollments(Date.now() + 1000);
      expect(claimed).toHaveLength(0);
    });
  });

  describe("advanceEnrollment", () => {
    test("increments currentStep", async () => {
      const seq = await createSequence({
        name: "Test",
        channel: "gmail",
        steps: testSteps,
      });
      const enrollment = await enrollContact({
        sequenceId: seq.id,
        contactEmail: "a@example.com",
      });

      const advanced = await advanceEnrollment(
        enrollment.id,
        "thread-123",
        Date.now() + 86400000,
      );
      expect(advanced!.currentStep).toBe(1);
      expect(advanced!.conversationId).toBe("thread-123");
    });

    test("returns undefined for non-existent id", async () => {
      expect(await advanceEnrollment("fake")).toBeUndefined();
    });
  });

  describe("exitEnrollment", () => {
    test("sets status and clears nextStepAt", async () => {
      const seq = await createSequence({
        name: "Test",
        channel: "gmail",
        steps: testSteps,
      });
      const enrollment = await enrollContact({
        sequenceId: seq.id,
        contactEmail: "a@example.com",
      });

      await exitEnrollment(enrollment.id, "replied");

      const updated = await getEnrollment(enrollment.id);
      expect(updated!.status).toBe("replied");
      expect(updated!.nextStepAt).toBeNull();
    });

    test.each(["completed", "replied", "cancelled", "failed"] as const)(
      "supports exit reason: %s",
      async (reason) => {
        const seq = await createSequence({
          name: "Test",
          channel: "gmail",
          steps: testSteps,
        });
        const enrollment = await enrollContact({
          sequenceId: seq.id,
          contactEmail: `${reason}@example.com`,
        });

        await exitEnrollment(enrollment.id, reason);

        const updated = await getEnrollment(enrollment.id);
        expect(updated!.status).toBe(reason);
      },
    );
  });

  // ── Query Helpers ───────────────────────────────────────────────

  describe("findActiveEnrollmentsByEmail", () => {
    test("finds active enrollments for an email", async () => {
      const seq = await createSequence({
        name: "Test",
        channel: "gmail",
        steps: testSteps,
      });
      await enrollContact({
        sequenceId: seq.id,
        contactEmail: "a@example.com",
      });
      const e2 = await enrollContact({
        sequenceId: seq.id,
        contactEmail: "a@example.com",
      });
      await exitEnrollment(e2.id, "completed");

      const active = await findActiveEnrollmentsByEmail("a@example.com");
      expect(active).toHaveLength(1);
    });

    test("returns empty for unknown email", async () => {
      expect(
        await findActiveEnrollmentsByEmail("unknown@example.com"),
      ).toHaveLength(0);
    });
  });

  describe("countActiveEnrollments", () => {
    test("counts only active enrollments for a sequence", async () => {
      const seq = await createSequence({
        name: "Test",
        channel: "gmail",
        steps: testSteps,
      });
      await enrollContact({
        sequenceId: seq.id,
        contactEmail: "a@example.com",
      });
      await enrollContact({
        sequenceId: seq.id,
        contactEmail: "b@example.com",
      });
      const e3 = await enrollContact({
        sequenceId: seq.id,
        contactEmail: "c@example.com",
      });
      await exitEnrollment(e3.id, "completed");

      expect(await countActiveEnrollments(seq.id)).toBe(2);
    });
  });
});
