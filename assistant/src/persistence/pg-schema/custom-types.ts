import { customType } from "drizzle-orm/pg-core";

/**
 * `bytea` column type.
 *
 * Drizzle 0.45.2's `pg-core` has no built-in `bytea` column, so the Postgres
 * mirror of the SQLite `blob` columns defines one. The SQLite side stores and
 * reads `Uint8Array`/`Buffer`; the Postgres driver (`postgres.js`) returns a
 * `Buffer`, so `driverData` and `data` are both `Buffer`.
 */
export const bytea = customType<{ data: Buffer; driverData: Buffer }>({
  dataType() {
    return "bytea";
  },
});

/**
 * A `pgvector` column of a fixed dimension.
 *
 * The dimension is part of the Postgres type, so a `vector(1024)` column only
 * accepts 1024-element values. Values are passed as the pgvector text literal
 * (`"[0.1,0.2,...]"`) in both directions: the driver has no native vector
 * codec, and the text form round-trips exactly what `vector_out` produces.
 */
export function vector(dimensions: number) {
  if (!Number.isInteger(dimensions) || dimensions <= 0) {
    throw new Error(
      `vector dimensions must be a positive integer: ${dimensions}`,
    );
  }
  return customType<{ data: string; driverData: string }>({
    dataType() {
      return `vector(${dimensions})`;
    },
  })();
}
