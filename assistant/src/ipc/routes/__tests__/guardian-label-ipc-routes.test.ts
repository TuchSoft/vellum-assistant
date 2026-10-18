/**
 * The gateway-facing guardian-label method is IPC-only: registered on the
 * assistant IPC server by operationId and absent from the shared HTTP route
 * set. The persona content is driven through a persona-resolver mock so the
 * tests exercise the real `resolveGuardianName` priority chain without disk.
 */

import { beforeEach, describe, expect, mock, test } from "bun:test";

// Mutable persona content — the value `resolveGuardianPersonaStrict()`
// returns (comment-stripped string, or null when no guardian / missing file).
let mockGuardianPersona: string | null = null;

// Snapshot-spread the real module so untouched exports (used elsewhere in the
// import chain) stay intact.
const actualPersonaResolver =
  await import("../../../prompts/persona-resolver.js");
mock.module("../../../prompts/persona-resolver.js", () => ({
  ...actualPersonaResolver,
  resolveGuardianPersonaStrict: () => mockGuardianPersona,
}));

const { GUARDIAN_LABEL_IPC_METHODS, handleResolveGuardianLabel } =
  await import("../guardian-label-ipc-routes.js");
const { ROUTES: contactRoutes } =
  await import("../../../runtime/routes/contact-routes.js");

describe("resolve_guardian_label", () => {
  beforeEach(() => {
    mockGuardianPersona = null;
  });

  test("is reachable on the IPC surface by operationId", () => {
    expect(typeof GUARDIAN_LABEL_IPC_METHODS.resolve_guardian_label).toBe(
      "function",
    );
  });

  test("is NOT in the shared contact ROUTES array", () => {
    const sharedIds = new Set(contactRoutes.map((r) => r.operationId));
    expect(sharedIds.has("resolve_guardian_label")).toBe(false);
  });

  test("returns the persona preferred name when present", async () => {
    mockGuardianPersona = "- Preferred name/reference: John\n";
    const { label } = handleResolveGuardianLabel({
      body: { storedDisplayName: "Stored" },
    });
    expect(await label).toEqual("John");
  });

  test("falls back to the stored displayName when no preferred name is set", async () => {
    mockGuardianPersona = "- Preferred name/reference:\n";
    const { label } = handleResolveGuardianLabel({
      body: { storedDisplayName: "Stored" },
    });
    expect(await label).toEqual("Stored");
  });

  test("falls back to the default reference when neither is set", async () => {
    const { label } = handleResolveGuardianLabel({ body: {} });
    expect(await label).toEqual("my human");
    const { label: storedLabel } = handleResolveGuardianLabel({
      body: { storedDisplayName: null },
    });
    expect(await storedLabel).toEqual("my human");
  });

  test("rejects a non-string storedDisplayName", () => {
    expect(() =>
      handleResolveGuardianLabel({ body: { storedDisplayName: 42 } }),
    ).toThrow();
  });
});
