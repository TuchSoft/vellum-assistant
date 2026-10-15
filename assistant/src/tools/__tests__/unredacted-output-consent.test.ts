import { describe, expect, test } from "bun:test";

import {
  extractUnredactedOutputConsent,
  UNREDACTED_OUTPUT_CONSENT_KEY,
} from "../unredacted-output-consent.js";

describe("extractUnredactedOutputConsent", () => {
  test("input without the key passes through untouched", () => {
    const input = { command: "ls -la" };
    const result = extractUnredactedOutputConsent(input);
    expect(result.requested).toBe(false);
    expect(result.input).toBe(input);
  });

  test("the key is stripped when present with boolean true", () => {
    const result = extractUnredactedOutputConsent({
      command: "cat config.yml",
      [UNREDACTED_OUTPUT_CONSENT_KEY]: true,
    });
    expect(result.requested).toBe(true);
    expect(result.input).toEqual({ command: "cat config.yml" });
  });

  test("a non-boolean value does not count as consent", () => {
    const result = extractUnredactedOutputConsent({
      command: "cat config.yml",
      [UNREDACTED_OUTPUT_CONSENT_KEY]: "true",
    });
    expect(result.requested).toBe(false);
    expect(result.input).toEqual({
      command: "cat config.yml",
      [UNREDACTED_OUTPUT_CONSENT_KEY]: "true",
    });
  });

  test("the original input object is not mutated", () => {
    const input = {
      command: "cat config.yml",
      [UNREDACTED_OUTPUT_CONSENT_KEY]: true,
    };
    extractUnredactedOutputConsent(input);
    expect(input[UNREDACTED_OUTPUT_CONSENT_KEY]).toBe(true);
  });
});
