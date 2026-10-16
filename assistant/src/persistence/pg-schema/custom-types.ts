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
