import { describe, expect, test } from "bun:test";

import {
  approvalFlagsBlockAutoApprove,
  evaluatePromptPromotion,
} from "../permission-checker.js";

describe("evaluatePromptPromotion", () => {
  test("no flags: allow stays allow", () => {
    expect(evaluatePromptPromotion({}, "allow", "medium")).toEqual({
      promote: false,
    });
  });

  test("forceFreshApproval promotes allow at full access", () => {
    const result = evaluatePromptPromotion(
      { forceFreshApproval: true },
      "allow",
      "high",
    );
    expect(result.promote).toBe(true);
    expect(result.reason).toContain("Unredacted output requested");
  });

  test("forceFreshApproval promotes allow at any threshold", () => {
    for (const threshold of ["none", "low", "medium", "high"] as const) {
      expect(
        evaluatePromptPromotion(
          { forceFreshApproval: true },
          "allow",
          threshold,
        ).promote,
      ).toBe(true);
    }
  });

  test("forceFreshApproval never downgrades a deny", () => {
    expect(
      evaluatePromptPromotion({ forceFreshApproval: true }, "deny", "high"),
    ).toEqual({ promote: false });
  });

  test("requireFreshApproval promotes allow below full access", () => {
    const result = evaluatePromptPromotion(
      { requireFreshApproval: true },
      "allow",
      "medium",
    );
    expect(result.promote).toBe(true);
    expect(result.reason).toContain("Fresh approval required");
  });

  test("requireFreshApproval does not promote at full access", () => {
    expect(
      evaluatePromptPromotion({ requireFreshApproval: true }, "allow", "high"),
    ).toEqual({ promote: false });
  });

  test("requireFreshApproval promotes when the threshold is unknown", () => {
    expect(
      evaluatePromptPromotion({ requireFreshApproval: true }, "allow", undefined)
        .promote,
    ).toBe(true);
  });

  test("forceFreshApproval wins over the full-access exemption even alongside requireFreshApproval", () => {
    const result = evaluatePromptPromotion(
      { requireFreshApproval: true, forceFreshApproval: true },
      "allow",
      "high",
    );
    expect(result.promote).toBe(true);
    expect(result.reason).toContain("Unredacted output requested");
  });
});

describe("approvalFlagsBlockAutoApprove", () => {
  test("no flags do not block auto-approve", () => {
    expect(approvalFlagsBlockAutoApprove({})).toBe(false);
  });

  test("requireFreshApproval blocks auto-approve", () => {
    expect(approvalFlagsBlockAutoApprove({ requireFreshApproval: true })).toBe(
      true,
    );
  });

  test("forceFreshApproval blocks auto-approve", () => {
    expect(approvalFlagsBlockAutoApprove({ forceFreshApproval: true })).toBe(
      true,
    );
  });
});
