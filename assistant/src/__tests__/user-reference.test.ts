/**
 * Tests for user-reference resolvers. After the drop-user-md migration,
 * `readPreferredNameFromUserMd` and `resolveUserPronouns` source their
 * content from the guardian's per-user persona file via
 * `resolveGuardianPersonaStrict()` (no `default.md` fallback). We mock
 * the persona-resolver module directly so tests can drive the input
 * content without touching disk.
 */

import { beforeEach, describe, expect, mock, test } from "bun:test";

// Mutable state the tests control — represents the value returned by
// `resolveGuardianPersonaStrict()` (comment-stripped string, or null
// when no guardian / empty / missing guardian-specific file).
let mockGuardianPersona: string | null = null;

mock.module("../prompts/persona-resolver.js", () => ({
  resolveGuardianPersona: () => mockGuardianPersona,
  resolveGuardianPersonaStrict: () => mockGuardianPersona,
}));

// Import after mocks are in place so the module under test binds to
// the stubbed implementation.
const {
  resolveUserReference,
  resolveUserPronouns,
  resolveGuardianName,
  DEFAULT_USER_REFERENCE,
} = await import("../prompts/user-reference.js");

describe("resolveUserReference", () => {
  beforeEach(() => {
    mockGuardianPersona = null;
  });

  test('returns "my human" when no guardian persona exists', async () => {
    mockGuardianPersona = null;
    expect(await resolveUserReference()).toBe("my human");
  });

  test('returns "my human" when preferred name field is empty', async () => {
    mockGuardianPersona = [
      "## Onboarding Snapshot",
      "",
      "- Preferred name/reference:",
      "- Goals:",
      "- Locale:",
    ].join("\n");
    expect(await resolveUserReference()).toBe("my human");
  });

  test("returns the configured name when it is set", async () => {
    mockGuardianPersona = [
      "## Onboarding Snapshot",
      "",
      "- Preferred name/reference: John",
      "- Goals: ship fast",
      "- Locale: en-US",
    ].join("\n");
    expect(await resolveUserReference()).toBe("John");
  });

  test("trims whitespace around the configured name", async () => {
    mockGuardianPersona = "- Preferred name/reference:   Alice   \n";
    expect(await resolveUserReference()).toBe("Alice");
  });
});

describe("resolveUserPronouns", () => {
  beforeEach(() => {
    mockGuardianPersona = null;
  });

  test("returns null when no guardian persona exists", async () => {
    mockGuardianPersona = null;
    expect(await resolveUserPronouns()).toBeNull();
  });

  test("returns pronouns from flat persona file (no Onboarding Snapshot)", async () => {
    mockGuardianPersona = [
      "# User Profile",
      "",
      "- Preferred name/reference: Alice",
      "- Pronouns: she/her",
      "- Locale: en-US",
    ].join("\n");
    expect(await resolveUserPronouns()).toBe("she/her");
  });

  test("returns null when pronouns field is empty in flat format", async () => {
    mockGuardianPersona = [
      "# User Profile",
      "",
      "- Preferred name/reference: Alice",
      "- Pronouns:",
      "- Locale: en-US",
    ].join("\n");
    expect(await resolveUserPronouns()).toBeNull();
  });

  test("returns pronouns from legacy Onboarding Snapshot section", async () => {
    mockGuardianPersona = [
      "## Onboarding Snapshot",
      "",
      "- Pronouns: they/them",
    ].join("\n");
    expect(await resolveUserPronouns()).toBe("they/them");
  });

  test("prefers pronouns above Onboarding Snapshot over inside it", async () => {
    mockGuardianPersona = [
      "Pronouns: he/him",
      "",
      "## Onboarding Snapshot",
      "",
      "- Pronouns: she/her",
    ].join("\n");
    expect(await resolveUserPronouns()).toBe("he/him");
  });

  test("returns null for declined_by_user", async () => {
    mockGuardianPersona = [
      "- Preferred name/reference: Alice",
      "- Pronouns: declined_by_user",
    ].join("\n");
    expect(await resolveUserPronouns()).toBeNull();
  });

  test("strips inferred: prefix", async () => {
    mockGuardianPersona = [
      "- Preferred name/reference: Alice",
      "- Pronouns: inferred: she/her",
    ].join("\n");
    expect(await resolveUserPronouns()).toBe("she/her");
  });
});

describe("resolveGuardianName", () => {
  beforeEach(() => {
    mockGuardianPersona = null;
  });

  test("returns persona name when present, ignoring guardianDisplayName", async () => {
    mockGuardianPersona = [
      "## Onboarding Snapshot",
      "",
      "- Preferred name/reference: John",
    ].join("\n");
    expect(await resolveGuardianName("Jane")).toBe("John");
  });

  test('returns "my human" when persona explicitly sets name to default value', async () => {
    mockGuardianPersona = [
      "## Onboarding Snapshot",
      "",
      "- Preferred name/reference: my human",
    ].join("\n");
    // The user's explicit choice must be respected even though it matches the default sentinel
    expect(await resolveGuardianName("Jane")).toBe("my human");
  });

  test("falls back to guardianDisplayName when persona is empty", async () => {
    mockGuardianPersona = null;
    expect(await resolveGuardianName("Jane")).toBe("Jane");
  });

  test("falls back to DEFAULT_USER_REFERENCE when both are empty", async () => {
    mockGuardianPersona = null;
    expect(await resolveGuardianName()).toBe(DEFAULT_USER_REFERENCE);
    expect(await resolveGuardianName(null)).toBe(DEFAULT_USER_REFERENCE);
    expect(await resolveGuardianName("")).toBe(DEFAULT_USER_REFERENCE);
  });

  test("trims whitespace on guardianDisplayName fallback", async () => {
    mockGuardianPersona = null;
    expect(await resolveGuardianName("  Jane  ")).toBe("Jane");
  });
});
