/**
 * Typed errors for the Psono read path.
 *
 * Messages never contain secret values: they are built from fixed strings and
 * HTTP status codes only.
 */

export type PsonoErrorKind =
  | "not_found"
  | "denied"
  | "unavailable"
  | "unauthorized";

export class PsonoError extends Error {
  constructor(
    readonly kind: PsonoErrorKind,
    message: string,
  ) {
    super(message);
    this.name = "PsonoError";
  }
}

export function unavailable(message: string): PsonoError {
  return new PsonoError("unavailable", message);
}

export function denied(message = "Psono denied access"): PsonoError {
  return new PsonoError("denied", message);
}

export function notFound(message = "Reference not found"): PsonoError {
  return new PsonoError("not_found", message);
}

export function unauthorized(message = "Psono session rejected"): PsonoError {
  return new PsonoError("unauthorized", message);
}

/** Normalize an unknown thrown value into a typed Psono error. */
export function asPsonoError(err: unknown): PsonoError {
  if (err instanceof PsonoError) {
    return err;
  }
  if (err instanceof Error && err.name === "AbortError") {
    return unavailable("Psono request timed out");
  }
  return unavailable("Psono request failed");
}
