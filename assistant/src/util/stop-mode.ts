/**
 * How a Stop request tears down in-flight work.
 *
 * - `hard`: abort the main turn, its child subagents, and ACP sessions, then
 *   force-clear the conversation's processing state without waiting for the
 *   turn's `finally`. Queued messages stay parked.
 * - `graceful`: cooperative user cancel. Child subagents and ACP sessions are
 *   aborted too, but the processing flag is cleared by the turn's `finally`
 *   and the queue drains normally.
 * - `main-only`: abort only the main turn's controller. Child subagents, ACP
 *   sessions, and the queue are left alone.
 */
export const STOP_MODES = ["hard", "graceful", "main-only"] as const;

export type StopMode = (typeof STOP_MODES)[number];

/** The stop mode used when a caller does not name one. */
export const DEFAULT_STOP_MODE: StopMode = "hard";

export function isStopMode(value: unknown): value is StopMode {
  return (
    typeof value === "string" &&
    (STOP_MODES as readonly string[]).includes(value)
  );
}
