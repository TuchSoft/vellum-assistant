/**
 * Streaming repetition guard.
 *
 * Detects runaway repetitive model output (a single character, a short cycle,
 * or a repeated paragraph) from the raw assistant text deltas the agent loop
 * already forwards, so every provider passes through it. The detector works on
 * UTF-16 code units, which is byte-equivalent for repetition across every
 * script (Latin, CJK, emoji) without an alphabet assumption.
 *
 * Callers feed chunks to a LoopGuard and, when push reports a detection, throw
 * a LoopDetectedError to end the turn.
 */

import { safeStringSlice } from "../util/unicode.js";

export interface LoopGuardOptions {
  /** Longest repeating block considered (the Y bound). */
  maxBlockLength: number;
  /** A block repeating strictly more than this trips the primary rule (the X bound). */
  maxRepeats: number;
  /** Smallest repeating block considered. */
  minBlockLength: number;
  /**
   * Multiplier on the repeat thresholds when the repeating block is
   * whitespace-only. Runs of spaces or newlines are ordinary formatting, so
   * they must repeat this many times longer than other output to trip.
   */
  whitespaceRepeatMultiplier: number;
  /** New code units between full period scans. */
  checkIntervalChars: number;
  /** Block length at or above which the large-block rule applies. */
  minLargeBlockLength: number;
  /** Repeats that trip the large-block rule. */
  minLargeBlockRepeats: number;
}

export const DEFAULT_LOOP_GUARD_OPTIONS: LoopGuardOptions = {
  maxBlockLength: 2000,
  maxRepeats: 12,
  minBlockLength: 3,
  whitespaceRepeatMultiplier: 10,
  checkIntervalChars: 64,
  minLargeBlockLength: 200,
  minLargeBlockRepeats: 3,
};

/** Periods up to this length are tested on every push for fast detection. */
const FAST_PERIOD_CAP = 16;

/** Longest excerpt kept of a repeated block, for logging. */
const SAMPLE_MAX_CHARS = 120;

export interface LoopDetection {
  /** Length of the repeated block, in code units. */
  blockLength: number;
  /** How many times the block repeated consecutively. */
  repeats: number;
  /** Short, surrogate-safe excerpt of the repeated block. Logging only. */
  sample: string;
}

export class LoopDetectedError extends Error {
  readonly detection: LoopDetection;

  constructor(detection: LoopDetection) {
    super(
      `Stopped: the model began repeating a ${detection.blockLength}-unit block ${detection.repeats} times.`,
    );
    this.name = "LoopDetectedError";
    this.detection = detection;
  }
}

/**
 * How many times the block of length p ending at the buffer's end repeats
 * consecutively. Comparison runs backward with early exit, so a non-repetitive
 * tail costs one or two comparisons per period.
 */
function countTailRepeats(buffer: string, p: number): number {
  const n = buffer.length;
  let copies = 1;
  while ((copies + 1) * p <= n) {
    const a = n - (copies + 1) * p;
    const b = n - copies * p;
    let equal = true;
    for (let i = 0; i < p; i++) {
      if (buffer[a + i] !== buffer[b + i]) {
        equal = false;
        break;
      }
    }
    if (!equal) {
      break;
    }
    copies++;
  }
  return copies;
}

/** Short, surrogate-safe excerpt of the last p code units, for logging. */
function sampleOf(buffer: string, p: number): string {
  const end = buffer.length;
  const start = Math.max(0, end - p);
  return safeStringSlice(
    buffer,
    start,
    Math.min(end, start + SAMPLE_MAX_CHARS),
  );
}

/** True when the last p code units are all whitespace (space, tab, newline...). */
function isWhitespaceBlock(buffer: string, p: number): boolean {
  const start = buffer.length - p;
  for (let i = start; i < buffer.length; i++) {
    const code = buffer.charCodeAt(i);
    if (
      code !== 0x20 && // space
      code !== 0x09 && // tab
      code !== 0x0a && // line feed
      code !== 0x0d && // carriage return
      code !== 0x0b && // vertical tab
      code !== 0x0c && // form feed
      code !== 0xa0 // no-break space
    ) {
      return false;
    }
  }
  return true;
}

/**
 * Test the buffer's tail for a repetition loop, considering periods up to
 * maxPeriodCap (default: every configured period). Returns the first
 * detection, or null when the tail is clean.
 *
 * Two rules, both bounded by the buffer:
 *   1. Primary: a block of length at most maxBlockLength repeats strictly more
 *      than maxRepeats times.
 *   2. Large block: a block of length at least minLargeBlockLength repeats at
 *      least minLargeBlockRepeats times. A single repeat threshold cannot cover
 *      both a one-character run and a repeated paragraph, so this closes the
 *      gap while keeping the primary threshold conservative.
 */
export function detectRepetition(
  buffer: string,
  opts: LoopGuardOptions,
  maxPeriodCap: number = opts.maxBlockLength,
): LoopDetection | null {
  const n = buffer.length;
  const minPeriod = Math.max(1, opts.minBlockLength);

  const primaryCopies = opts.maxRepeats + 1;
  const primaryMax = Math.min(
    opts.maxBlockLength,
    maxPeriodCap,
    Math.floor(n / primaryCopies),
  );
  for (let p = minPeriod; p <= primaryMax; p++) {
    const copies = countTailRepeats(buffer, p);
    if (copies > opts.maxRepeats) {
      const threshold = isWhitespaceBlock(buffer, p)
        ? opts.maxRepeats * opts.whitespaceRepeatMultiplier
        : opts.maxRepeats;
      if (copies > threshold) {
        return { blockLength: p, repeats: copies, sample: sampleOf(buffer, p) };
      }
    }
  }

  if (
    opts.minLargeBlockRepeats >= 2 &&
    opts.minLargeBlockLength <= opts.maxBlockLength
  ) {
    const largeMin = Math.max(minPeriod, opts.minLargeBlockLength);
    const largeMax = Math.min(
      opts.maxBlockLength,
      maxPeriodCap,
      Math.floor(n / opts.minLargeBlockRepeats),
    );
    for (let p = largeMin; p <= largeMax; p++) {
      const copies = countTailRepeats(buffer, p);
      if (copies >= opts.minLargeBlockRepeats) {
        const threshold = isWhitespaceBlock(buffer, p)
          ? opts.minLargeBlockRepeats * opts.whitespaceRepeatMultiplier
          : opts.minLargeBlockRepeats;
        if (copies >= threshold) {
          return {
            blockLength: p,
            repeats: copies,
            sample: sampleOf(buffer, p),
          };
        }
      }
    }
  }

  return null;
}

/**
 * Stateful wrapper around detectRepetition: a bounded buffer plus scan
 * throttling. Use one instance per streamed model call.
 */
export class LoopGuard {
  private readonly opts: LoopGuardOptions;
  private readonly maxWindow: number;
  private buffer = "";
  private charsSinceFullScan = 0;
  private tripped: LoopDetection | null = null;

  constructor(opts: LoopGuardOptions = DEFAULT_LOOP_GUARD_OPTIONS) {
    this.opts = { ...DEFAULT_LOOP_GUARD_OPTIONS, ...opts };
    this.maxWindow =
      this.opts.maxBlockLength * (this.opts.maxRepeats + 1) * 2 +
      this.opts.checkIntervalChars;
  }

  /** The detection that tripped the guard, or null while it is still clean. */
  get detection(): LoopDetection | null {
    return this.tripped;
  }

  reset(): void {
    this.buffer = "";
    this.charsSinceFullScan = 0;
    this.tripped = null;
  }

  /**
   * Feed the next streamed chunk. Returns the detection when the guard trips
   * (once), then null thereafter. A fast small-period scan runs on every push;
   * the full period scan runs at most every checkIntervalChars new code units.
   */
  push(text: string): LoopDetection | null {
    if (this.tripped || text.length === 0) {
      return this.tripped;
    }
    this.buffer += text;
    if (this.buffer.length > this.maxWindow) {
      this.buffer = this.buffer.slice(this.buffer.length - this.maxWindow);
    }
    this.charsSinceFullScan += text.length;

    let det = detectRepetition(this.buffer, this.opts, FAST_PERIOD_CAP);
    if (
      det === null &&
      this.charsSinceFullScan >= this.opts.checkIntervalChars
    ) {
      det = detectRepetition(this.buffer, this.opts);
    }
    if (det !== null) {
      this.tripped = det;
    } else if (this.charsSinceFullScan >= this.opts.checkIntervalChars) {
      this.charsSinceFullScan = 0;
    }
    return this.tripped;
  }
}
