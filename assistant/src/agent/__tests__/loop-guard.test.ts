import { describe, expect, test } from "bun:test";

import {
  DEFAULT_LOOP_GUARD_OPTIONS,
  detectRepetition,
  LoopGuard,
  type LoopGuardOptions,
} from "../loop-guard.js";

const OPTS: LoopGuardOptions = {
  maxBlockLength: 200,
  maxRepeats: 5,
  minBlockLength: 1,
  whitespaceRepeatMultiplier: 10,
  checkIntervalChars: 8,
  minLargeBlockLength: 50,
  minLargeBlockRepeats: 3,
};

/** True when the string holds a surrogate that is not part of a pair. */
function hasLoneSurrogate(value: string): boolean {
  for (let i = 0; i < value.length; i++) {
    const code = value.charCodeAt(i);
    if (code >= 0xd800 && code <= 0xdbff) {
      const next = value.charCodeAt(i + 1);
      if (!(next >= 0xdc00 && next <= 0xdfff)) {
        return true;
      }
      i++;
    } else if (code >= 0xdc00 && code <= 0xdfff) {
      return true;
    }
  }
  return false;
}

describe("detectRepetition", () => {
  test("trips on a single-character run strictly longer than maxRepeats (explicit minBlockLength 1)", () => {
    expect(detectRepetition("a".repeat(5), OPTS)).toBeNull();

    const det = detectRepetition("a".repeat(6), OPTS);
    expect(det).not.toBeNull();
    expect(det!.blockLength).toBe(1);
    expect(det!.repeats).toBeGreaterThan(5);
  });

  test("trips on a two-character cycle", () => {
    const det = detectRepetition("ab".repeat(6), OPTS);
    expect(det).not.toBeNull();
    expect(det!.blockLength).toBe(2);
  });

  test("trips on a multi-character block and keeps a clean sample", () => {
    const det = detectRepetition("hello".repeat(6), OPTS);
    expect(det).not.toBeNull();
    expect(det!.blockLength).toBe(5);
    expect(det!.sample).toBe("hello");
  });

  test("trips on a repeated paragraph through the large-block rule", () => {
    const opts: LoopGuardOptions = { ...OPTS, maxRepeats: 10, maxBlockLength: 400 };
    const paragraph =
      "Alpha beta gamma delta epsilon zeta eta theta iota kappa lambda mu. " +
      "Numbers one two three four five six seven eight nine ten eleven. " +
      "Colors red orange yellow green blue indigo violet and more words here.";
    const det = detectRepetition(paragraph.repeat(3), opts);

    expect(det).not.toBeNull();
    // Below the primary threshold, so this is the large-block rule.
    expect(det!.repeats).toBeLessThan(11);
    expect(det!.repeats).toBeGreaterThanOrEqual(opts.minLargeBlockRepeats);
    expect(det!.blockLength).toBeGreaterThanOrEqual(opts.minLargeBlockLength);
  });

  test("trips on a CJK character loop", () => {
    const det = detectRepetition("中".repeat(6), OPTS);
    expect(det).not.toBeNull();
    expect(det!.blockLength).toBe(1);
  });

  test("covers astral characters and never emits a lone surrogate in the sample", () => {
    const det = detectRepetition("😀".repeat(6), OPTS);
    expect(det).not.toBeNull();
    // One emoji is a surrogate pair, so the block is two code units.
    expect(det!.blockLength).toBe(2);
    expect(hasLoneSurrogate(det!.sample)).toBe(false);
  });

  test("ignores a repeated block longer than maxBlockLength", () => {
    const opts: LoopGuardOptions = {
      ...OPTS,
      maxBlockLength: 8,
      minLargeBlockLength: 50,
    };
    expect(detectRepetition("abcdefghij".repeat(6), opts)).toBeNull();
  });

  test("does not trip on normal prose", () => {
    const prose =
      "Thanks for the update. I reviewed the proposal and it looks solid, " +
      "though I have a couple of questions about the timeline and the budget. " +
      "Let me know when you have a moment to walk through the details.";
    expect(detectRepetition(prose, OPTS)).toBeNull();
  });

  test("does not trip on a code snippet with repeated idioms", () => {
    const code = [
      "export function add(a: number, b: number): number {",
      "  return a + b;",
      "}",
      "",
      "export function sub(a: number, b: number): number {",
      "  return a - b;",
      "}",
    ].join("\n");
    expect(detectRepetition(code.repeat(2), OPTS)).toBeNull();
  });

  test("does not trip on 13 consecutive spaces (report formatting)", () => {
    expect(
      detectRepetition(" ".repeat(13), DEFAULT_LOOP_GUARD_OPTIONS),
    ).toBeNull();
  });

  test("does not trip on a markdown table row with padded columns", () => {
    const row =
      "      | assignsubmission_file_maxsizebytes  | 10485760               |";
    expect(detectRepetition(row, DEFAULT_LOOP_GUARD_OPTIONS)).toBeNull();
  });

  test("does not trip on a short non-whitespace single-character run", () => {
    // minBlockLength 3 means a short run of one letter is not a candidate.
    expect(
      detectRepetition("a".repeat(13), DEFAULT_LOOP_GUARD_OPTIONS),
    ).toBeNull();
    expect(
      detectRepetition("a".repeat(38), DEFAULT_LOOP_GUARD_OPTIONS),
    ).toBeNull();
  });

  test("still trips on a long non-whitespace single-character run", () => {
    const det = detectRepetition("a".repeat(200), DEFAULT_LOOP_GUARD_OPTIONS);
    expect(det).not.toBeNull();
    expect(det!.blockLength).toBe(3);
  });

  test("still checks whitespace, but only when it repeats far longer", () => {
    expect(
      detectRepetition(" ".repeat(300), DEFAULT_LOOP_GUARD_OPTIONS),
    ).toBeNull();

    const det = detectRepetition(" ".repeat(400), DEFAULT_LOOP_GUARD_OPTIONS);
    expect(det).not.toBeNull();
    expect(det!.sample.length).toBeGreaterThan(0);
    expect(det!.sample.trim()).toBe("");
  });

  test("applies the whitespace multiplier with explicit options", () => {
    expect(detectRepetition(" ".repeat(13), OPTS)).toBeNull();
    expect(detectRepetition(" ".repeat(60), OPTS)).not.toBeNull();
  });
});

describe("LoopGuard", () => {
  test("reports a detection once, then stores it until reset", () => {
    const guard = new LoopGuard(OPTS);
    expect(guard.push("a".repeat(6))).not.toBeNull();
    expect(guard.detection).not.toBeNull();
    // A tripped guard keeps returning its detection instead of rescanning.
    expect(guard.push("a".repeat(6))).not.toBeNull();

    guard.reset();
    expect(guard.detection).toBeNull();
    expect(guard.push("just some ordinary words")).toBeNull();
  });

  test("detects a loop fed in small chunks", () => {
    const guard = new LoopGuard(OPTS);
    let det = null;
    for (let i = 0; i < 10 && det === null; i++) {
      det = guard.push("xy");
    }
    expect(det).not.toBeNull();
    expect(det!.blockLength).toBe(2);
  });

  test("still detects a continuing loop after the buffer is trimmed", () => {
    const opts: LoopGuardOptions = {
      ...OPTS,
      maxBlockLength: 20,
      minLargeBlockLength: 1000,
    };
    const guard = new LoopGuard(opts);
    const varied = Array.from({ length: 400 }, (_, i) =>
      String.fromCharCode(33 + ((i * 7) % 90)),
    ).join("");
    expect(guard.push(varied)).toBeNull();

    const det = guard.push("ab".repeat(10));
    expect(det).not.toBeNull();
    expect(det!.blockLength).toBe(2);
  });
});
