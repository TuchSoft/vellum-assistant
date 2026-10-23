import type { SecureKeyBackend } from "@vellumai/credential-storage";

import type { CredentialRecord } from "@vellumai/service-contracts/credential-rpc";
import { getLogger } from "../logger.js";
import { getCesDataRoot } from "../paths.js";
import {
  CesMetadataStore,
  getMetadataPath,
} from "../records/metadata-store.js";
import type { CesMigration } from "./types.js";

const log = getLogger("ces-migrations");

type LegacyCredentialRecord = CredentialRecord & {
  allowedTools?: unknown;
  allowedDomains?: unknown;
};

/**
 * Remove the retired credential policy fields from persisted records.
 *
 * `allowedTools` and `allowedDomains` are no longer part of the credential
 * record contract. Stripping them keeps `metadata.json` aligned with the
 * schema and stops the fields from being echoed back by list/read endpoints.
 * Re-running is a no-op once the fields are gone.
 */
export const stripCredentialPolicyFieldsMigration: CesMigration = {
  id: "005-strip-credential-policy-fields",
  description:
    "Remove allowedTools and allowedDomains from credential records",

  async run(_backend: SecureKeyBackend): Promise<void> {
    const store = new CesMetadataStore(getMetadataPath(getCesDataRoot()));
    let updated = 0;
    for (const { account, record } of store.list()) {
      const legacy = record as LegacyCredentialRecord;
      if (
        !Object.hasOwn(legacy, "allowedTools") &&
        !Object.hasOwn(legacy, "allowedDomains")
      ) {
        continue;
      }
      const cleaned: LegacyCredentialRecord = { ...legacy };
      delete cleaned.allowedTools;
      delete cleaned.allowedDomains;
      if (store.setByAccount(account, cleaned)) {
        updated += 1;
      }
    }
    log.info({ updated }, "credential policy fields stripped");
  },

  async down(_backend: SecureKeyBackend): Promise<void> {
    // Forward-only: the fields no longer exist in the record schema.
  },
};
