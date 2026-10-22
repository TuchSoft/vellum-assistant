/**
 * Logical references for migrated credentials.
 *
 * Migrated `service/field` credentials live in the dedicated `stack` folder of
 * the writable shared folder, one entry per value:
 *
 *   Joanna-shared/stack/<slug>
 *
 * The slug is derived from `service/field` so the mapping is deterministic and
 * a re-run addresses the same entry instead of creating a second one.
 */

/** Root segment of the writable shared folder. */
export const PSONO_SHARED_ROOT = "Joanna-shared";

/** Folder inside the shared root that holds the migrated stack credentials. */
export const PSONO_STACK_FOLDER = "stack";

const STACK_REF_PREFIX = `${PSONO_SHARED_ROOT}/${PSONO_STACK_FOLDER}`;

/** Derive the entry slug from a credential's service and field. */
export function refSlug(service: string, field: string): string {
  return `${service}/${field}`
    .toLowerCase()
    .replace(/[/_]+/g, "-")
    .replace(/-+/g, "-")
    .replace(/^-|-$/g, "");
}

/** Reference for an explicit slug inside the stack folder. */
export function stackRefForSlug(slug: string): string {
  return `${STACK_REF_PREFIX}/${slug}`;
}

/** Default Psono reference for a credential (`Joanna-shared/stack/<slug>`). */
export function defaultStackRef(service: string, field: string): string {
  return stackRefForSlug(refSlug(service, field));
}
