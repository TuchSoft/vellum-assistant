import {
  DEFAULT_STOP_MODE,
  isStopMode,
  STOP_MODES,
  type StopMode,
} from "../../util/stop-mode.js";
import { BadRequestError } from "./errors.js";

/**
 * Read the optional `mode` field shared by the Stop endpoints. Absent means
 * the client asked for the default stop, so older clients that send no body
 * keep their behavior.
 */
export function parseStopMode(
  body: Record<string, unknown> | undefined,
): StopMode {
  const raw = body?.mode;
  if (raw === undefined) {
    return DEFAULT_STOP_MODE;
  }
  if (!isStopMode(raw)) {
    throw new BadRequestError(`mode must be one of: ${STOP_MODES.join(", ")}`);
  }
  return raw;
}
