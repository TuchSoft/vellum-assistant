import type { SecureKeyBackend } from "@vellumai/credential-storage";

import { getLogger } from "../logger.js";
import { getCesDataRoot } from "../paths.js";
import {
  CesMetadataStore,
  getMetadataPath,
} from "../records/metadata-store.js";
import type { CesMigration } from "./types.js";

const log = getLogger("ces-migrations");

/**
 * Add the `kind` field to existing credential records.
 *
 * `ref` and `kind` are additive and optional. Records without a `ref` keep
 * answering `not_found` on the Psono-backed endpoints until a ref is mapped;
 * `kind` defaults to `value`. Re-running is a no-op.
 */
export const recordRefKindMigration: CesMigration = {
  id: "004-credential-record-ref-kind",
  description:
    "Add the optional kind field to credential records for Psono-backed reads",

  async run(_backend: SecureKeyBackend): Promise<void> {
    const store = new CesMetadataStore(getMetadataPath(getCesDataRoot()));
    let updated = 0;
    for (const { account, record } of store.list()) {
      if (record.kind !== undefined) {
        continue;
      }
      if (store.setByAccount(account, { ...record, kind: "value" })) {
        updated += 1;
      }
    }
    log.info({ updated }, "credential record kind backfill complete");
  },

  async down(_backend: SecureKeyBackend): Promise<void> {
    // Forward-only: removing a defaulted kind would change read behavior.
  },
};
