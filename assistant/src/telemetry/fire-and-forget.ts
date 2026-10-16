import { getLogger } from "../util/logger.js";

const log = getLogger("telemetry");

/**
 * Run a best-effort telemetry write without awaiting it.
 *
 * The telemetry recorders are async (they write to the telemetry database
 * through the async facade), but their call sites are frequently synchronous
 * contexts — timer callbacks, watchdog checks, the user's own call path — that
 * must neither block on telemetry nor let a storage failure escape. This
 * attaches the rejection handler those call sites previously expressed as a
 * `try { record() } catch {}` around a synchronous call: the failure is logged
 * once and never propagates.
 *
 * Use it wherever the recorder's result is unused. Call sites that consume the
 * result must `await` instead.
 *
 * Accepts a plain value too (not only a `Promise`) so a stubbed or legacy
 * recorder that returns synchronously still routes through the same sink
 * rather than throwing on `.catch`.
 */
export function fireAndForgetTelemetry(
  result: Promise<unknown> | unknown,
  label: string,
): void {
  void Promise.resolve(result).catch((err) => {
    log.warn({ err, label }, "Telemetry record failed (non-fatal)");
  });
}
