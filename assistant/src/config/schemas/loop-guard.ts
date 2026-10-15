import { z } from "zod";

export const LoopGuardConfigSchema = z
  .object({
    enabled: z
      .boolean()
      .default(true)
      .describe(
        "Whether the streaming repetition guard runs. When enabled, a model call whose output repeats a short block many times, or a large block a few times, is ended with an error instead of streaming the loop to completion.",
      ),
    maxBlockLength: z
      .number({ error: "loopGuard.maxBlockLength must be a number" })
      .int("loopGuard.maxBlockLength must be an integer")
      .positive("loopGuard.maxBlockLength must be positive")
      .default(2000)
      .describe(
        "Longest repeating block considered. A repeated paragraph must be no longer than this to be detected.",
      ),
    maxRepeats: z
      .number({ error: "loopGuard.maxRepeats must be a number" })
      .int("loopGuard.maxRepeats must be an integer")
      .min(1, "loopGuard.maxRepeats must be >= 1")
      .default(12)
      .describe(
        "Primary threshold: a block of length at most maxBlockLength trips the guard when it repeats strictly more than this many times.",
      ),
    minBlockLength: z
      .number({ error: "loopGuard.minBlockLength must be a number" })
      .int("loopGuard.minBlockLength must be an integer")
      .min(1, "loopGuard.minBlockLength must be >= 1")
      .default(3)
      .describe(
        "Smallest repeating block considered. One- and two-unit runs are formatting so often that only longer blocks are treated as candidate loops.",
      ),
    whitespaceRepeatMultiplier: z
      .number({ error: "loopGuard.whitespaceRepeatMultiplier must be a number" })
      .int("loopGuard.whitespaceRepeatMultiplier must be an integer")
      .min(2, "loopGuard.whitespaceRepeatMultiplier must be >= 2")
      .default(10)
      .describe(
        "Multiplier on the repeat thresholds for whitespace-only blocks. A run of spaces or newlines must repeat this many times longer than other output before the guard trips, so formatting (table padding, indentation) is never mistaken for a loop while a genuinely long whitespace runaway is still caught.",
      ),
    checkIntervalChars: z
      .number({ error: "loopGuard.checkIntervalChars must be a number" })
      .int("loopGuard.checkIntervalChars must be an integer")
      .positive("loopGuard.checkIntervalChars must be positive")
      .default(64)
      .describe(
        "New streamed code units between full period scans. Small periods are still checked on every chunk.",
      ),
    minLargeBlockLength: z
      .number({ error: "loopGuard.minLargeBlockLength must be a number" })
      .int("loopGuard.minLargeBlockLength must be an integer")
      .min(1, "loopGuard.minLargeBlockLength must be >= 1")
      .default(200)
      .describe(
        "Block length at or above which the large-block rule applies (fewer repeats needed to trip).",
      ),
    minLargeBlockRepeats: z
      .number({ error: "loopGuard.minLargeBlockRepeats must be a number" })
      .int("loopGuard.minLargeBlockRepeats must be an integer")
      .min(2, "loopGuard.minLargeBlockRepeats must be >= 2")
      .default(3)
      .describe(
        "Repeat count that trips the large-block rule for blocks of at least minLargeBlockLength.",
      ),
    includeThinking: z
      .boolean()
      .default(false)
      .describe(
        "Also scan reasoning (thinking) deltas for repetition, not just visible assistant text.",
      ),
  })
  .describe(
    "Runaway repetition guard for streamed assistant output; whitespace-only blocks use a higher repeat threshold so formatting does not trip it",
  );
