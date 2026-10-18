/**
 * How the user wants a Stop to tear down in-flight work.
 *
 * Mirrors the daemon's `POST /v1/conversations/:id/cancel` and
 * `POST /v1/lifecycle/stop-all` `mode` field.
 */
export type StopMode = "hard" | "graceful" | "main-only";
