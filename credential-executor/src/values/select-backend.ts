/**
 * Selection of the RPC values backend.
 *
 * `CES_VALUES_BACKEND=keys` (default) keeps the encrypted key store.
 * `CES_VALUES_BACKEND=psono` serves `get` / `set` / `delete` / `list` from
 * Psono through the record map. Any other value is a configuration error and
 * fails loudly at startup.
 */

import type { SecureKeyBackend } from "@vellumai/credential-storage";

import type { CesMetadataStore } from "../records/metadata-store.js";
import {
  PsonoValuesBackend,
  type PsonoValuesSource,
} from "./psono-values-backend.js";

export type ValuesBackendName = "keys" | "psono";

export function parseValuesBackend(
  configured: string | undefined,
): ValuesBackendName {
  const value = (configured ?? "").trim().toLowerCase();
  if (value === "" || value === "keys") {
    return "keys";
  }
  if (value === "psono") {
    return "psono";
  }
  throw new Error(
    `Unsupported CES_VALUES_BACKEND value "${configured}" (expected "keys" or "psono")`,
  );
}

export interface ResolveValuesBackendOptions {
  configured: string | undefined;
  keys: SecureKeyBackend;
  psono: PsonoValuesSource | undefined;
  records: CesMetadataStore;
}

export interface SelectedValuesBackend {
  name: ValuesBackendName;
  backend: SecureKeyBackend;
}

export function resolveValuesBackend(
  options: ResolveValuesBackendOptions,
): SelectedValuesBackend {
  const name = parseValuesBackend(options.configured);
  if (name === "keys") {
    return { name, backend: options.keys };
  }
  if (!options.psono) {
    throw new Error(
      "CES_VALUES_BACKEND=psono requires Psono material (PSONO_MATERIAL_FILE)",
    );
  }
  return {
    name,
    backend: new PsonoValuesBackend({
      psono: options.psono,
      records: options.records,
    }),
  };
}
